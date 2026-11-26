import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import {
  loadSepayQrConfig,
  SEPAY_QR_DEFAULT_ACCOUNT,
  SEPAY_QR_DEFAULT_ACCOUNT_NAME,
  SEPAY_QR_DEFAULT_BANK,
  SEPAY_QR_DEFAULT_BASE_URL,
  type SepayQrConfig,
} from '../src/config/sepay-qr.config.js';
import { SepayQrClient, SepayQrError } from '../src/payments/sepay/sepay-qr.client.js';

function makeSepayConfig(baseUrl: string, overrides: Partial<SepayQrConfig> = {}): SepayQrConfig {
  return {
    baseUrl,
    bank: SEPAY_QR_DEFAULT_BANK,
    account: SEPAY_QR_DEFAULT_ACCOUNT,
    accountName: SEPAY_QR_DEFAULT_ACCOUNT_NAME,
    template: 'compact',
    orderExpiresMinutes: 10,
    ...overrides,
  };
}

describe('SepayQrConfig Validation', () => {
  it('loads default Vietcombank / 9869983819 / DO QUANG HUNG / 10m settings', () => {
    const cfg = loadSepayQrConfig({});
    assert.equal(cfg.baseUrl, SEPAY_QR_DEFAULT_BASE_URL);
    assert.equal(cfg.bank, 'Vietcombank');
    assert.equal(cfg.account, '9869983819');
    assert.equal(cfg.accountName, 'DO QUANG HUNG');
    assert.equal(cfg.template, 'compact');
    assert.equal(cfg.orderExpiresMinutes, 10);
  });

  it('rejects invalid template, non-HTTPS URL, and invalid expiry minutes', () => {
    assert.throws(() => loadSepayQrConfig({ SEPAY_QR_TEMPLATE: 'fancy' }), /SEPAY_QR_TEMPLATE/);
    assert.throws(() => loadSepayQrConfig({ SEPAY_QR_BASE_URL: 'http://qr.sepay.vn/img' }), /HTTPS/);
    assert.throws(() => loadSepayQrConfig({ ORDER_EXPIRES_MINUTES: '0' }), /between 1 and 1440/);
  });
});

describe('SepayQrClient', () => {
  let mockServer: Server;
  let mockBaseUrl = '';
  let lastRequestUrl = '';
  let responseMode: 'png' | 'text' | 'error' = 'png';

  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

  before(async () => {
    mockServer = createServer((req, res) => {
      lastRequestUrl = req.url ?? '';
      if (responseMode === 'error') {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Upstream bad gateway');
        return;
      }
      if (responseMode === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>not an image</html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    assert.ok(addr && typeof addr === 'object');
    mockBaseUrl = `http://127.0.0.1:${addr.port}/img`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      mockServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('builds qr.sepay.vn URL with order code and compact template', () => {
    const client = new SepayQrClient(makeSepayConfig('https://qr.sepay.vn/img'));
    const content = client.buildTransferContent(' GSABCD123456 ');
    assert.equal(content, 'GSABCD123456');

    const url = client.buildQrImageUrl(150_000n, content);
    assert.equal(
      url,
      'https://qr.sepay.vn/img?acc=9869983819&bank=Vietcombank&amount=150000&des=GSABCD123456&template=compact',
    );

    const defaultTemplateClient = new SepayQrClient(
      makeSepayConfig('https://qr.sepay.vn/img', { template: 'default' }),
    );
    assert.equal(
      defaultTemplateClient.buildQrImageUrl(150_000n, content),
      'https://qr.sepay.vn/img?acc=9869983819&bank=Vietcombank&amount=150000&des=GSABCD123456',
    );
  });

  it('fetches PNG QR image and validates upstream HTTP status and content-type', async () => {
    responseMode = 'png';
    const client = new SepayQrClient(makeSepayConfig(mockBaseUrl));

    const result = await client.generateCustomerQr({
      orderCode: 'GSABCD123456',
      amount: 80_000n,
    });

    assert.equal(result.bankCode, 'Vietcombank');
    assert.equal(result.bankAccount, '9869983819');
    assert.equal(result.userBankName, 'DO QUANG HUNG');
    assert.equal(result.content, 'GSABCD123456');
    assert.equal(
      lastRequestUrl,
      '/img?acc=9869983819&bank=Vietcombank&amount=80000&des=GSABCD123456&template=compact',
    );
    assert.deepEqual(result.qrImagePng, PNG_BYTES);

    responseMode = 'error';
    await assert.rejects(
      () =>
        client.generateCustomerQr({
          orderCode: 'GSABCD123456',
          amount: 80_000n,
        }),
      (err: unknown) => err instanceof SepayQrError && err.code === 'SEPAY_QR_FETCH_FAILED',
    );

    responseMode = 'text';
    await assert.rejects(
      () =>
        client.generateCustomerQr({
          orderCode: 'GSABCD123456',
          amount: 80_000n,
        }),
      (err: unknown) => err instanceof SepayQrError && err.code === 'SEPAY_QR_INVALID_RESPONSE',
    );
  });
});
