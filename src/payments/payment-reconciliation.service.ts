import { Injectable, Logger } from '@nestjs/common';
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '../generated/prisma/client.js';
import {
  parseAdminChatId,
  TelegramOutboxService,
} from '../notifications/telegram-outbox.service.js';
import { extractOrderCodeFromContent } from '../orders/order-code.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  IncomingBankTransaction,
  PaymentReconciliationResult,
} from './payment-provider.interface.js';

interface LockedOrderForReconciliation {
  id: string;
  orderCode: string;
  userId: string;
  planId: string;
  totalAmount: bigint;
  currency: string;
  status: string;
  expiresAt: Date;
  paymentVaAccount: string | null;
  stockReserved: boolean;
  stockReleasedAt: Date | null;
  targetEmail: string | null;
}

const SENSITIVE_KEY_PATTERN = /(password|secret|token|authorization|cookie|api[-_]?key)/i;

export function sanitizeRawPayload(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) return {};
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRawPayload(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      if (entry === undefined) continue;
      out[key] = sanitizeRawPayload(entry);
    }
    return out;
  }
  return String(value);
}

function formatVnd(amount: bigint, currency: string): string {
  return `${new Intl.NumberFormat('vi-VN').format(amount)} ${currency}`;
}

function isUniqueConstraintError(error: unknown, namePart: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  const serialized = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return serialized.includes(namePart) || error.message.includes(namePart);
}

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: TelegramOutboxService,
  ) {}

  async reconcile(input: IncomingBankTransaction): Promise<PaymentReconciliationResult> {
    const adminChatId = parseAdminChatId();
    const sanitizedPayload = sanitizeRawPayload(input.rawPayload);

    let result: PaymentReconciliationResult;
    let shouldDispatchOutbox = false;

    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        // 1. Idempotency check by (provider, provider_transaction_id)
        const existing = await tx.payment.findUnique({
          where: {
            provider_providerTransactionId: {
              provider: input.provider,
              providerTransactionId: input.providerTransactionId,
            },
          },
          include: { order: { select: { orderCode: true } } },
        });

        if (existing) {
          return {
            reconciled: {
              outcome: 'DUPLICATE' as const,
              paymentId: existing.id,
              paymentStatus: existing.status,
              orderId: existing.orderId,
              orderCode: existing.order?.orderCode ?? null,
              reason: existing.failureReason,
            },
            enqueuedNotification: false,
          };
        }

        const now = new Date();
        const normalizedTransType = input.transType.trim().toUpperCase();

        // 2. Non-credit transactions (e.g. 'D' = Debit / outgoing) never confirm orders
        if (normalizedTransType !== 'C') {
          const payment = await tx.payment.create({
            data: {
              provider: input.provider,
              providerTransactionId: input.providerTransactionId,
              referenceCode: input.referenceCode,
              orderId: null,
              amount: input.amount,
              currency: input.currency,
              content: input.content,
              bankName: input.bankName ?? null,
              bankAccount: input.bankAccount,
              transType: normalizedTransType,
              status: PaymentStatus.REJECTED,
              failureReason: 'NON_CREDIT_TRANSACTION',
              transactionAt: input.transactionAt,
              receivedAt: input.receivedAt,
              rawPayload: sanitizedPayload,
              createdAt: now,
              updatedAt: now,
            },
          });

          return {
            reconciled: {
              outcome: 'REJECTED' as const,
              paymentId: payment.id,
              paymentStatus: payment.status,
              orderId: null,
              orderCode: null,
              reason: 'NON_CREDIT_TRANSACTION',
            },
            enqueuedNotification: false,
          };
        }

        // 3. Resolve candidate order code (from explicit orderId hint or transfer content)
        const candidateCodes = this.collectCandidateOrderCodes(input.orderCodeHint, input.content);
        const lockedOrder = await this.lockOrderByCandidateCodes(tx, candidateCodes);

        // 4. Verify receiving bank account (allow configured bankAccount or order's VietQR VA account)
        const expectedAccount = input.expectedBankAccount?.trim() || null;
        const incomingAccount = input.bankAccount.trim();
        const accountMatchesConfigured =
          !expectedAccount || incomingAccount === expectedAccount;
        const accountMatchesOrderVa =
          Boolean(lockedOrder?.paymentVaAccount)
          && incomingAccount === lockedOrder?.paymentVaAccount;

        if (!accountMatchesConfigured && !accountMatchesOrderVa) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: null,
            orderCode: null,
            reason: 'BANK_ACCOUNT_MISMATCH',
            adminChatId,
            now,
          });
        }

        // 5. Order not found -> record UNMATCHED for Admin manual review
        if (!lockedOrder) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.UNMATCHED,
            orderId: null,
            orderCode: candidateCodes[0] ?? null,
            reason: 'ORDER_NOT_FOUND',
            adminChatId,
            now,
          });
        }

        // 6. Currency mismatch check
        if (lockedOrder.currency.toUpperCase() !== input.currency.toUpperCase()) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: lockedOrder.id,
            orderCode: lockedOrder.orderCode,
            reason: 'CURRENCY_MISMATCH',
            adminChatId,
            now,
          });
        }

        // 7. Order already paid / processing / completed
        if (
          lockedOrder.status === OrderStatus.PAID
          || lockedOrder.status === OrderStatus.PROCESSING
          || lockedOrder.status === OrderStatus.COMPLETED
        ) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: lockedOrder.id,
            orderCode: lockedOrder.orderCode,
            reason: 'ORDER_ALREADY_PAID',
            adminChatId,
            now,
          });
        }

        // 8. Order cancelled or failed
        if (lockedOrder.status === OrderStatus.CANCELLED) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: lockedOrder.id,
            orderCode: lockedOrder.orderCode,
            reason: 'ORDER_CANCELLED',
            adminChatId,
            now,
          });
        }

        if (lockedOrder.status === OrderStatus.FAILED) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: lockedOrder.id,
            orderCode: lockedOrder.orderCode,
            reason: 'ORDER_FAILED',
            adminChatId,
            now,
          });
        }

        // 9. Exact integer BigInt amount validation (NO floating-point math)
        if (input.amount < lockedOrder.totalAmount) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: lockedOrder.id,
            orderCode: lockedOrder.orderCode,
            reason: `AMOUNT_UNDERPAID (received=${input.amount.toString()}, expected=${lockedOrder.totalAmount.toString()})`,
            adminChatId,
            now,
          });
        }

        if (input.amount > lockedOrder.totalAmount) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: lockedOrder.id,
            orderCode: lockedOrder.orderCode,
            reason: `AMOUNT_OVERPAID (received=${input.amount.toString()}, expected=${lockedOrder.totalAmount.toString()})`,
            adminChatId,
            now,
          });
        }

        // 10. Distinguish actual bank transaction time vs webhook arrival time:
        // Do NOT reject solely because the webhook arrived late if customer paid on time.
        if (input.transactionAt.getTime() > lockedOrder.expiresAt.getTime()) {
          return this.recordExceptionPayment(tx, {
            input,
            sanitizedPayload,
            status: PaymentStatus.REJECTED,
            orderId: lockedOrder.id,
            orderCode: lockedOrder.orderCode,
            reason: 'ORDER_EXPIRED',
            adminChatId,
            now,
          });
        }

        // 11. Handle stock reservation state:
        // - If order is still PENDING with reserved stock: use the already-reserved slot (do NOT decrement twice).
        // - If order was already EXPIRED by sweeper (stock released) but customer paid within expires_at:
        //   try to re-reserve 1 slot atomically; if out of stock, record payment for manual handling.
        const needsStockReReservation =
          lockedOrder.status === OrderStatus.EXPIRED
          || !lockedOrder.stockReserved
          || lockedOrder.stockReleasedAt !== null;

        if (needsStockReReservation) {
          const reReserved = await tx.plan.updateMany({
            where: {
              id: lockedOrder.planId,
              isActive: true,
              stockQuantity: { gt: 0 },
            },
            data: {
              stockQuantity: { decrement: 1 },
              updatedAt: now,
            },
          });

          if (reReserved.count === 0) {
            return this.recordExceptionPayment(tx, {
              input,
              sanitizedPayload,
              status: PaymentStatus.REJECTED,
              orderId: lockedOrder.id,
              orderCode: lockedOrder.orderCode,
              reason: 'OUT_OF_STOCK_AFTER_LATE_WEBHOOK',
              adminChatId,
              now,
            });
          }
        }

        // 12. Valid payment! Record VERIFIED payment and transition Order -> PAID.
        // Do NOT auto-complete order or create ACTIVE subscription (Admin handles activation).
        const payment = await tx.payment.create({
          data: {
            provider: input.provider,
            providerTransactionId: input.providerTransactionId,
            referenceCode: input.referenceCode,
            orderId: lockedOrder.id,
            amount: input.amount,
            currency: input.currency,
            content: input.content,
            bankName: input.bankName ?? null,
            bankAccount: input.bankAccount,
            transType: normalizedTransType,
            status: PaymentStatus.VERIFIED,
            failureReason: null,
            transactionAt: input.transactionAt,
            verifiedAt: now,
            receivedAt: input.receivedAt,
            rawPayload: sanitizedPayload,
            createdAt: now,
            updatedAt: now,
          },
        });

        await tx.order.update({
          where: { id: lockedOrder.id },
          data: {
            status: OrderStatus.PAID,
            paidAt: input.transactionAt,
            stockReserved: true,
            stockReleasedAt: null,
            updatedAt: now,
          },
        });

        const orderDetails = await tx.order.findUniqueOrThrow({
          where: { id: lockedOrder.id },
          include: {
            user: true,
            plan: { include: { product: true } },
          },
        });

        const isEnglish = orderDetails.user.languageCode === 'en';
        const planName = isEnglish ? orderDetails.plan.nameEn : orderDetails.plan.nameVi;
        const formattedAmount = formatVnd(orderDetails.totalAmount, orderDetails.currency);

        const customerText = isEnglish
          ? [
              `✅ Payment confirmed for order ${orderDetails.orderCode}!`,
              `Product: ${orderDetails.plan.product.name} - ${planName}`,
              `Amount: ${formattedAmount}`,
              orderDetails.targetEmail ? `Email: ${orderDetails.targetEmail}` : null,
              'Your order has been forwarded to Admin for activation/delivery.',
            ]
              .filter(Boolean)
              .join('\n')
          : [
              `✅ Thanh toán thành công cho đơn hàng ${orderDetails.orderCode}!`,
              `Sản phẩm: ${orderDetails.plan.product.name} - ${planName}`,
              `Số tiền: ${formattedAmount}`,
              orderDetails.targetEmail ? `Email kích hoạt: ${orderDetails.targetEmail}` : null,
              'Đơn hàng đã được chuyển cho Admin để tiếp nhận và kích hoạt cho bạn.',
            ]
              .filter(Boolean)
              .join('\n');

        await this.outbox.enqueue(tx, {
          dedupeKey: `order_paid_customer:${orderDetails.id}`,
          chatId: orderDetails.user.telegramId,
          notificationType: 'ORDER_PAID_CUSTOMER',
          orderId: orderDetails.id,
          paymentId: payment.id,
          text: customerText,
        });

        if (adminChatId !== null) {
          const customerHandle = orderDetails.user.username
            ? `@${orderDetails.user.username}`
            : `${orderDetails.user.firstName} (${orderDetails.user.telegramId.toString()})`;
          const adminText = [
            `💰 Đơn hàng mới đã thanh toán: ${orderDetails.orderCode}`,
            `Khách hàng: ${customerHandle}`,
            `Sản phẩm: ${orderDetails.plan.product.name} - ${orderDetails.plan.nameVi}`,
            `Số tiền: ${formattedAmount}`,
            orderDetails.targetEmail ? `Email kích hoạt: ${orderDetails.targetEmail}` : null,
            `Mã GD ngân hàng: ${input.referenceCode ?? input.providerTransactionId}`,
            `Thời gian GD: ${input.transactionAt.toISOString()}`,
            `Trạng thái: PAID (chờ Admin chuyển PROCESSING -> COMPLETED)`,
          ]
            .filter(Boolean)
            .join('\n');

          await this.outbox.enqueue(tx, {
            dedupeKey: `order_paid_admin:${orderDetails.id}`,
            chatId: adminChatId,
            notificationType: 'ORDER_PAID_ADMIN',
            orderId: orderDetails.id,
            paymentId: payment.id,
            text: adminText,
          });
        }

        return {
          reconciled: {
            outcome: 'VERIFIED' as const,
            paymentId: payment.id,
            paymentStatus: payment.status,
            orderId: orderDetails.id,
            orderCode: orderDetails.orderCode,
            reason: null,
          },
          enqueuedNotification: true,
        };
      });

      result = txResult.reconciled;
      shouldDispatchOutbox = txResult.enqueuedNotification;
    } catch (error) {
      // Handle concurrent duplicate webhook race on UNIQUE(provider, provider_transaction_id)
      if (isUniqueConstraintError(error, 'payments_provider_transaction_key')) {
        const existing = await this.prisma.payment.findUnique({
          where: {
            provider_providerTransactionId: {
              provider: input.provider,
              providerTransactionId: input.providerTransactionId,
            },
          },
          include: { order: { select: { orderCode: true } } },
        });
        if (existing) {
          this.logger.log(
            `Handled concurrent duplicate payment (${input.provider}:${input.providerTransactionId}) idempotently`,
          );
          return {
            outcome: 'DUPLICATE',
            paymentId: existing.id,
            paymentStatus: existing.status,
            orderId: existing.orderId,
            orderCode: existing.order?.orderCode ?? null,
            reason: existing.failureReason,
          };
        }
      }
      throw error;
    }

    // Dispatch notifications strictly AFTER the DB transaction has committed.
    if (shouldDispatchOutbox) {
      this.outbox.triggerDispatch();
    }

    return result;
  }

  private collectCandidateOrderCodes(
    orderCodeHint: string | null,
    content: string,
  ): string[] {
    const candidates: string[] = [];
    const normalizedHint = orderCodeHint?.trim().toUpperCase();
    if (normalizedHint) {
      candidates.push(normalizedHint);
    }
    const extracted = extractOrderCodeFromContent(content);
    if (extracted && !candidates.includes(extracted)) {
      candidates.push(extracted);
    }
    return candidates;
  }

  private async lockOrderByCandidateCodes(
    tx: Prisma.TransactionClient,
    candidateCodes: string[],
  ): Promise<LockedOrderForReconciliation | null> {
    for (const code of candidateCodes) {
      // Row-level lock serializes concurrent webhooks, expiration sweeper, and user cancellation.
      const rows = await tx.$queryRaw<LockedOrderForReconciliation[]>`
        SELECT
          id,
          order_code AS "orderCode",
          user_id AS "userId",
          plan_id AS "planId",
          total_amount AS "totalAmount",
          currency,
          status::text AS status,
          expires_at AS "expiresAt",
          payment_va_account AS "paymentVaAccount",
          stock_reserved AS "stockReserved",
          stock_released_at AS "stockReleasedAt",
          target_email AS "targetEmail"
        FROM public.orders
        WHERE order_code = ${code}
        FOR UPDATE
      `;
      if (rows[0]) return rows[0];
    }
    return null;
  }

  private async recordExceptionPayment(
    tx: Prisma.TransactionClient,
    params: {
      input: IncomingBankTransaction;
      sanitizedPayload: Prisma.InputJsonValue;
      status: typeof PaymentStatus.UNMATCHED | typeof PaymentStatus.REJECTED;
      orderId: string | null;
      orderCode: string | null;
      reason: string;
      adminChatId: bigint | null;
      now: Date;
    },
  ): Promise<{ reconciled: PaymentReconciliationResult; enqueuedNotification: boolean }> {
    const { input, sanitizedPayload, status, orderId, orderCode, reason, adminChatId, now } = params;

    const payment = await tx.payment.create({
      data: {
        provider: input.provider,
        providerTransactionId: input.providerTransactionId,
        referenceCode: input.referenceCode,
        orderId,
        amount: input.amount,
        currency: input.currency,
        content: input.content,
        bankName: input.bankName ?? null,
        bankAccount: input.bankAccount,
        transType: input.transType.trim().toUpperCase(),
        status,
        failureReason: reason,
        transactionAt: input.transactionAt,
        receivedAt: input.receivedAt,
        rawPayload: sanitizedPayload,
        createdAt: now,
        updatedAt: now,
      },
    });

    this.logger.warn(
      `Recorded ${status} payment ${payment.id} (${input.provider}) reason=${reason} orderCode=${orderCode ?? 'NONE'}`,
    );

    let enqueuedNotification = false;
    if (adminChatId !== null) {
      const alertText = [
        `⚠️ Cảnh báo giao dịch ${status} (${input.provider})`,
        `Lý do: ${reason}`,
        `Số tiền: ${formatVnd(input.amount, input.currency)}`,
        `STK nhận: ${input.bankAccount}`,
        `Nội dung CK: ${input.content}`,
        orderCode ? `Mã đơn liên quan: ${orderCode}` : 'Mã đơn liên quan: Không tìm thấy',
        `Mã GD: ${input.referenceCode ?? input.providerTransactionId}`,
        `Thời gian GD ngân hàng: ${input.transactionAt.toISOString()}`,
        `Thời gian webhook đến: ${input.receivedAt.toISOString()}`,
        'Lưu ý: Trạng thái REJECTED/UNMATCHED chỉ có nghĩa chưa tự động xác nhận đơn, KHÔNG có nghĩa tiền đã hoàn lại. Vui lòng kiểm tra và xử lý thủ công.',
      ].join('\n');

      await this.outbox.enqueue(tx, {
        dedupeKey: `payment_alert_admin:${payment.id}`,
        chatId: adminChatId,
        notificationType: 'PAYMENT_ALERT_ADMIN',
        orderId,
        paymentId: payment.id,
        text: alertText,
      });
      enqueuedNotification = true;
    }

    return {
      reconciled: {
        outcome: status,
        paymentId: payment.id,
        paymentStatus: payment.status,
        orderId,
        orderCode,
        reason,
      },
      enqueuedNotification,
    };
  }
}
