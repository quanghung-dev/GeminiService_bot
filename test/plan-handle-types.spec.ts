import 'dotenv/config';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  OrderStatus,
  PaymentProvider,
  PlanHandleType,
  type Prisma,
  SubscriptionStatus,
} from '../src/generated/prisma/client.js';
import { AdminOrdersController } from '../src/admin/admin-orders.controller.js';
import { TelegramOutboxService } from '../src/notifications/telegram-outbox.service.js';
import {
  parsePlanHandleConfig,
  resolveCheckoutFields,
  validateAndNormalizeDeliveryData,
} from '../src/orders/handle-type.types.js';
import { OrderDomainError, OrdersService } from '../src/orders/orders.service.js';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('PlanHandleType helpers & validation (Unit)', () => {
  it('resolves configured checkout fields and fallback defaults cleanly', () => {
    const custom = parsePlanHandleConfig({
      fields: [
        { key: 'usernameOrEmail', required: true, validate: 'email' },
        { key: 'password', required: true },
        { key: 'twoFactor', required: false },
        { key: 'password', required: false }, // duplicate key ignored
      ],
      instructionVi: 'Nhập đúng thông tin',
    });

    assert.equal(custom.fields?.length, 3);
    assert.equal(custom.fields?.[0]?.validate, 'email');
    assert.equal(custom.fields?.[2]?.required, false);
    assert.equal(custom.instructionVi, 'Nhập đúng thông tin');

    // CUSTOMER_ACCOUNT without explicit fields falls back to usernameOrEmail
    const fallbackCustomerFields = resolveCheckoutFields(
      PlanHandleType.CUSTOMER_ACCOUNT,
      {},
    );
    assert.equal(fallbackCustomerFields.length, 1);
    assert.equal(fallbackCustomerFields[0]?.key, 'usernameOrEmail');

    // LINK / PROVIDED_ACCOUNT / OTHER default to no pre-QR input
    assert.deepEqual(resolveCheckoutFields(PlanHandleType.LINK, {}), []);
    assert.deepEqual(resolveCheckoutFields(PlanHandleType.PROVIDED_ACCOUNT, {}), []);
    assert.deepEqual(resolveCheckoutFields(PlanHandleType.OTHER, {}), []);
  });

  it('validates deliveryData strictly by PlanHandleType', () => {
    assert.throws(
      () => validateAndNormalizeDeliveryData(PlanHandleType.LINK, { link: 'not-a-url' }),
      BadRequestException,
    );
    assert.deepEqual(
      validateAndNormalizeDeliveryData(PlanHandleType.LINK, {
        link: ' https://example.com/invite/123 ',
        note: 'Mở link để xác nhận',
      }),
      { link: 'https://example.com/invite/123', note: 'Mở link để xác nhận' },
    );

    assert.throws(
      () =>
        validateAndNormalizeDeliveryData(PlanHandleType.PROVIDED_ACCOUNT, {
          username: 'acc1',
        }),
      BadRequestException,
    );
    assert.deepEqual(
      validateAndNormalizeDeliveryData(PlanHandleType.PROVIDED_ACCOUNT, {
        username: 'acc1',
        password: 'pw1',
        twoFactor: 'CODE99',
      }),
      { username: 'acc1', password: 'pw1', twoFactor: 'CODE99' },
    );

    assert.equal(
      validateAndNormalizeDeliveryData(PlanHandleType.OTHER, {}),
      null,
    );
    assert.deepEqual(
      validateAndNormalizeDeliveryData(PlanHandleType.CUSTOMER_ACCOUNT, {}, 'Đã nâng cấp'),
      { note: 'Đã nâng cấp' },
    );

    assert.throws(
      () => validateAndNormalizeDeliveryData(PlanHandleType.OTHER, ['not-an-object']),
      BadRequestException,
    );
    assert.throws(
      () => validateAndNormalizeDeliveryData(PlanHandleType.OTHER, { note: 'x'.repeat(1501) }),
      BadRequestException,
    );
  });

  it('rejects malformed query and body types in AdminOrdersController with 400 instead of 500', async () => {
    const controller = new AdminOrdersController(
      {
        listAdminOrders: async () => [],
        completeOrder: async () => {
          throw new Error('Should not reach service on malformed body');
        },
      } as unknown as OrdersService,
      {} as unknown as PrismaService,
    );

    await assert.rejects(
      () => controller.listOrders(['PAID', 'PENDING']),
      BadRequestException,
    );
    await assert.rejects(
      () => controller.listOrders('UNKNOWN_STATUS'),
      BadRequestException,
    );
    await assert.rejects(
      () => controller.completeOrder(randomUUID(), ['invalid-array']),
      BadRequestException,
    );

    const realOrdersService = new OrdersService(
      {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: async () => [
              {
                id: 'ord-1',
                userId: 'user-1',
                planId: 'plan-1',
                status: OrderStatus.PAID,
                stockReserved: true,
                stockReleasedAt: null,
              },
            ],
            order: {
              findUniqueOrThrow: async () => ({
                id: 'ord-1',
                orderCode: 'GS1234567890',
                status: OrderStatus.PAID,
                handleType: PlanHandleType.OTHER,
                user: { telegramId: 123n, languageCode: 'vi' },
                plan: { nameVi: 'Gói 1', nameEn: 'Plan 1', durationDays: 30, product: { name: 'P1' } },
                subscription: null,
                fulfillment: null,
              }),
            },
          }),
      } as unknown as PrismaService,
      {} as unknown as TelegramOutboxService,
    );
    const wiredController = new AdminOrdersController(realOrdersService, {} as unknown as PrismaService);

    await assert.rejects(
      () => wiredController.completeOrder(randomUUID(), { targetEmail: 12345 }),
      BadRequestException,
    );
    await assert.rejects(
      () => wiredController.completeOrder(randomUUID(), { note: { nested: true } }),
      BadRequestException,
    );
  });
});

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe(
  'PlanHandleType & OrderFulfillment DB Integration',
  { skip: !hasDatabase },
  () => {
    const prisma = new PrismaService();
    const outbox = new TelegramOutboxService(prisma);
    const ordersService = new OrdersService(prisma, outbox);
    const reconciliationService = new PaymentReconciliationService(prisma, outbox);
    const adminController = new AdminOrdersController(ordersService, prisma);

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
      process.env.TELEGRAM_ADMIN_CHAT_ID = '9999990002';
      await prisma.$connect();

      const user = await prisma.user.create({
        data: {
          telegramId: BigInt(Date.now() + 500_000),
          firstName: 'HandleTypeUser',
          username: `handle_${runSuffix}`,
          languageCode: 'vi',
        },
      });
      createdUserIds.push(user.id);
      testUserId = user.id;

      const product = await prisma.product.create({
        data: {
          name: `HandleType Product ${runSuffix}`,
          slug: `handle-product-${runSuffix}`,
          isActive: true,
        },
      });
      createdProductIds.push(product.id);
      testProductId = product.id;
    });

    after(async () => {
      process.env.TELEGRAM_ADMIN_CHAT_ID = originalAdminChatId;
      outbox.stopPolling();
      outbox.registerSender(null);

      if (createdOrderIds.length > 0 || createdPaymentIds.length > 0) {
        await prisma.telegramNotification.deleteMany({
          where: {
            OR: [
              createdOrderIds.length > 0 ? { orderId: { in: createdOrderIds } } : undefined,
              createdPaymentIds.length > 0
                ? { paymentId: { in: createdPaymentIds } }
                : undefined,
            ].filter((x): x is NonNullable<typeof x> => Boolean(x)),
          },
        });
      }
      if (createdOrderIds.length > 0) {
        await prisma.subscription.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        await prisma.payment.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        await prisma.orderFulfillment.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
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

    async function createPlan(
      handleType: PlanHandleType,
      handleConfig: Record<string, unknown> = {},
      durationDays = 30,
    ) {
      const plan = await prisma.plan.create({
        data: {
          productId: testProductId,
          code: `HT_${handleType}_${randomUUID().slice(0, 6).toUpperCase()}`,
          nameVi: `Gói ${handleType}`,
          nameEn: `Plan ${handleType}`,
          price: 100_000n,
          currency: 'VND',
          durationDays,
          warrantyDays: 30,
          stockQuantity: 5,
          handleType,
          handleConfig: handleConfig as Prisma.InputJsonValue,
          isActive: true,
        },
      });
      createdPlanIds.push(plan.id);
      return plan;
    }

    async function payOrder(orderCode: string) {
      const res = await reconciliationService.reconcile({
        provider: PaymentProvider.VIETQR,
        providerTransactionId: `ht-tx-${randomUUID()}`,
        referenceCode: `FT${runSuffix}${randomUUID().slice(0, 4)}`,
        bankAccount: '0123456789',
        expectedBankAccount: '0123456789',
        amount: 100_000n,
        currency: 'VND',
        transType: 'C',
        content: orderCode,
        orderCodeHint: orderCode,
        transactionAt: new Date(),
        receivedAt: new Date(),
        rawPayload: { orderId: orderCode },
      });
      createdPaymentIds.push(res.paymentId);
      assert.equal(res.outcome, 'VERIFIED');
      return res;
    }

    it('handles CUSTOMER_ACCOUNT end-to-end: validates required fields, hides password in list/Telegram, exposes in admin detail', async () => {
      const plan = await createPlan(PlanHandleType.CUSTOMER_ACCOUNT, {
        fields: [
          { key: 'usernameOrEmail', required: true, validate: 'email' },
          { key: 'password', required: true, validate: 'text' },
          { key: 'twoFactor', required: false, validate: 'text' },
        ],
      });

      await assert.rejects(
        () =>
          ordersService.createPendingOrder({
            userId: testUserId,
            planId: plan.id,
            customerInput: { usernameOrEmail: 'client@example.com' },
          }),
        (err: unknown) =>
          err instanceof OrderDomainError && err.code === 'CUSTOMER_INPUT_REQUIRED',
      );

      const order = await ordersService.createPendingOrder({
        userId: testUserId,
        planId: plan.id,
        customerInput: {
          usernameOrEmail: 'client@example.com',
          password: 'PlainPassword#2026',
          twoFactor: '2FA-BACKUP-777',
        },
      });
      createdOrderIds.push(order.id);

      assert.equal(order.handleType, PlanHandleType.CUSTOMER_ACCOUNT);
      assert.equal(order.targetEmail, 'client@example.com');

      await payOrder(order.orderCode);

      // Admin Telegram outbox MUST NOT leak raw password or 2FA
      const adminNotif = await prisma.telegramNotification.findUniqueOrThrow({
        where: { dedupeKey: `order_paid_admin:${order.id}` },
      });
      const adminMsg = (adminNotif.payload as { text: string }).text;
      assert.ok(adminMsg.includes('CUSTOMER_ACCOUNT'));
      assert.ok(adminMsg.includes('client@example.com'));
      assert.equal(adminMsg.includes('PlainPassword#2026'), false);
      assert.equal(adminMsg.includes('2FA-BACKUP-777'), false);

      // Admin listOrders hides raw password/2FA while Admin detail exposes full customerInput
      const list = await adminController.listOrders(OrderStatus.PAID);
      const listItem = list.find((item) => item.id === order.id);
      assert.ok(listItem);
      assert.equal(listItem.handleType, PlanHandleType.CUSTOMER_ACCOUNT);
      assert.equal(listItem.fulfillmentSummary.hasCustomerInput, true);
      assert.equal(JSON.stringify(listItem).includes('PlainPassword#2026'), false);

      const detail = await adminController.getOrderDetail(order.id);
      assert.deepEqual(detail.fulfillment?.customerInput, {
        usernameOrEmail: 'client@example.com',
        password: 'PlainPassword#2026',
        twoFactor: '2FA-BACKUP-777',
      });

      // Complete order -> creates Subscription & customer outbox without echoing password
      const completed = await adminController.completeOrder(order.id, {
        note: 'Đã nâng cấp xong',
      });
      assert.equal(completed.status, OrderStatus.COMPLETED);
      assert.equal(completed.subscription?.targetEmail, 'client@example.com');
      assert.equal(completed.subscription?.accountIdentifier, 'client@example.com');

      const customerNotif = await prisma.telegramNotification.findUniqueOrThrow({
        where: { dedupeKey: `order_completed_customer:${order.id}` },
      });
      const customerMsg = (customerNotif.payload as { text: string }).text;
      assert.ok(customerMsg.includes('client@example.com'));
      assert.ok(customerMsg.includes('Đã nâng cấp xong'));
      assert.equal(customerMsg.includes('PlainPassword#2026'), false);
    });

    it('handles LINK plan without customer targetEmail and creates nullable Subscription', async () => {
      const plan = await createPlan(PlanHandleType.LINK, {}, 30);
      const order = await ordersService.createPendingOrder({
        userId: testUserId,
        planId: plan.id,
      });
      createdOrderIds.push(order.id);
      assert.equal(order.handleType, PlanHandleType.LINK);
      assert.equal(order.targetEmail, null);

      await payOrder(order.orderCode);

      await assert.rejects(
        () => ordersService.completeOrder(order.id, {}),
        BadRequestException,
      );

      const completed = await ordersService.completeOrder(order.id, {
        deliveryData: {
          link: 'https://invite.example.com/confirm/xyz',
          note: 'Bấm vào link trong 24h',
        },
      });
      assert.equal(completed.order.status, OrderStatus.COMPLETED);
      assert.ok(completed.subscription);
      assert.equal(completed.subscription.status, SubscriptionStatus.ACTIVE);
      assert.equal(completed.subscription.targetEmail, null);
      assert.equal(completed.subscription.accountIdentifier, null);

      const customerNotif = await prisma.telegramNotification.findUniqueOrThrow({
        where: { dedupeKey: `order_completed_customer:${order.id}` },
      });
      const customerMsg = (customerNotif.payload as { text: string }).text;
      assert.ok(customerMsg.includes('https://invite.example.com/confirm/xyz'));
    });

    it('handles PROVIDED_ACCOUNT plan and stores provided username as accountIdentifier', async () => {
      const plan = await createPlan(PlanHandleType.PROVIDED_ACCOUNT, {}, 90);
      const order = await ordersService.createPendingOrder({
        userId: testUserId,
        planId: plan.id,
      });
      createdOrderIds.push(order.id);

      await payOrder(order.orderCode);

      await assert.rejects(
        () =>
          ordersService.completeOrder(order.id, {
            deliveryData: { username: 'shop_user_only' },
          }),
        BadRequestException,
      );

      const completed = await ordersService.completeOrder(order.id, {
        deliveryData: {
          username: 'shop_acc_01@domain.com',
          password: 'ShopSuppliedPass!1',
          twoFactor: 'SHOP-2FA-99',
        },
      });
      assert.equal(completed.order.status, OrderStatus.COMPLETED);
      assert.ok(completed.subscription);
      assert.equal(completed.subscription.targetEmail, null);
      assert.equal(completed.subscription.accountIdentifier, 'shop_acc_01@domain.com');

      const customerNotif = await prisma.telegramNotification.findUniqueOrThrow({
        where: { dedupeKey: `order_completed_customer:${order.id}` },
      });
      const customerMsg = (customerNotif.payload as { text: string }).text;
      assert.ok(customerMsg.includes('shop_acc_01@domain.com'));
      assert.ok(customerMsg.includes('ShopSuppliedPass!1'));
      assert.ok(customerMsg.includes('SHOP-2FA-99'));
    });

    it('handles OTHER plan with optional note and creates Subscription when durationDays > 0', async () => {
      const plan = await createPlan(PlanHandleType.OTHER, {}, 15);
      const order = await ordersService.createPendingOrder({
        userId: testUserId,
        planId: plan.id,
      });
      createdOrderIds.push(order.id);

      await payOrder(order.orderCode);

      const completed = await ordersService.completeOrder(order.id, {
        note: 'Hoàn tất theo yêu cầu riêng',
      });
      assert.equal(completed.order.status, OrderStatus.COMPLETED);
      assert.ok(completed.subscription);
      assert.equal(completed.subscription.targetEmail, null);
      assert.deepEqual(completed.fulfillment?.deliveryData, {
        note: 'Hoàn tất theo yêu cầu riêng',
      });
    });
  },
);
