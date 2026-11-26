import 'dotenv/config';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Context, Telegraf } from 'telegraf';
import {
  OrderStatus,
  PaymentProvider,
  PlanHandleType,
} from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createOrderAndSendQr,
  handlePendingCheckoutText,
  registerCatalog,
  type CatalogDependencies,
  type PendingCheckoutState,
} from '../src/telegram/telegram-catalog.js';

describe('Checkout Failure Rollback & Checkout Guardrails', () => {
  it('cancels order and releases stock when SePay QR generation fails', async () => {
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
          handleType: PlanHandleType.OTHER,
          handleConfig: {},
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
          expiresAt: new Date(Date.now() + 10 * 60_000),
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
      sepayQrClient: {
        isConfigured: () => true,
        generateCustomerQr: async () => {
          throw new Error('Simulated SePay upstream timeout');
        },
      } as unknown as CatalogDependencies['sepayQrClient'],
      orderExpiresMinutes: 10,
      pendingCheckoutInputs: new Map<number, PendingCheckoutState>(),
      inFlightCheckouts: new Set<number>(),
    };

    const fakeContext = {
      chat: { id: 42, type: 'private' },
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
      reason: 'SEPAY_QR_GENERATION_FAILED',
    });
    assert.ok(replies.some((msg) => msg.includes('Không thể tạo mã QR')));
  });

  it('rejects invalid email and supports multi-step CUSTOMER_ACCOUNT checkout before SePay QR generation', async () => {
    const replies: string[] = [];
    const createOrderCalls: Array<Record<string, unknown>> = [];
    const attachedCalls: Array<Record<string, unknown>> = [];
    const photoPayloads: Array<{ caption: string; keyboard: unknown[][] }> = [];
    const pending = new Map<number, PendingCheckoutState>([
      [
        77,
        {
          sessionId: 'a1b2c3d4',
          planId: 'plan-acc-1',
          productName: 'ChatGPT Plus',
          planName: 'Nâng chính chủ 1 tháng',
          lang: 'en',
          handleType: PlanHandleType.CUSTOMER_ACCOUNT,
          fields: [
            { key: 'usernameOrEmail', required: true, validate: 'email' },
            { key: 'password', required: true, validate: 'text' },
            { key: 'twoFactor', required: false, validate: 'text' },
          ],
          currentIndex: 0,
          collected: {},
          expiresAt: Date.now() + 60_000,
        },
      ],
    ]);

    const deps: CatalogDependencies = {
      productsService: {
        getActivePlanById: async () => ({
          id: 'plan-acc-1',
          nameVi: 'Nâng chính chủ 1 tháng',
          nameEn: '1 Month Upgrade',
          price: 120_000n,
          currency: 'VND',
          durationDays: 30,
          warrantyDays: 30,
          stockQuantity: 5,
          handleType: PlanHandleType.CUSTOMER_ACCOUNT,
          handleConfig: {},
          product: { id: 'prod-1', name: 'ChatGPT Plus', slug: 'chatgpt' },
        }),
      } as unknown as CatalogDependencies['productsService'],
      usersService: {
        upsertTelegramUser: async () => ({ id: 'user-77' }),
      } as unknown as CatalogDependencies['usersService'],
      ordersService: {
        createPendingOrder: async (input: Record<string, unknown>) => {
          createOrderCalls.push(input);
          return {
            id: 'order-acc-1',
            orderCode: 'GSACC12345',
            totalAmount: 120_000n,
            currency: 'VND',
            expiresAt: new Date(Date.now() + 10 * 60_000),
            targetEmail: 'bob@example.com',
          };
        },
        attachVietqrPaymentDetails: async (_orderId: string, details: Record<string, unknown>) => {
          attachedCalls.push(details);
          return {};
        },
      } as unknown as CatalogDependencies['ordersService'],
      sepayQrClient: {
        isConfigured: () => true,
        generateCustomerQr: async () => ({
          bankCode: 'Vietcombank',
          bankName: null,
          bankAccount: '9869983819',
          userBankName: 'DO QUANG HUNG',
          amount: '120000',
          content: 'GSACC12345',
          orderId: 'GSACC12345',
          qrLink: 'https://qr.sepay.vn/img?acc=9869983819&bank=Vietcombank&amount=120000&des=GSACC12345&template=compact',
          qrImagePng: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        }),
      } as unknown as CatalogDependencies['sepayQrClient'],
      orderExpiresMinutes: 10,
      pendingCheckoutInputs: pending,
      inFlightCheckouts: new Set<number>(),
    };

    const fakeContext = {
      chat: { id: 77, type: 'private' },
      from: { id: 77, first_name: 'Bob' },
      reply: async (text: string) => {
        replies.push(text);
        return { chat: { id: 77 }, message_id: replies.length };
      },
      replyWithPhoto: async (_photo: unknown, extra: { caption: string; reply_markup: { inline_keyboard: unknown[][] } }) => {
        photoPayloads.push({
          caption: extra.caption,
          keyboard: extra.reply_markup.inline_keyboard,
        });
      },
      telegram: {
        deleteMessage: async () => true,
      },
    } as unknown as Context;

    // Group chat must NOT consume or leak private pending checkout state
    const groupHandled = await handlePendingCheckoutText(
      { ...fakeContext, chat: { id: -999, type: 'group' } } as unknown as Context,
      deps,
      'bob@example.com',
    );
    assert.equal(groupHandled, false);
    assert.equal(pending.get(77)?.currentIndex, 0);

    // 1. Invalid email stays on step 0
    const handled1 = await handlePendingCheckoutText(fakeContext, deps, 'not-an-email');
    assert.equal(handled1, true);
    assert.equal(pending.get(77)?.currentIndex, 0);
    assert.ok(replies[0]?.includes('Invalid email'));

    // 2. Valid email advances to step 1 (password)
    const handled2 = await handlePendingCheckoutText(fakeContext, deps, 'bob@example.com');
    assert.equal(handled2, true);
    assert.equal(pending.get(77)?.currentIndex, 1);
    assert.ok(replies[1]?.includes('(2/3)'));

    // 3. Blank password is rejected
    const handled3 = await handlePendingCheckoutText(fakeContext, deps, '   ');
    assert.equal(handled3, true);
    assert.equal(pending.get(77)?.currentIndex, 1);

    // 4. Valid password advances to step 2 (2FA)
    const handled4 = await handlePendingCheckoutText(fakeContext, deps, 'SecretPass!99');
    assert.equal(handled4, true);
    assert.equal(pending.get(77)?.currentIndex, 2);
    assert.ok(replies[3]?.includes('(3/3)'));

    // 5. Entering 2FA completes collection and creates SePay order + QR
    const handled5 = await handlePendingCheckoutText(fakeContext, deps, 'BACKUP-CODE-123');
    assert.equal(handled5, true);
    assert.equal(pending.has(77), false);
    assert.equal(createOrderCalls.length, 1);
    assert.equal(createOrderCalls[0]?.paymentProvider, PaymentProvider.SEPAY);
    assert.equal(createOrderCalls[0]?.expiresMinutes, 10);
    assert.deepEqual(createOrderCalls[0]?.customerInput, {
      usernameOrEmail: 'bob@example.com',
      password: 'SecretPass!99',
      twoFactor: 'BACKUP-CODE-123',
    });
    assert.equal(attachedCalls[0]?.paymentProvider, PaymentProvider.SEPAY);
    assert.equal(attachedCalls[0]?.paymentContent, 'GSACC12345');
    assert.equal(photoPayloads.length, 1);
    assert.ok(photoPayloads[0]?.caption.includes('bob@example.com'));
    assert.ok(photoPayloads[0]?.caption.includes('9869983819'));
    assert.ok(photoPayloads[0]?.caption.includes('DO QUANG HUNG'));
    assert.ok(photoPayloads[0]?.caption.includes('GSACC12345'));
    assert.ok(photoPayloads[0]?.caption.includes('shown above'));
    assert.equal(photoPayloads[0]?.caption.includes('automatic confirmation'), false);
    assert.equal(photoPayloads[0]?.caption.includes('SecretPass!99'), false);
    assert.equal(photoPayloads[0]?.caption.includes('BACKUP-CODE-123'), false);
    assert.equal(photoPayloads[0]?.keyboard.length, 1);
    assert.equal(photoPayloads[0]?.keyboard[0]?.length, 1);
    assert.equal(
      (photoPayloads[0]?.keyboard[0]?.[0] as { callback_data?: string }).callback_data,
      'order:en:cancel:order-acc-1',
    );
  });

  it('enforces private chat, double-tap lock, strict UUIDs, and session/step-matched Skip & navigation cleanup', async () => {
    const actions: Array<{ trigger: string | RegExp; handler: (ctx: Context) => Promise<unknown> }> = [];
    const fakeBot = {
      action(trigger: string | RegExp, handler: (ctx: Context) => Promise<unknown>) {
        actions.push({ trigger, handler });
      },
    } as unknown as Telegraf;

    const planUuid = randomUUID();
    const pending = new Map<number, PendingCheckoutState>();
    const inFlight = new Set<number>();
    let releaseCreateOrder!: () => void;
    const createOrderGate = new Promise<void>((resolve) => {
      releaseCreateOrder = resolve;
    });
    let createOrderCount = 0;

    const deps: CatalogDependencies = {
      productsService: {
        listActiveProducts: async () => [],
        getActivePlanById: async () => ({
          id: planUuid,
          nameVi: 'Gói 1 Tháng',
          nameEn: '1 Month',
          price: 100_000n,
          currency: 'VND',
          durationDays: 30,
          warrantyDays: 30,
          stockQuantity: 3,
          handleType: PlanHandleType.OTHER,
          handleConfig: {
            fields: [
              { key: 'note', required: false, validate: 'text' },
              { key: 'twoFactor', required: false, validate: 'text' },
            ],
          },
          product: { id: randomUUID(), name: 'Gemini Pro', slug: 'gemini' },
        }),
      } as unknown as CatalogDependencies['productsService'],
      usersService: {
        upsertTelegramUser: async () => ({ id: 'user-88' }),
      } as unknown as CatalogDependencies['usersService'],
      ordersService: {
        createPendingOrder: async () => {
          createOrderCount += 1;
          await createOrderGate;
          return {
            id: randomUUID(),
            orderCode: 'GSLOCK123456',
            totalAmount: 100_000n,
            currency: 'VND',
            expiresAt: new Date(Date.now() + 30 * 60_000),
            targetEmail: null,
          };
        },
        attachVietqrPaymentDetails: async () => ({}),
      } as unknown as CatalogDependencies['ordersService'],
      sepayQrClient: {
        isConfigured: () => true,
        generateCustomerQr: async () => ({
          bankCode: 'Vietcombank',
          bankName: null,
          bankAccount: '9869983819',
          userBankName: 'DO QUANG HUNG',
          amount: '100000',
          content: 'GSLOCK123456',
          orderId: 'GSLOCK123456',
          qrLink: 'https://qr.sepay.vn/img?acc=9869983819&bank=Vietcombank&amount=100000&des=GSLOCK123456&template=compact',
          qrImagePng: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        }),
      } as unknown as CatalogDependencies['sepayQrClient'],
      pendingCheckoutInputs: pending,
      inFlightCheckouts: inFlight,
    };

    registerCatalog(fakeBot, 'vi', deps, async () => undefined);

    function findAction(data: string) {
      for (const entry of actions) {
        if (typeof entry.trigger === 'string' && entry.trigger === data) {
          return { handler: entry.handler, match: [data] as unknown as RegExpExecArray };
        }
        if (entry.trigger instanceof RegExp) {
          const m = entry.trigger.exec(data);
          if (m) return { handler: entry.handler, match: m };
        }
      }
      return null;
    }

    // 1. Malformed 36-hyphen fake UUID must NOT match buy/item/status/cancel routes
    assert.equal(findAction(`catalog:vi:buy:${'-'.repeat(36)}`), null);
    assert.equal(findAction(`order:vi:status:${'-'.repeat(36)}`), null);

    // 2. Group chat cannot trigger buy action
    const buyRoute = findAction(`catalog:vi:buy:${planUuid}`);
    assert.ok(buyRoute);
    const groupCbAnswers: Array<string | undefined> = [];
    await buyRoute.handler({
      chat: { id: -100, type: 'group' },
      from: { id: 88, first_name: 'GroupUser' },
      match: buyRoute.match,
      answerCbQuery: async (msg?: string) => {
        groupCbAnswers.push(msg);
      },
    } as unknown as Context);
    assert.ok(groupCbAnswers[0]?.includes('nhắn riêng'));
    assert.equal(pending.has(88), false);

    // 3. Private chat buy starts session with step-bound skip callback
    const replies: Array<{ text: string; extra?: { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } } }> = [];
    const privateCtxBase = {
      chat: { id: 88, type: 'private' },
      from: { id: 88, first_name: 'Hung' },
      answerCbQuery: async () => undefined,
      editMessageText: async () => undefined,
      editMessageReplyMarkup: async () => undefined,
      reply: async (text: string, extra?: unknown) => {
        replies.push({ text, extra: extra as typeof replies[number]['extra'] });
        return { chat: { id: 88 }, message_id: replies.length };
      },
      replyWithPhoto: async () => undefined,
      telegram: { deleteMessage: async () => true },
    };

    await buyRoute.handler({
      ...privateCtxBase,
      match: buyRoute.match,
    } as unknown as Context);

    const state = pending.get(88);
    assert.ok(state);
    assert.equal(state.currentIndex, 0);
    const skipCb0 = state.fields[0]
      ? replies[0]?.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data
      : undefined;
    assert.equal(skipCb0, `checkout:vi:skip:${state.sessionId}:0`);

    // Stale skip with wrong step or wrong session MUST NOT advance state
    const wrongStepRoute = findAction(`checkout:vi:skip:${state.sessionId}:1`);
    assert.ok(wrongStepRoute);
    await wrongStepRoute.handler({
      ...privateCtxBase,
      match: wrongStepRoute.match,
    } as unknown as Context);
    assert.equal(pending.get(88)?.currentIndex, 0);

    const wrongSessionRoute = findAction('checkout:vi:skip:deadbeef:0');
    assert.ok(wrongSessionRoute);
    await wrongSessionRoute.handler({
      ...privateCtxBase,
      match: wrongSessionRoute.match,
    } as unknown as Context);
    assert.equal(pending.get(88)?.currentIndex, 0);

    // Valid skip for step 0 advances to step 1
    const validSkip0 = findAction(`checkout:vi:skip:${state.sessionId}:0`);
    assert.ok(validSkip0);
    await validSkip0.handler({
      ...privateCtxBase,
      match: validSkip0.match,
    } as unknown as Context);
    assert.equal(pending.get(88)?.currentIndex, 1);

    // Navigating back clears abandoned pending checkout input
    const backRoute = findAction('catalog:vi:back');
    assert.ok(backRoute);
    await backRoute.handler({
      ...privateCtxBase,
      match: backRoute.match,
    } as unknown as Context);
    assert.equal(pending.has(88), false);

    // 4. Double-tap guard blocks concurrent order creation for same user
    const firstOrderPromise = createOrderAndSendQr(
      privateCtxBase as unknown as Context,
      deps,
      'vi',
      planUuid,
      null,
    );
    // Allow first call to reach createPendingOrder
    await new Promise((resolve) => setTimeout(resolve, 10));
    await createOrderAndSendQr(
      privateCtxBase as unknown as Context,
      deps,
      'vi',
      planUuid,
      null,
    );
    releaseCreateOrder();
    await firstOrderPromise;

    assert.equal(createOrderCount, 1);
    assert.ok(replies.some((r) => r.text.includes('đang được xử lý')));
    assert.equal(inFlight.has(88), false);
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
