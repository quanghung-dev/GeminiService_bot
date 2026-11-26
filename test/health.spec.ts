import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthController } from '../src/health.controller.js';

@Module({
  controllers: [HealthController],
})
class TestHealthModule {}

describe('GET /health', () => {
  let app: INestApplication;
  let baseUrl = '';

  before(async () => {
    app = await NestFactory.create(TestHealthModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await app.close();
  });

  it('returns 200 ok with no-store cache header for GET and HEAD', async () => {
    const getRes = await fetch(`${baseUrl}/health`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await getRes.json(), { status: 'ok' });

    const headRes = await fetch(`${baseUrl}/health`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('cache-control'), 'no-store');
  });
});
