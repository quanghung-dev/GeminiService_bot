import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentProvider,
  PlanHandleType,
  Prisma,
  SubscriptionStatus,
  type Order,
  type OrderFulfillment,
  type Subscription,
} from '../generated/prisma/client.js';
import { TelegramOutboxService } from '../notifications/telegram-outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type CustomerOrderInput,
  type DeliveryOrderData,
  isValidEmail,
  parseCustomerOrderInput,
  parsePlanHandleConfig,
  resolveCheckoutFields,
  toInputJsonValue,
  validateAndNormalizeDeliveryData,
} from './handle-type.types.js';
import { generateOrderCode } from './order-code.js';

export { isValidEmail };

export type OrderDomainErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'OUT_OF_STOCK'
  | 'EMAIL_REQUIRED'
  | 'INVALID_EMAIL'
  | 'CUSTOMER_INPUT_REQUIRED';

export class OrderDomainError extends Error {
  constructor(
    public readonly code: OrderDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrderDomainError';
  }
}

export interface CreatePendingOrderInput {
  userId: string;
  planId: string;
  targetEmail?: string | null;
  customerInput?: CustomerOrderInput | null;
  paymentProvider?: PaymentProvider;
  paymentContent?: string | null;
  expiresMinutes?: number;
}

export interface VietqrOrderPaymentDetails {
  paymentProvider?: PaymentProvider;
  paymentContent: string;
  paymentQrCode?: string | null;
  paymentQrLink?: string | null;
  paymentVaAccount?: string | null;
  paymentProviderRef?: string | null;
}

export interface CompleteOrderInput {
  targetEmail?: string;
  note?: string;
  deliveryData?: unknown;
}

export interface CompleteOrderResult {
  order: Order;
  subscription: Subscription | null;
  fulfillment: OrderFulfillment | null;
  alreadyCompleted: boolean;
}

interface LockedOrderRow {
  id: string;
  userId: string;
  planId: string;
  status: string;
  stockReserved: boolean;
  stockReleasedAt: Date | null;
}

export function getDefaultOrderExpiresMinutes(
  raw: string | undefined = process.env.ORDER_EXPIRES_MINUTES,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return 30;
  if (!/^\d+$/.test(trimmed)) return 30;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1440) return 30;
  return parsed;
}

function isUniqueViolationOn(error: unknown, targetSubstring: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const metaTarget = error.meta?.target;
  if (Array.isArray(metaTarget)) {
    return metaTarget.some((item) => String(item).includes(targetSubstring));
  }
  return String(metaTarget ?? '').includes(targetSubstring);
}

function buildOrderCompletedCustomerMessage(params: {
  isEnglish: boolean;
  orderCode: string;
  productName: string;
  planName: string;
  handleType: PlanHandleType;
  deliveryData: DeliveryOrderData | null;
  accountIdentifier: string | null;
  subscription: Subscription | null;
  note?: string;
}): string {
  const {
    isEnglish,
    orderCode,
    productName,
    planName,
    handleType,
    deliveryData,
    accountIdentifier,
    subscription,
    note,
  } = params;

  const lines: string[] = [
    isEnglish
      ? `🎉 Order ${orderCode} (${productName} - ${planName}) is COMPLETED!`
      : `🎉 Đơn hàng ${orderCode} (${productName} - ${planName}) đã được kích hoạt & hoàn tất!`,
  ];

  if (handleType === PlanHandleType.LINK && deliveryData && 'link' in deliveryData) {
    lines.push(
      isEnglish
        ? `🔗 Confirmation link: ${deliveryData.link}`
        : `🔗 Link xác nhận: ${deliveryData.link}`,
    );
  } else if (
    handleType === PlanHandleType.PROVIDED_ACCOUNT
    && deliveryData
    && 'username' in deliveryData
  ) {
    lines.push(
      isEnglish
        ? `👤 Account: ${deliveryData.username}`
        : `👤 Tài khoản: ${deliveryData.username}`,
      isEnglish
        ? `🔑 Password: ${deliveryData.password}`
        : `🔑 Mật khẩu: ${deliveryData.password}`,
    );
    if (deliveryData.twoFactor) {
      lines.push(`🔐 2FA: ${deliveryData.twoFactor}`);
    }
  } else if (handleType === PlanHandleType.CUSTOMER_ACCOUNT && accountIdentifier) {
    lines.push(
      isEnglish
        ? `👤 Activated account: ${accountIdentifier}`
        : `👤 Tài khoản kích hoạt: ${accountIdentifier}`,
    );
  } else if (accountIdentifier) {
    lines.push(
      isEnglish
        ? `📧 Account/Email: ${accountIdentifier}`
        : `📧 Tài khoản/Email: ${accountIdentifier}`,
    );
  }

  if (subscription) {
    const validUntil = subscription.expiresAt.toISOString().slice(0, 10);
    lines.push(
      isEnglish ? `📅 Valid until: ${validUntil}` : `📅 Hạn sử dụng đến: ${validUntil}`,
    );
  }

  const resolvedNote = deliveryData?.note?.trim() || note?.trim();
  if (resolvedNote) {
    lines.push(isEnglish ? `📝 Note: ${resolvedNote}` : `📝 Ghi chú: ${resolvedNote}`);
  }

  return lines.join('\n');
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: TelegramOutboxService,
  ) {}

  async createPendingOrder(input: CreatePendingOrderInput): Promise<Order> {
    const trimmedEmail = input.targetEmail?.trim() || null;
    if (trimmedEmail && !isValidEmail(trimmedEmail)) {
      throw new OrderDomainError('INVALID_EMAIL', 'Invalid target email address');
    }

    const normalizedInput: CustomerOrderInput =
      parseCustomerOrderInput(input.customerInput) ?? {};
    if (trimmedEmail && !normalizedInput.usernameOrEmail) {
      normalizedInput.usernameOrEmail = trimmedEmail;
    }

    const expiresMinutes = input.expiresMinutes ?? getDefaultOrderExpiresMinutes();

    for (let attempt = 0; attempt < 3; attempt++) {
      const orderCode = generateOrderCode();
      try {
        return await this.prisma.$transaction(async (tx) => {
          const plan = await tx.plan.findFirst({
            where: {
              id: input.planId,
              isActive: true,
              product: { isActive: true },
            },
            include: { product: true },
          });

          if (!plan) {
            throw new OrderDomainError('PLAN_NOT_FOUND', 'Plan is not found or inactive');
          }

          const checkoutFields = resolveCheckoutFields(plan.handleType, plan.handleConfig);
          for (const field of checkoutFields) {
            const fieldValue = normalizedInput[field.key];
            if (field.required && !fieldValue) {
              if (field.key === 'usernameOrEmail' && field.validate === 'email') {
                throw new OrderDomainError(
                  'EMAIL_REQUIRED',
                  'Target email is required for this plan',
                );
              }
              throw new OrderDomainError(
                'CUSTOMER_INPUT_REQUIRED',
                `Required checkout field "${field.key}" is missing for this plan`,
              );
            }
            if (fieldValue && field.validate === 'email' && !isValidEmail(fieldValue)) {
              throw new OrderDomainError('INVALID_EMAIL', 'Invalid target email address');
            }
          }

          const resolvedTargetEmail =
            trimmedEmail
            ?? (normalizedInput.usernameOrEmail && isValidEmail(normalizedInput.usernameOrEmail)
              ? normalizedInput.usernameOrEmail
              : null);

          const hasCustomerInput = Object.keys(normalizedInput).length > 0;
          const now = new Date();

          // Atomic stock reservation guarded by stockQuantity > 0 and PostgreSQL CHECK (>= 0)
          const reserved = await tx.plan.updateMany({
            where: {
              id: plan.id,
              isActive: true,
              stockQuantity: { gt: 0 },
            },
            data: {
              stockQuantity: { decrement: 1 },
              updatedAt: now,
            },
          });

          if (reserved.count === 0) {
            throw new OrderDomainError('OUT_OF_STOCK', 'Selected plan is out of stock');
          }

          const expiresAt = new Date(now.getTime() + expiresMinutes * 60_000);
          return tx.order.create({
            data: {
              orderCode,
              userId: input.userId,
              planId: plan.id,
              targetEmail: resolvedTargetEmail,
              handleType: plan.handleType,
              totalAmount: plan.price,
              currency: plan.currency,
              status: OrderStatus.PENDING,
              expiresAt,
              paymentProvider: input.paymentProvider ?? PaymentProvider.VIETQR,
              paymentContent: input.paymentContent?.trim() || orderCode,
              stockReserved: true,
              stockReleasedAt: null,
              createdAt: now,
              updatedAt: now,
              planSnapshot: {
                productId: plan.product.id,
                productName: plan.product.name,
                productSlug: plan.product.slug,
                planId: plan.id,
                planCode: plan.code,
                nameVi: plan.nameVi,
                nameEn: plan.nameEn,
                price: plan.price.toString(),
                currency: plan.currency,
                durationDays: plan.durationDays,
                warrantyDays: plan.warrantyDays,
                handleType: plan.handleType,
                handleConfig: toInputJsonValue(parsePlanHandleConfig(plan.handleConfig)),
              },
              ...(hasCustomerInput
                ? {
                    fulfillment: {
                      create: {
                        handleType: plan.handleType,
                        customerInput: toInputJsonValue(normalizedInput),
                        createdAt: now,
                        updatedAt: now,
                      },
                    },
                  }
                : {}),
            },
          });
        });
      } catch (error) {
        if (isUniqueViolationOn(error, 'order_code') && attempt < 2) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Failed to generate a unique order code');
  }

  async attachVietqrPaymentDetails(
    orderId: string,
    details: VietqrOrderPaymentDetails,
  ): Promise<Order> {
    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        paymentProvider: details.paymentProvider ?? PaymentProvider.VIETQR,
        paymentContent: details.paymentContent,
        paymentQrCode: details.paymentQrCode ?? null,
        paymentQrLink: details.paymentQrLink ?? null,
        paymentVaAccount: details.paymentVaAccount ?? null,
        paymentProviderRef: details.paymentProviderRef ?? null,
        updatedAt: new Date(),
      },
    });
  }

  async cancelPendingOrder(
    orderId: string,
    expectedUserId?: string,
    reason?: string,
  ): Promise<{ cancelled: boolean; status: OrderStatus }> {
    return this.prisma.$transaction(async (tx) => {
      // Row-level lock prevents races between cancel, expiration sweeper, and payment webhook.
      const [locked] = await tx.$queryRaw<LockedOrderRow[]>`
        SELECT
          id,
          user_id AS "userId",
          plan_id AS "planId",
          status::text AS status,
          stock_reserved AS "stockReserved",
          stock_released_at AS "stockReleasedAt"
        FROM public.orders
        WHERE id = ${orderId}::uuid
        FOR UPDATE
      `;

      if (!locked) {
        throw new NotFoundException('Order not found');
      }
      if (expectedUserId && locked.userId !== expectedUserId) {
        throw new ForbiddenException('Order does not belong to user');
      }
      if (locked.status !== OrderStatus.PENDING) {
        return { cancelled: false, status: locked.status as OrderStatus };
      }

      const now = new Date();
      const shouldReleaseStock = locked.stockReserved && locked.stockReleasedAt === null;

      await tx.order.update({
        where: { id: locked.id },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          failureReason: reason ?? null,
          stockReleasedAt: shouldReleaseStock ? now : locked.stockReleasedAt,
          updatedAt: now,
        },
      });

      if (shouldReleaseStock) {
        await tx.plan.update({
          where: { id: locked.planId },
          data: {
            stockQuantity: { increment: 1 },
            updatedAt: now,
          },
        });
      }

      return { cancelled: true, status: OrderStatus.CANCELLED };
    });
  }

  async expireDueOrders(batchSize = 50): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // FOR UPDATE SKIP LOCKED avoids blocking concurrent payment webhooks or user cancellations.
      const dueOrders = await tx.$queryRaw<LockedOrderRow[]>`
        SELECT
          id,
          user_id AS "userId",
          plan_id AS "planId",
          status::text AS status,
          stock_reserved AS "stockReserved",
          stock_released_at AS "stockReleasedAt"
        FROM public.orders
        WHERE status = 'PENDING'::public.order_status
          AND expires_at <= now()
        ORDER BY expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      `;

      const now = new Date();
      for (const order of dueOrders) {
        const shouldReleaseStock = order.stockReserved && order.stockReleasedAt === null;
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.EXPIRED,
            stockReleasedAt: shouldReleaseStock ? now : order.stockReleasedAt,
            updatedAt: now,
          },
        });

        if (shouldReleaseStock) {
          await tx.plan.update({
            where: { id: order.planId },
            data: {
              stockQuantity: { increment: 1 },
              updatedAt: now,
            },
          });
        }
      }

      return dueOrders.length;
    });
  }

  async startProcessingOrder(orderId: string): Promise<Order> {
    const result = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<LockedOrderRow[]>`
        SELECT
          id,
          user_id AS "userId",
          plan_id AS "planId",
          status::text AS status,
          stock_reserved AS "stockReserved",
          stock_released_at AS "stockReleasedAt"
        FROM public.orders
        WHERE id = ${orderId}::uuid
        FOR UPDATE
      `;

      if (!locked) {
        throw new NotFoundException('Order not found');
      }

      const fullOrder = await tx.order.findUniqueOrThrow({
        where: { id: locked.id },
        include: { user: true, plan: { include: { product: true } } },
      });

      if (locked.status === OrderStatus.PROCESSING) {
        return { order: fullOrder, enqueued: false };
      }

      if (locked.status !== OrderStatus.PAID) {
        throw new ConflictException(
          `Order ${fullOrder.orderCode} cannot move to PROCESSING from ${locked.status}`,
        );
      }

      const now = new Date();
      const updated = await tx.order.update({
        where: { id: fullOrder.id },
        data: {
          status: OrderStatus.PROCESSING,
          updatedAt: now,
        },
      });

      const isEnglish = fullOrder.user.languageCode === 'en';
      const planName = isEnglish ? fullOrder.plan.nameEn : fullOrder.plan.nameVi;
      const text = isEnglish
        ? `⏳ Order ${fullOrder.orderCode} (${fullOrder.plan.product.name} - ${planName}) is now being processed by our team.`
        : `⏳ Đơn hàng ${fullOrder.orderCode} (${fullOrder.plan.product.name} - ${planName}) đã được Admin tiếp nhận và đang xử lý.`;

      await this.outbox.enqueue(tx, {
        dedupeKey: `order_processing_customer:${fullOrder.id}`,
        chatId: fullOrder.user.telegramId,
        notificationType: 'ORDER_PROCESSING_CUSTOMER',
        orderId: fullOrder.id,
        text,
      });

      return { order: updated, enqueued: true };
    });

    if (result.enqueued) {
      this.outbox.triggerDispatch();
    }
    return result.order;
  }

  async completeOrder(
    orderId: string,
    input: CompleteOrderInput = {},
  ): Promise<CompleteOrderResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<LockedOrderRow[]>`
        SELECT
          id,
          user_id AS "userId",
          plan_id AS "planId",
          status::text AS status,
          stock_reserved AS "stockReserved",
          stock_released_at AS "stockReleasedAt"
        FROM public.orders
        WHERE id = ${orderId}::uuid
        FOR UPDATE
      `;

      if (!locked) {
        throw new NotFoundException('Order not found');
      }

      const fullOrder = await tx.order.findUniqueOrThrow({
        where: { id: locked.id },
        include: {
          user: true,
          plan: { include: { product: true } },
          subscription: true,
          fulfillment: true,
        },
      });

      if (locked.status === OrderStatus.COMPLETED) {
        return {
          order: fullOrder,
          subscription: fullOrder.subscription,
          fulfillment: fullOrder.fulfillment,
          alreadyCompleted: true,
        };
      }

      if (locked.status !== OrderStatus.PAID && locked.status !== OrderStatus.PROCESSING) {
        throw new ConflictException(
          `Order ${fullOrder.orderCode} cannot move to COMPLETED from ${locked.status}`,
        );
      }

      if (input.targetEmail !== undefined && typeof input.targetEmail !== 'string') {
        throw new BadRequestException('targetEmail must be a string');
      }
      if (input.note !== undefined && typeof input.note !== 'string') {
        throw new BadRequestException('note must be a string');
      }

      const providedEmail = input.targetEmail?.trim();
      if (providedEmail && !isValidEmail(providedEmail)) {
        throw new BadRequestException('Invalid targetEmail');
      }

      const deliveryData = validateAndNormalizeDeliveryData(
        fullOrder.handleType,
        input.deliveryData,
        input.note,
      );
      const customerInput = parseCustomerOrderInput(fullOrder.fulfillment?.customerInput);

      const effectiveEmail =
        providedEmail
        || fullOrder.targetEmail
        || (customerInput?.usernameOrEmail && isValidEmail(customerInput.usernameOrEmail)
          ? customerInput.usernameOrEmail
          : null);

      let accountIdentifier: string | null = null;
      if (
        fullOrder.handleType === PlanHandleType.PROVIDED_ACCOUNT
        && deliveryData
        && 'username' in deliveryData
      ) {
        accountIdentifier = deliveryData.username;
      } else if (fullOrder.handleType === PlanHandleType.CUSTOMER_ACCOUNT) {
        accountIdentifier = customerInput?.usernameOrEmail || effectiveEmail || null;
      } else {
        accountIdentifier = effectiveEmail || null;
      }

      const now = new Date();
      let fulfillment = fullOrder.fulfillment;
      if (deliveryData !== null) {
        const deliveryJson = toInputJsonValue(deliveryData);
        fulfillment = await tx.orderFulfillment.upsert({
          where: { orderId: fullOrder.id },
          create: {
            orderId: fullOrder.id,
            handleType: fullOrder.handleType,
            deliveryData: deliveryJson,
            createdAt: now,
            updatedAt: now,
          },
          update: {
            deliveryData: deliveryJson,
            updatedAt: now,
          },
        });
      }

      const isSubscriptionPlan = fullOrder.plan.durationDays > 0;
      let subscription = fullOrder.subscription;
      if (isSubscriptionPlan && !subscription) {
        // Subscription validity starts from actual activation time, not payment time.
        const expiresAt = new Date(now.getTime() + fullOrder.plan.durationDays * 86_400_000);
        subscription = await tx.subscription.create({
          data: {
            orderId: fullOrder.id,
            targetEmail: effectiveEmail,
            accountIdentifier,
            status: SubscriptionStatus.ACTIVE,
            activatedAt: now,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const updatedOrder = await tx.order.update({
        where: { id: fullOrder.id },
        data: {
          status: OrderStatus.COMPLETED,
          completedAt: now,
          targetEmail: effectiveEmail,
          updatedAt: now,
        },
      });

      const isEnglish = fullOrder.user.languageCode === 'en';
      const planName = isEnglish ? fullOrder.plan.nameEn : fullOrder.plan.nameVi;
      const text = buildOrderCompletedCustomerMessage({
        isEnglish,
        orderCode: fullOrder.orderCode,
        productName: fullOrder.plan.product.name,
        planName,
        handleType: fullOrder.handleType,
        deliveryData,
        accountIdentifier,
        subscription,
        note: input.note,
      });

      await this.outbox.enqueue(tx, {
        dedupeKey: `order_completed_customer:${fullOrder.id}`,
        chatId: fullOrder.user.telegramId,
        notificationType: 'ORDER_COMPLETED_CUSTOMER',
        orderId: fullOrder.id,
        text,
      });

      return {
        order: updatedOrder,
        subscription,
        fulfillment,
        alreadyCompleted: false,
      };
    });

    if (!result.alreadyCompleted) {
      this.outbox.triggerDispatch();
    }
    return result;
  }

  async countUserOrders(userId: string): Promise<number> {
    return this.prisma.order.count({ where: { userId } });
  }

  async listUserOrders(userId: string, limit = 10, offset = 0) {
    return this.prisma.order.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
      include: {
        plan: {
          include: { product: true },
        },
        subscription: true,
        fulfillment: true,
      },
    });
  }

  async listAdminOrders(status?: OrderStatus, limit = 50) {
    return this.prisma.order.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: true,
        plan: { include: { product: true } },
        payments: true,
        subscription: true,
        fulfillment: true,
      },
    });
  }

  async getAdminOrderById(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        plan: { include: { product: true } },
        payments: true,
        subscription: true,
        fulfillment: true,
      },
    });
  }

  async getOrderForUser(orderId: string, userId: string) {
    return this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        plan: { include: { product: true } },
        subscription: true,
        fulfillment: true,
      },
    });
  }
}
