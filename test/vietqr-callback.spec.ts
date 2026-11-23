import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { Module, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { type VietqrConfig, vietqrConfig } from '../src/config/vietqr.config.js';
import { PaymentStatus } from '../src/generated/prisma/client.js';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service.js';
import { VietqrBasicAuthGuard } from '../src/payments/vietqr/vietqr-basic-auth.guard.js';
import { VietqrBearerAuthGuard } from '../src/payments/vietqr/vietqr-bearer-auth.guard.js';
import { VietqrTokenService } from '../src/payments/vietqr/vietqr-token.service.js';
import {
  parseStrictPositiveBigInt,
  parseTransactionTimeMs,
  parseVietqrTransactionSyncPayload,
  VietqrWebhookService,
} from '../src/payments/vietqr/vietqr-webhook.service.js';
import { VietqrController } from '../src/payments/vietqr/vietqr.controller.js';

const TEST_SECRET = 'test-vietqr-callback-secret-key-at-least-32-chars-long';
const TEST_USERNAME = 'vietqr-callback-client';
const TEST_PASSWORD = 'vietqr-callback-password';

function makeConfig(overrides: Partial<VietqrConfig> = {}): VietqrConfig {
  return {
    enabled: true,
    env: 'uat',
    merchantName: 'Test Shop',
    clientUsername: TEST_USERNAME,
    clientPassword: TEST_PASSWORD,
    tokenSecret: TEST_SECRET,
    tokenExpiresIn: 300,
    baseUrl: 'https://dev.vietqr.org',
    systemUsername: '',
    systemPassword: '',
    qrType: 0,
    bankCode: 'MB',
    bankAccount: '0123456789',
    accountName: 'TEST SHOP',
    terminalCode: '',
    ...overrides,
  };
}

describe('VietQR Transaction Sync Payload Parser', () => {
  it('parses valid official payload strictly with BigInt amount and ms timestamp', () => {
    const parsed = parseVietqrTransactionSyncPayload({
      bankaccount: '0123456789',
      amount: 150000,
      transType: 'C',
      content: 'GS1234567890',
      transactionid: 'tx-uuid-1',
      transactiontime: 1757342061000,
      referencenumber: 'FT26008507756020',
      orderId: 'GS1234567890',
    });

    assert.equal(parsed.amount, 150000n);
    assert.equal(parsed.transType, 'C');
    assert.equal(parsed.transactionAt.getTime(), 1757342061000);
    assert.equal(parsed.bankAccount, '0123456789');
  });

  it('rejects floating-point, zero, or negative amounts', () => {
    assert.throws(() => parseStrictPositiveBigInt(100.5, 'amount'));
    assert.throws(() => parseStrictPositiveBigInt('100.50', 'amount'));
    assert.throws(() => parseStrictPositiveBigInt(0, 'amount'));
    assert.throws(() => parseStrictPositiveBigInt(-5000, 'amount'));
    assert.throws(() => parseStrictPositiveBigInt('abc', 'amount'));
    assert.equal(parseStrictPositiveBigInt('9007199254740995', 'amount'), 9007199254740995n);
  });

  it('rejects non-millisecond or invalid timestamps', () => {
    assert.throws(() => parseTransactionTimeMs(1757342061)); // seconds instead of ms
    assert.throws(() => parseTransactionTimeMs('not-a-timestamp'));
  });
});

describe('POST /vqr/bank/api/transaction-sync (HTTP Integration)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let shouldThrowDbError = false;
  let lastReconcileInput: unknown = null;

  const mockReconciliation = {
    async reconcile(input: unknown) {
      lastReconcileInput = input;
      if (shouldThrowDbError) {
        throw new Error('Simulated DB connection failure');
      }
      return {
        outcome: 'VERIFIED' as const,
        paymentId: 'pay-ref-12345',
        paymentStatus: PaymentStatus.VERIFIED,
        orderId: 'ord-1',
        orderCode: 'GS1234567890',
        reason: null,
      };
    },
  };

  @Module({
    imports: [ConfigModule.forRoot({ isGlobal: true })],
    controllers: [VietqrController],
    providers: [
      { provide: vietqrConfig.KEY, useValue: makeConfig() },
      { provide: PaymentReconciliationService, useValue: mockReconciliation },
      VietqrTokenService,
      VietqrBasicAuthGuard,
      VietqrBearerAuthGuard,
      VietqrWebhookService,
    ],
  })
  class TestCallbackModule {}

  before(async () => {
    app = await NestFactory.create(TestCallbackModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app.close();
  });

  async function obtainToken(): Promise<string> {
    const basic = Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`, 'utf8').toString('base64');
    const res = await fetch(`${baseUrl}/vqr/api/token_generate`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { access_token: string };
    return body.access_token;
  }

  const validPayload = {
    bankaccount: '0123456789',
    amount: 100000,
    transType: 'C',
    content: 'GS1234567890',
    transactionid: 'tx-valid-001',
    transactiontime: 1757342061000,
    referencenumber: 'FT26008507756020',
    orderId: 'GS1234567890',
  };

  it('rejects missing or invalid Bearer token with official 401 contract', async () => {
    const noAuth = await fetch(`${baseUrl}/vqr/bank/api/transaction-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload),
    });
    assert.equal(noAuth.status, 401);
    const noAuthBody = (await noAuth.json()) as { error: boolean; errorReason: string; object: unknown };
    assert.equal(noAuthBody.error, true);
    assert.equal(noAuthBody.errorReason, 'INVALID_AUTH_HEADER');
    assert.equal(noAuthBody.object, null);

    const badToken = await fetch(`${baseUrl}/vqr/bank/api/transaction-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid.jwt.token',
      },
      body: JSON.stringify(validPayload),
    });
    assert.equal(badToken.status, 401);
    const badTokenBody = (await badToken.json()) as { error: boolean; errorReason: string };
    assert.equal(badTokenBody.error, true);
    assert.equal(badTokenBody.errorReason, 'INVALID_TOKEN');
  });

  it('returns 400 INVALID_PAYLOAD when required fields are missing or amount is floating point', async () => {
    const token = await obtainToken();
    const res = await fetch(`${baseUrl}/vqr/bank/api/transaction-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...validPayload, amount: 999.99 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: boolean; errorReason: string; object: unknown };
    assert.equal(body.error, true);
    assert.equal(body.errorReason, 'INVALID_PAYLOAD');
    assert.equal(body.object, null);
  });

  it('returns official 200 OK response with reftransactionid for valid callback', async () => {
    shouldThrowDbError = false;
    lastReconcileInput = null;
    const token = await obtainToken();

    const res = await fetch(`${baseUrl}/vqr/bank/api/transaction-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(validPayload),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      error: boolean;
      errorReason: string | null;
      toastMessage: string;
      object: { reftransactionid: string } | null;
    };
    assert.equal(body.error, false);
    assert.equal(body.errorReason, null);
    assert.equal(body.object?.reftransactionid, 'pay-ref-12345');
    assert.ok(lastReconcileInput);
  });

  it('returns 500 TRANSACTION_FAILED on DB/system error so VietQR retries', async () => {
    shouldThrowDbError = true;
    try {
      const token = await obtainToken();
      const res = await fetch(`${baseUrl}/vqr/bank/api/transaction-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(validPayload),
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: boolean; errorReason: string; object: unknown };
      assert.equal(body.error, true);
      assert.equal(body.errorReason, 'TRANSACTION_FAILED');
      assert.equal(body.object, null);
    } finally {
      shouldThrowDbError = false;
    }
  });
});
