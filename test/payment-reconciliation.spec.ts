import 'dotenv/config';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  SubscriptionStatus,
} from '../src/generated/prisma/client.js';
import {
  computeRetryDelayMs,
  TelegramOutboxService,
} from '../src/notifications/telegram-outbox.service.js';
import type {
  TelegramMessageSender,
  TelegramSendResult,
} from '../src/notifications/telegram-sender.interface.js';
import { OrderDomainError, OrdersService } from '../src/orders/orders.service.js';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe('Phase 4 DB Integration: Reconciliation, Stock Reservation, Admin Flow & Outbox', { skip: !hasDatabase }, () => {
  const prisma = new PrismaService();
  const outbox = new TelegramOutboxService(prisma);
  const ordersService = new OrdersService(prisma, outbox);
  const reconciliationService = new PaymentReconciliationService(prisma, outbox);

  const runSuffix = randomUUID().slice(0, 8);
  const createdProductIds: string[] = [];
  const createdPlanIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdPaymentIds: string[] = [];
  const originalAdminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  let testUserId = '';
  let testProductId = '';

  before(async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = '9999990001';
    await prisma.$connect();

    const user = await prisma.user.create({
      data: {
        telegramId: BigInt(9_000_000_000 + Math.floor(Math.random() * 900_000_000)),
        username: `test_user_${runSuffix}`,
        firstName: 'Test',
        lastName: 'Buyer',
        languageCode: 'vi',
      },
    });
    testUserId = user.id;
    createdUserIds.push(user.id);

    const product = await prisma.product.create({
      data: {
        name: `Test Product ${runSuffix}`,
        slug: `test-product-${runSuffix}`,
        isActive: true,
      },
    });
    testProductId = product.id;
    createdProductIds.push(product.id);
  });

  after(async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = originalAdminChatId;
    outbox.stopPolling();
    outbox.registerSender(null);

    // Strictly delete ONLY synthetic records created by this test run in FK order.
    if (createdOrderIds.length > 0 || createdPaymentIds.length > 0) {
      await prisma.telegramNotification.deleteMany({
        where: {
          OR: [
            createdOrderIds.length > 0 ? { orderId: { in: createdOrderIds } } : undefined,
            createdPaymentIds.length > 0 ? { paymentId: { in: createdPaymentIds } } : undefined,
          ].filter((x): x is NonNullable<typeof x> => Boolean(x)),
        },
      });
    }
    if (createdOrderIds.length > 0) {
      await prisma.subscription.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    }
    if (createdPaymentIds.length > 0) {
      await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
    }
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdPlanIds.length > 0) {
      await prisma.plan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await prisma.$disconnect();
  });

  async function createTestPlan(overrides: {
    stockQuantity: number;
    price?: bigint;
    durationDays?: number;
    requiresEmail?: boolean;
  }) {
    const plan = await prisma.plan.create({
      data: {
        productId: testProductId,
        code: `TEST_PLAN_${randomUUID().slice(0, 8).toUpperCase()}`,
        nameVi: 'Gói kiểm thử',
        nameEn: 'Test Plan',
        price: overrides.price ?? 100_000n,
        currency: 'VND',
        durationDays: overrides.durationDays ?? 30,
        warrantyDays: 30,
        stockQuantity: overrides.stockQuantity,
        requiresEmail: overrides.requiresEmail ?? false,
        isActive: true,
      },
    });
    createdPlanIds.push(plan.id);
    return plan;
  }

  it('prevents overselling when concurrent users order the last remaining slot', async () => {
    const plan = await createTestPlan({ stockQuantity: 1 });

    const attempts = await Promise.allSettled([
      ordersService.createPendingOrder({ userId: testUserId, planId: plan.id }),
      ordersService.createPendingOrder({ userId: testUserId, planId: plan.id }),
      ordersService.createPendingOrder({ userId: testUserId, planId: plan.id }),
    ]);

    const succeeded = attempts.filter((r) => r.status === 'fulfilled');
    const rejected = attempts.filter((r) => r.status === 'rejected');

    assert.equal(succeeded.length, 1);
    assert.equal(rejected.length, 2);

    for (const s of succeeded) {
      createdOrderIds.push(s.value.id);
      assert.equal(s.value.stockReserved, true);
      assert.equal(s.value.status, OrderStatus.PENDING);
    }
    for (const r of rejected) {
      assert.ok(r.reason instanceof OrderDomainError);
      assert.equal(r.reason.code, 'OUT_OF_STOCK');
    }

    const updatedPlan = await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
    assert.equal(updatedPlan.stockQuantity, 0);
  });

  it('releases stock exactly once on cancel and on expiration sweeper', async () => {
    const plan = await createTestPlan({ stockQuantity: 2 });
    const order1 = await ordersService.createPendingOrder({ userId: testUserId, planId: plan.id });
    const order2 = await ordersService.createPendingOrder({ userId: testUserId, planId: plan.id });
    createdOrderIds.push(order1.id, order2.id);

    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).stockQuantity, 0);

    // Cancel order1 twice concurrently -> stock incremented only once
    const [cancelA, cancelB] = await Promise.all([
      ordersService.cancelPendingOrder(order1.id, testUserId, 'user cancelled'),
      ordersService.cancelPendingOrder(order1.id, testUserId, 'user cancelled'),
    ]);
    assert.equal([cancelA.cancelled, cancelB.cancelled].filter(Boolean).length, 1);
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).stockQuantity, 1);

    // Expire order2 by moving expiresAt into the past and running sweeper
    await prisma.order.update({
      where: { id: order2.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expiredCount = await ordersService.expireDueOrders(50);
    assert.ok(expiredCount >= 1);
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).stockQuantity, 2);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order2.id } })).status, OrderStatus.EXPIRED);
  });

  it('verifies exact payment once, does not decrement stock twice, handles duplicate & concurrent webhooks, and leaves order PAID for Admin', async () => {
    const plan = await createTestPlan({ stockQuantity: 3, price: 150_000n, durationDays: 30 });
    const order = await ordersService.createPendingOrder({
      userId: testUserId,
      planId: plan.id,
      targetEmail: 'buyer@example.com',
    });
    createdOrderIds.push(order.id);
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).stockQuantity, 2);

    const txId = `vietqr-tx-${randomUUID()}`;
    const baseTx = {
      provider: PaymentProvider.VIETQR,
      providerTransactionId: txId,
      referenceCode: `FT${runSuffix}001`,
      bankAccount: '0123456789',
      expectedBankAccount: '0123456789',
      amount: 150_000n,
      currency: 'VND',
      transType: 'C',
      content: order.orderCode,
      orderCodeHint: order.orderCode,
      transactionAt: new Date(),
      receivedAt: new Date(),
      rawPayload: { orderId: order.orderCode, amount: 150000 },
    };

    // Concurrent duplicate webhooks with same providerTransactionId
    const [r1, r2, r3] = await Promise.all([
      reconciliationService.reconcile(baseTx),
      reconciliationService.reconcile(baseTx),
      reconciliationService.reconcile(baseTx),
    ]);

    const outcomes = [r1.outcome, r2.outcome, r3.outcome].sort();
    assert.deepEqual(outcomes, ['DUPLICATE', 'DUPLICATE', 'VERIFIED']);
    assert.equal(r1.paymentId, r2.paymentId);
    assert.equal(r2.paymentId, r3.paymentId);
    createdPaymentIds.push(r1.paymentId);

    // Stock MUST remain 2 (slot reserved at checkout used, NOT decremented twice!)
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).stockQuantity, 2);

    // Order MUST be PAID (NOT COMPLETED) and NO subscription created automatically!
    const paidOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { subscription: true },
    });
    assert.equal(paidOrder.status, OrderStatus.PAID);
    assert.equal(paidOrder.subscription, null);

    // Different transaction hitting same already-paid order -> REJECTED (ORDER_ALREADY_PAID)
    const secondPay = await reconciliationService.reconcile({
      ...baseTx,
      providerTransactionId: `vietqr-tx-${randomUUID()}`,
      referenceCode: `FT${runSuffix}002`,
    });
    createdPaymentIds.push(secondPay.paymentId);
    assert.equal(secondPay.outcome, 'REJECTED');
    assert.equal(secondPay.reason, 'ORDER_ALREADY_PAID');

    // Admin workflow: PAID -> PROCESSING -> COMPLETED (idempotent subscription creation)
    const processingOrder = await ordersService.startProcessingOrder(order.id);
    assert.equal(processingOrder.status, OrderStatus.PROCESSING);

    const completed1 = await ordersService.completeOrder(order.id);
    assert.equal(completed1.order.status, OrderStatus.COMPLETED);
    assert.equal(completed1.alreadyCompleted, false);
    assert.ok(completed1.subscription);
    assert.equal(completed1.subscription.status, SubscriptionStatus.ACTIVE);
    assert.equal(completed1.subscription.targetEmail, 'buyer@example.com');

    // Calling completeOrder again MUST be idempotent and NOT create a second subscription
    const completed2 = await ordersService.completeOrder(order.id);
    assert.equal(completed2.alreadyCompleted, true);
    assert.equal(completed2.subscription?.id, completed1.subscription.id);
  });

  it('accepts late-arriving webhook when bank transaction occurred within expires_at and handles out-of-stock safely', async () => {
    // Case A: Stock still available -> re-reserves 1 slot and confirms PAID
    const planA = await createTestPlan({ stockQuantity: 1, price: 80_000n });
    const orderA = await ordersService.createPendingOrder({ userId: testUserId, planId: planA.id });
    createdOrderIds.push(orderA.id);
    const paidBeforeExpiry = new Date(orderA.expiresAt.getTime() - 10_000);

    await prisma.order.update({
      where: { id: orderA.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await ordersService.expireDueOrders(50);
    // Restore original expiresAt so paidBeforeExpiry <= expiresAt while order is EXPIRED
    await prisma.order.update({
      where: { id: orderA.id },
      data: { expiresAt: new Date(paidBeforeExpiry.getTime() + 10_000) },
    });
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: planA.id } })).stockQuantity, 1);

    const lateOk = await reconciliationService.reconcile({
      provider: PaymentProvider.VIETQR,
      providerTransactionId: `vietqr-late-ok-${randomUUID()}`,
      referenceCode: `FT${runSuffix}L1`,
      bankAccount: '0123456789',
      expectedBankAccount: '0123456789',
      amount: 80_000n,
      currency: 'VND',
      transType: 'C',
      content: orderA.orderCode,
      orderCodeHint: orderA.orderCode,
      transactionAt: paidBeforeExpiry,
      receivedAt: new Date(),
      rawPayload: { orderId: orderA.orderCode },
    });
    createdPaymentIds.push(lateOk.paymentId);
    assert.equal(lateOk.outcome, 'VERIFIED');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } })).status, OrderStatus.PAID);
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: planA.id } })).stockQuantity, 0);

    // Case B: Out of stock when late webhook arrives -> records REJECTED payment for manual handling
    const planB = await createTestPlan({ stockQuantity: 1, price: 90_000n });
    const orderB = await ordersService.createPendingOrder({ userId: testUserId, planId: planB.id });
    createdOrderIds.push(orderB.id);
    const paidBeforeExpiryB = new Date(orderB.expiresAt.getTime() - 10_000);

    await prisma.order.update({
      where: { id: orderB.id },
      data: { status: OrderStatus.EXPIRED, stockReleasedAt: new Date() },
    });
    // Simulate another buyer taking the last slot -> stock = 0
    await prisma.plan.update({ where: { id: planB.id }, data: { stockQuantity: 0 } });

    const lateOos = await reconciliationService.reconcile({
      provider: PaymentProvider.VIETQR,
      providerTransactionId: `vietqr-late-oos-${randomUUID()}`,
      referenceCode: `FT${runSuffix}L2`,
      bankAccount: '0123456789',
      expectedBankAccount: '0123456789',
      amount: 90_000n,
      currency: 'VND',
      transType: 'C',
      content: orderB.orderCode,
      orderCodeHint: orderB.orderCode,
      transactionAt: paidBeforeExpiryB,
      receivedAt: new Date(),
      rawPayload: { orderId: orderB.orderCode },
    });
    createdPaymentIds.push(lateOos.paymentId);
    assert.equal(lateOos.outcome, 'REJECTED');
    assert.equal(lateOos.reason, 'OUT_OF_STOCK_AFTER_LATE_WEBHOOK');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } })).status, OrderStatus.EXPIRED);
  });

  it('records underpaid, overpaid, unmatched, and bank-account-mismatch transactions without confirming orders', async () => {
    const plan = await createTestPlan({ stockQuantity: 2, price: 200_000n });
    const order = await ordersService.createPendingOrder({ userId: testUserId, planId: plan.id });
    createdOrderIds.push(order.id);

    const underpaid = await reconciliationService.reconcile({
      provider: PaymentProvider.VIETQR,
      providerTransactionId: `vietqr-under-${randomUUID()}`,
      referenceCode: `FT${runSuffix}U`,
      bankAccount: '0123456789',
      expectedBankAccount: '0123456789',
      amount: 199_999n,
      currency: 'VND',
      transType: 'C',
      content: order.orderCode,
      orderCodeHint: order.orderCode,
      transactionAt: new Date(),
      receivedAt: new Date(),
      rawPayload: { secretToken: 'must-be-stripped', amount: 199999 },
    });
    createdPaymentIds.push(underpaid.paymentId);
    assert.equal(underpaid.outcome, 'REJECTED');
    assert.ok(underpaid.reason?.startsWith('AMOUNT_UNDERPAID'));

    // Verify sensitive field was stripped from rawPayload
    const savedUnderpaid = await prisma.payment.findUniqueOrThrow({ where: { id: underpaid.paymentId } });
    assert.equal((savedUnderpaid.rawPayload as Record<string, unknown>)['secretToken'], undefined);

    const overpaid = await reconciliationService.reconcile({
      provider: PaymentProvider.VIETQR,
      providerTransactionId: `vietqr-over-${randomUUID()}`,
      referenceCode: `FT${runSuffix}O`,
      bankAccount: '0123456789',
      expectedBankAccount: '0123456789',
      amount: 200_001n,
      currency: 'VND',
      transType: 'C',
      content: order.orderCode,
      orderCodeHint: order.orderCode,
      transactionAt: new Date(),
      receivedAt: new Date(),
      rawPayload: { amount: 200001 },
    });
    createdPaymentIds.push(overpaid.paymentId);
    assert.equal(overpaid.outcome, 'REJECTED');
    assert.ok(overpaid.reason?.startsWith('AMOUNT_OVERPAID'));

    const unmatched = await reconciliationService.reconcile({
      provider: PaymentProvider.VIETQR,
      providerTransactionId: `vietqr-unmatched-${randomUUID()}`,
      referenceCode: `FT${runSuffix}X`,
      bankAccount: '0123456789',
      expectedBankAccount: '0123456789',
      amount: 200_000n,
      currency: 'VND',
      transType: 'C',
      content: 'CHUYEN KHOAN KHONG CO MA DON',
      orderCodeHint: 'GSNOTFOUND01',
      transactionAt: new Date(),
      receivedAt: new Date(),
      rawPayload: { content: 'CHUYEN KHOAN KHONG CO MA DON' },
    });
    createdPaymentIds.push(unmatched.paymentId);
    assert.equal(unmatched.outcome, 'UNMATCHED');
    assert.equal(unmatched.reason, 'ORDER_NOT_FOUND');

    // Order must still remain PENDING after all mismatches
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, OrderStatus.PENDING);
  });

  it('recovers crashed PROCESSING notifications, respects retry_after, and marks FAILED after max attempts', async () => {
    assert.equal(computeRetryDelayMs(1), 5_000);
    assert.equal(computeRetryDelayMs(2), 10_000);
    assert.equal(computeRetryDelayMs(1, 25), 25_000);

    const plan = await createTestPlan({ stockQuantity: 1, price: 50_000n });
    const order = await ordersService.createPendingOrder({ userId: testUserId, planId: plan.id });
    createdOrderIds.push(order.id);

    // Enqueue a notification and simulate a crashed worker holding an expired lock
    const dedupeKey = `test-crash-recovery-${randomUUID()}`;
    await prisma.$transaction((tx) =>
      outbox.enqueue(tx, {
        dedupeKey,
        chatId: 123456789n,
        notificationType: 'ORDER_PAID_CUSTOMER',
        orderId: order.id,
        text: 'Crash recovery test message',
        maxAttempts: 2,
      }),
    );

    const created = await prisma.telegramNotification.findUniqueOrThrow({ where: { dedupeKey } });
    await prisma.telegramNotification.update({
      where: { id: created.id },
      data: {
        status: 'PROCESSING',
        lockedAt: new Date(Date.now() - 120_000),
        lockedBy: 'crashed-worker:999',
        lockExpiresAt: new Date(Date.now() - 10_000),
      },
    });

    const delivered: Array<{ chatId: bigint; text: string }> = [];
    let targetAttempts = 0;
    const flakySender: TelegramMessageSender = {
      async sendMessage(chatId, text): Promise<TelegramSendResult> {
        if (text === 'Crash recovery test message') {
          targetAttempts += 1;
          if (targetAttempts === 1) {
            return { ok: false, errorMessage: '429 Too Many Requests', retryAfterSeconds: 12 };
          }
          delivered.push({ chatId, text });
        }
        return { ok: true };
      },
    };

    outbox.registerSender(flakySender, false);
    await outbox.processDueNotifications(10);

    const afterFirstFail = await prisma.telegramNotification.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(afterFirstFail.status, 'PENDING');
    assert.equal(afterFirstFail.attempts, 1);
    assert.equal(afterFirstFail.lockedBy, null);
    assert.ok(afterFirstFail.nextAttemptAt.getTime() >= Date.now() + 8_000);

    // Make it due immediately and verify second attempt succeeds -> SENT
    await prisma.telegramNotification.update({
      where: { id: created.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    await outbox.processDueNotifications(10);

    const afterSuccess = await prisma.telegramNotification.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(afterSuccess.status, 'SENT');
    assert.ok(afterSuccess.sentAt);
    assert.equal(delivered.length, 1);

    // Verify permanent failure transitions cleanly to FAILED
    const failKey = `test-fail-${randomUUID()}`;
    await prisma.$transaction((tx) =>
      outbox.enqueue(tx, {
        dedupeKey: failKey,
        chatId: 123456789n,
        notificationType: 'PAYMENT_ALERT_ADMIN',
        orderId: order.id,
        text: 'Will fail permanently',
        maxAttempts: 1,
      }),
    );
    outbox.registerSender(
      {
        async sendMessage() {
          return { ok: false, errorMessage: '403 Forbidden: bot was blocked by the user', permanent: true };
        },
      },
      false,
    );
    await outbox.processDueNotifications(10);
    const failedRow = await prisma.telegramNotification.findUniqueOrThrow({ where: { dedupeKey: failKey } });
    assert.equal(failedRow.status, 'FAILED');
    assert.equal(failedRow.attempts, 1);

    outbox.registerSender(null);
  });
});
