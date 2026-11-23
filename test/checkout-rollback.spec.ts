import 'dotenv/config';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Context } from 'telegraf';
import { OrderStatus } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createOrderAndSendQr,
  handlePendingEmailText,
  type CatalogDependencies,
  type PendingEmailCheckout,
} from '../src/telegram/telegram-catalog.js';

describe('Checkout Failure Rollback & Email Prompt', () => {
  it('cancels order and releases stock when VietQR QR generation fails', async () => {
    const replies: string[] = [];
    const cancelledCalls: Array<{ orderId: string; userId?: string; reason?: string }> = [];

    const deps: CatalogDependencies = {
      productsService: {
        getActivePlanById: async () => ({
          id: 'plan-1',
          nameVi: 'Gói 1 Tháng',
          nameEn: '1 Month Plan',
          price: 100_000n,
          currency: 'VND',
          durationDays: 30,
          warrantyDays: 30,
          stockQuantity: 2,
          requiresEmail: false,
          product: { id: 'prod-1', name: 'Gemini Pro', slug: 'gemini' },
        }),
      } as unknown as CatalogDependencies['productsService'],
      usersService: {
        upsertTelegramUser: async () => ({ id: 'user-1' }),
      } as unknown as CatalogDependencies['usersService'],
      ordersService: {
        createPendingOrder: async () => ({
          id: 'order-1',
          orderCode: 'GS1234567890',
          totalAmount: 100_000n,
          currency: 'VND',
          expiresAt: new Date(Date.now() + 30 * 60_000),
          targetEmail: null,
        }),
        cancelPendingOrder: async (orderId: string, userId?: string, reason?: string) => {
          cancelledCalls.push({ orderId, userId, reason });
          return { cancelled: true, status: OrderStatus.CANCELLED };
        },
        attachVietqrPaymentDetails: async () => {
          throw new Error('Should not be reached when QR fails');
        },
      } as unknown as CatalogDependencies['ordersService'],
      vietqrApiClient: {
        isConfigured: () => true,
        generateCustomerQr: async () => {
          throw new Error('Simulated VietQR upstream timeout');
        },
      } as unknown as CatalogDependencies['vietqrApiClient'],
      pendingEmailCheckouts: new Map<number, PendingEmailCheckout>(),
    };

    const fakeContext = {
      from: { id: 42, first_name: 'Alice' },
      reply: async (text: string) => {
        replies.push(text);
        return { chat: { id: 42 }, message_id: 100 };
      },
      telegram: {
        deleteMessage: async () => true,
      },
    } as unknown as Context;

    await createOrderAndSendQr(fakeContext, deps, 'vi', 'plan-1', null);

    assert.equal(cancelledCalls.length, 1);
    assert.deepEqual(cancelledCalls[0], {
      orderId: 'order-1',
      userId: 'user-1',
      reason: 'VIETQR_QR_GENERATION_FAILED',
    });
    assert.ok(replies.some((msg) => msg.includes('Không thể tạo mã QR')));
  });

  it('rejects invalid email during pending email checkout and keeps prompt active', async () => {
    const replies: string[] = [];
    const pending = new Map<number, PendingEmailCheckout>([
      [77, { planId: 'plan-1', lang: 'en', expiresAt: Date.now() + 60_000 }],
    ]);

    const deps = {
      pendingEmailCheckouts: pending,
    } as unknown as CatalogDependencies;

    const fakeContext = {
      from: { id: 77, first_name: 'Bob' },
      reply: async (text: string) => {
        replies.push(text);
      },
    } as unknown as Context;

    const handled = await handlePendingEmailText(fakeContext, deps, 'not-an-email');
    assert.equal(handled, true);
    assert.equal(pending.has(77), true);
    assert.ok(replies[0]?.includes('Invalid email'));
  });
});

describe('PostgreSQL Transaction Rollback Verification', { skip: !process.env.DATABASE_URL }, () => {
  it('rolls back all changes atomically if an error occurs mid-transaction', async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    const syntheticKey = `rollback-test-${randomUUID()}`;

    try {
      await assert.rejects(
        () =>
          prisma.$transaction(async (tx) => {
            await tx.telegramNotification.create({
              data: {
                dedupeKey: syntheticKey,
                chatId: 111111n,
                notificationType: 'ORDER_PAID_CUSTOMER',
                payload: { text: 'Should be rolled back' },
              },
            });
            throw new Error('Simulated mid-transaction DB failure');
          }),
        /Simulated mid-transaction DB failure/,
      );

      const persisted = await prisma.telegramNotification.findUnique({
        where: { dedupeKey: syntheticKey },
      });
      assert.equal(persisted, null);
    } finally {
      await prisma.telegramNotification.deleteMany({ where: { dedupeKey: syntheticKey } });
      await prisma.$disconnect();
    }
  });
});
