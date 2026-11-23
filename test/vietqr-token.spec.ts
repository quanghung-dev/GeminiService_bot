import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import {
  hasVietqrOutboundCredentials,
  loadVietqrConfig,
  type VietqrConfig,
  vietqrConfig,
} from '../src/config/vietqr.config.js';
import {
  VIETQR_JWT_AUDIENCE,
  VIETQR_JWT_ISSUER,
} from '../src/payments/vietqr/vietqr.constants.js';
import { VietqrBasicAuthGuard } from '../src/payments/vietqr/vietqr-basic-auth.guard.js';
import { VietqrBearerAuthGuard } from '../src/payments/vietqr/vietqr-bearer-auth.guard.js';
import { VietqrTokenService } from '../src/payments/vietqr/vietqr-token.service.js';
import { VietqrWebhookService } from '../src/payments/vietqr/vietqr-webhook.service.js';
import { VietqrController } from '../src/payments/vietqr/vietqr.controller.js';

const TEST_SECRET = 'test-vietqr-signing-secret-must-be-at-least-32-chars-long';
const TEST_USERNAME = 'vietqr-uat-client';
const TEST_PASSWORD = 'super:secret:password!123';

function makeEnabledConfig(overrides: Partial<VietqrConfig> = {}): VietqrConfig {
  return {
    enabled: true,
    env: 'uat',
    merchantName: 'Test Merchant',
    clientUsername: TEST_USERNAME,
    clientPassword: TEST_PASSWORD,
    tokenSecret: TEST_SECRET,
    tokenExpiresIn: 300,
    baseUrl: 'https://dev.vietqr.org',
    systemUsername: '',
    systemPassword: '',
    qrType: 0,
    bankCode: '',
    bankAccount: '',
    accountName: '',
    terminalCode: '',
    ...overrides,
  };
}

describe('VietQR Config Validation', () => {
  it('loads safely with defaults when VIETQR_ENABLED=false', () => {
    const cfg = loadVietqrConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.env, 'uat');
    assert.equal(cfg.tokenExpiresIn, 300);
    assert.equal(cfg.baseUrl, 'https://dev.vietqr.org');
    assert.equal(hasVietqrOutboundCredentials(cfg), false);
  });

  it('requires inbound credentials and >= 32-char token secret when enabled', () => {
    assert.throws(
      () => loadVietqrConfig({ VIETQR_ENABLED: 'true', VIETQR_ENV: 'uat' }),
      /VIETQR_CLIENT_USERNAME and VIETQR_CLIENT_PASSWORD/,
    );
    assert.throws(
      () =>
        loadVietqrConfig({
          VIETQR_ENABLED: 'true',
          VIETQR_ENV: 'uat',
          VIETQR_CLIENT_USERNAME: 'u',
          VIETQR_CLIENT_PASSWORD: 'p',
          VIETQR_TOKEN_SECRET: 'too-short',
        }),
      /at least 32 characters/,
    );
  });

  it('prevents UAT/Production base URL cross-wiring and non-HTTPS URLs', () => {
    const base = {
      VIETQR_ENABLED: 'true',
      VIETQR_CLIENT_USERNAME: 'u',
      VIETQR_CLIENT_PASSWORD: 'p',
      VIETQR_TOKEN_SECRET: TEST_SECRET,
    };

    assert.throws(
      () => loadVietqrConfig({ ...base, VIETQR_ENV: 'production', VIETQR_BASE_URL: 'https://dev.vietqr.org' }),
      /cannot point to UAT host/,
    );
    assert.throws(
      () => loadVietqrConfig({ ...base, VIETQR_ENV: 'uat', VIETQR_BASE_URL: 'https://api.vietqr.org' }),
      /cannot point to Production host/,
    );
    assert.throws(
      () => loadVietqrConfig({ ...base, VIETQR_ENV: 'uat', VIETQR_BASE_URL: 'http://dev.vietqr.org' }),
      /must use HTTPS/,
    );
  });

  it('detects outbound credentials completeness', () => {
    const partial = makeEnabledConfig({ systemUsername: 'sys', systemPassword: 'pwd' });
    assert.equal(hasVietqrOutboundCredentials(partial), false);

    const complete = makeEnabledConfig({
      systemUsername: 'sys',
      systemPassword: 'pwd',
      bankCode: 'MB',
      bankAccount: '0123456789',
      accountName: 'NGUYEN VAN A',
    });
    assert.equal(hasVietqrOutboundCredentials(complete), true);
  });
});

describe('VietqrTokenService', () => {
  it('issues HS512 JWT and verifies it with exact environment isolation', () => {
    const uatService = new VietqrTokenService(makeEnabledConfig({ env: 'uat' }));
    const prodService = new VietqrTokenService(
      makeEnabledConfig({ env: 'production', baseUrl: 'https://api.vietqr.org' }),
    );

    const issued = uatService.issueAccessToken(TEST_USERNAME);
    assert.equal(issued.token_type, 'Bearer');
    assert.equal(issued.expires_in, 300);
    assert.ok(issued.access_token.split('.').length === 3);

    const decodedHeader = JSON.parse(
      Buffer.from(issued.access_token.split('.')[0], 'base64url').toString('utf8'),
    ) as { alg: string };
    assert.equal(decodedHeader.alg, 'HS512');

    const verified = uatService.verifyAccessToken(issued.access_token);
    assert.ok(verified);
    assert.equal(verified.username, TEST_USERNAME);
    assert.equal(verified.env, 'uat');

    // UAT token must NEVER validate against a Production service even with identical secret
    assert.equal(prodService.verifyAccessToken(issued.access_token), null);
  });

  it('rejects expired, tampered, wrong-algorithm, and wrong-secret tokens', () => {
    const service = new VietqrTokenService(makeEnabledConfig());

    const expired = jwt.sign(
      { username: TEST_USERNAME, env: 'uat' },
      TEST_SECRET,
      {
        algorithm: 'HS512',
        expiresIn: -5,
        issuer: VIETQR_JWT_ISSUER,
        audience: VIETQR_JWT_AUDIENCE,
        subject: TEST_USERNAME,
        jwtid: 'expired-jti',
      },
    );
    assert.equal(service.verifyAccessToken(expired), null);

    const wrongAlg = jwt.sign(
      { username: TEST_USERNAME, env: 'uat' },
      TEST_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: 300,
        issuer: VIETQR_JWT_ISSUER,
        audience: VIETQR_JWT_AUDIENCE,
        subject: TEST_USERNAME,
        jwtid: 'hs256-jti',
      },
    );
    assert.equal(service.verifyAccessToken(wrongAlg), null);

    const wrongSecret = jwt.sign(
      { username: TEST_USERNAME, env: 'uat' },
      'another-secret-key-that-is-over-32-characters-long',
      {
        algorithm: 'HS512',
        expiresIn: 300,
        issuer: VIETQR_JWT_ISSUER,
        audience: VIETQR_JWT_AUDIENCE,
        subject: TEST_USERNAME,
        jwtid: 'wrong-secret-jti',
      },
    );
    assert.equal(service.verifyAccessToken(wrongSecret), null);

    const issued = service.issueAccessToken(TEST_USERNAME);
    const tampered = `${issued.access_token.slice(0, -4)}AAAA`;
    assert.equal(service.verifyAccessToken(tampered), null);
  });
});

describe('POST /vqr/api/token_generate (HTTP Integration)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokenService: VietqrTokenService;

  @Module({
    imports: [ConfigModule.forRoot({ isGlobal: true })],
    controllers: [VietqrController],
    providers: [
      { provide: vietqrConfig.KEY, useValue: makeEnabledConfig() },
      VietqrTokenService,
      VietqrBasicAuthGuard,
      VietqrBearerAuthGuard,
      { provide: VietqrWebhookService, useValue: { handleTransactionSync: async () => ({ error: false, errorReason: null, toastMessage: 'ok', object: { reftransactionid: 'stub' } }) } },
    ],
  })
  class TestVietqrModule {}

  before(async () => {
    app = await NestFactory.create(TestVietqrModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
    tokenService = app.get(VietqrTokenService);
  });

  after(async () => {
    await app.close();
  });

  it('returns 200 OK and a verifiable Bearer token for valid Basic credentials', async () => {
    const basic = Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`, 'utf8').toString('base64');
    const response = await fetch(`${baseUrl}/vqr/api/token_generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basic}`,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 300);
    assert.ok(tokenService.verifyAccessToken(body.access_token));
  });

  it('returns 400 FAILED when Authorization header is missing or malformed', async () => {
    const missingRes = await fetch(`${baseUrl}/vqr/api/token_generate`, { method: 'POST' });
    assert.equal(missingRes.status, 400);
    const missingBody = (await missingRes.json()) as { status: string; message: string };
    assert.equal(missingBody.status, 'FAILED');

    const badScheme = await fetch(`${baseUrl}/vqr/api/token_generate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer some-token' },
    });
    assert.equal(badScheme.status, 400);
    assert.equal(((await badScheme.json()) as { status: string }).status, 'FAILED');

    const noColon = await fetch(`${baseUrl}/vqr/api/token_generate`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from('usernameonly').toString('base64')}` },
    });
    assert.equal(noColon.status, 400);
    assert.equal(((await noColon.json()) as { status: string }).status, 'FAILED');
  });

  it('returns 401 FAILED when Basic credentials are incorrect', async () => {
    const wrongPassword = Buffer.from(`${TEST_USERNAME}:wrong-password`, 'utf8').toString('base64');
    const res1 = await fetch(`${baseUrl}/vqr/api/token_generate`, {
      method: 'POST',
      headers: { Authorization: `Basic ${wrongPassword}` },
    });
    assert.equal(res1.status, 401);
    assert.ok(res1.headers.get('www-authenticate')?.includes('Basic'));
    const body1 = (await res1.json()) as { status: string; message: string };
    assert.equal(body1.status, 'FAILED');
    assert.equal(body1.message, 'Invalid credentials');

    const wrongUsername = Buffer.from(`other-user:${TEST_PASSWORD}`, 'utf8').toString('base64');
    const res2 = await fetch(`${baseUrl}/vqr/api/token_generate`, {
      method: 'POST',
      headers: { Authorization: `Basic ${wrongUsername}` },
    });
    assert.equal(res2.status, 401);
    assert.equal(((await res2.json()) as { status: string }).status, 'FAILED');
  });

  it('returns 503 FAILED when VIETQR_ENABLED=false', async () => {
    @Module({
      controllers: [VietqrController],
      providers: [
        { provide: vietqrConfig.KEY, useValue: makeEnabledConfig({ enabled: false }) },
        VietqrTokenService,
        VietqrBasicAuthGuard,
        VietqrBearerAuthGuard,
        { provide: VietqrWebhookService, useValue: { handleTransactionSync: async () => ({ error: false, errorReason: null, toastMessage: 'ok', object: { reftransactionid: 'stub' } }) } },
      ],
    })
    class DisabledVietqrModule {}

    const disabledApp = await NestFactory.create(DisabledVietqrModule, { logger: false });
    await disabledApp.listen(0, '127.0.0.1');
    try {
      const address = disabledApp.getHttpServer().address();
      assert.ok(address && typeof address === 'object');
      const basic = Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`, 'utf8').toString('base64');
      const res = await fetch(`http://127.0.0.1:${address.port}/vqr/api/token_generate`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}` },
      });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { status: string }).status, 'FAILED');
    } finally {
      await disabledApp.close();
    }
  });
});
