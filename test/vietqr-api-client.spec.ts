import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { VietqrConfig } from '../src/config/vietqr.config.js';
import { VietqrApiClient, VietqrApiError } from '../src/payments/vietqr/vietqr-api.client.js';

function makeOutboundConfig(baseUrl: string, overrides: Partial<VietqrConfig> = {}): VietqrConfig {
  return {
    enabled: true,
    env: 'uat',
    merchantName: 'Test Merchant',
    clientUsername: 'inbound-user',
    clientPassword: 'inbound-password',
    tokenSecret: 'test-token-secret-must-be-at-least-32-characters-long',
    tokenExpiresIn: 300,
    baseUrl,
    systemUsername: 'sys-user',
    systemPassword: 'sys-password',
    qrType: 0,
    bankCode: 'MB',
    bankAccount: '0123456789',
    accountName: 'NGUYEN VAN A',
    terminalCode: '',
    ...overrides,
  };
}

describe('VietqrApiClient (Outbound Token & QR Generation)', () => {
  let mockServer: Server;
  let mockBaseUrl = '';
  let tokenCallCount = 0;
  let qrCallCount = 0;
  let forceFirstQrUnauthorized = false;

  before(async () => {
    mockServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && req.url === '/vqr/api/token_generate') {
        tokenCallCount += 1;
        const expectedBasic = `Basic ${Buffer.from('sys-user:sys-password', 'utf8').toString('base64')}`;
        if (req.headers.authorization !== expectedBasic) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'FAILED', message: 'INVALID_CREDENTIALS' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `sys-token-${tokenCallCount}`,
            token_type: 'Bearer',
            expires_in: 300,
          }),
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/vqr/api/qr/generate-customer') {
        qrCallCount += 1;
        if (forceFirstQrUnauthorized && qrCallCount === 1) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'FAILED', message: 'E74' }));
          return;
        }
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            bankCode: parsed.bankCode,
            bankName: 'Ngân hàng TMCP Quân đội',
            bankAccount: parsed.bankAccount,
            userBankName: parsed.userBankName,
            amount: String(parsed.amount),
            content: parsed.content,
            orderId: parsed.orderId,
            qrCode: '00020101021238570010A000000727012700069704220113VQRQACYEK56060208QRIBFTTA53037045405500005802VN6304ABCD',
            qrLink: 'https://dev.vietqr.org/qr-generated?token=test',
            transactionRefId: 'ref-tx-001',
            vaAccount: 'VQRQACYEK5606',
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    assert.ok(addr && typeof addr === 'object');
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      mockServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('fails fast without mocking when outbound credentials are missing', async () => {
    const client = new VietqrApiClient(
      makeOutboundConfig(mockBaseUrl, { systemUsername: '', systemPassword: '' }),
    );
    assert.equal(client.isConfigured(), false);
    await assert.rejects(
      () => client.generateCustomerQr({ orderCode: 'GS1234567890', amount: 50_000n, content: 'GS1234567890' }),
      (err: unknown) => err instanceof VietqrApiError && err.code === 'VIETQR_NOT_CONFIGURED',
    );
  });

  it('enforces VietQR orderId (<=13 ASCII) and content (<=23 ASCII) rules', async () => {
    const client = new VietqrApiClient(makeOutboundConfig(mockBaseUrl));

    await assert.rejects(
      () => client.generateCustomerQr({ orderCode: 'GS12345678901234', amount: 50_000n, content: 'OK' }),
      (err: unknown) => err instanceof VietqrApiError && err.code === 'INVALID_ORDER_ID',
    );
    await assert.rejects(
      () => client.generateCustomerQr({ orderCode: 'GS1234567890', amount: 50_000n, content: 'Tiếng Việt có dấu' }),
      (err: unknown) => err instanceof VietqrApiError && err.code === 'INVALID_CONTENT',
    );
  });

  it('caches system token, retries once on 401, and renders a valid PNG QR image', async () => {
    tokenCallCount = 0;
    qrCallCount = 0;
    forceFirstQrUnauthorized = true;

    const client = new VietqrApiClient(makeOutboundConfig(mockBaseUrl));
    const qr1 = await client.generateCustomerQr({
      orderCode: 'GS1234567890',
      amount: 50_000n,
      content: 'GS1234567890',
    });

    // First QR got 401 -> refreshed token -> second QR succeeded
    assert.equal(tokenCallCount, 2);
    assert.equal(qrCallCount, 2);
    assert.equal(qr1.vaAccount, 'VQRQACYEK5606');
    assert.equal(qr1.transactionRefId, 'ref-tx-001');
    // Verify PNG magic signature: 89 50 4E 47 0D 0A 1A 0A
    assert.deepEqual(
      [...qr1.qrImagePng.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );

    // Next call must reuse cached token (tokenCallCount remains 2)
    forceFirstQrUnauthorized = false;
    await client.generateCustomerQr({
      orderCode: 'GS1234567891',
      amount: 75_000n,
      content: 'GS1234567891',
    });
    assert.equal(tokenCallCount, 2);
  });
});
