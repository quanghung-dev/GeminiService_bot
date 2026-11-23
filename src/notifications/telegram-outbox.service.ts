import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TelegramMessageSender } from './telegram-sender.interface.js';

export type TelegramNotificationType =
  | 'ORDER_PAID_CUSTOMER'
  | 'ORDER_PAID_ADMIN'
  | 'ORDER_PROCESSING_CUSTOMER'
  | 'ORDER_COMPLETED_CUSTOMER'
  | 'PAYMENT_ALERT_ADMIN';

export interface EnqueueTelegramNotificationInput {
  dedupeKey: string;
  chatId: bigint;
  notificationType: TelegramNotificationType;
  text: string;
  orderId?: string | null;
  paymentId?: string | null;
  maxAttempts?: number;
}

interface ClaimedNotificationRow {
  id: string;
  dedupeKey: string;
  chatId: bigint;
  notificationType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

const DEFAULT_LOCK_TTL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 10;

export function parseAdminChatId(raw: string | undefined = process.env.TELEGRAM_ADMIN_CHAT_ID): bigint | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

export function computeRetryDelayMs(attemptNumber: number, retryAfterSeconds?: number): number {
  const exponent = Math.max(0, attemptNumber - 1);
  const exponentialMs = Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
  const telegramRetryAfterMs =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds * 1000)
      : 0;
  return Math.max(exponentialMs, telegramRetryAfterMs);
}

/**
 * Durable Transactional Outbox worker for Telegram notifications.
 *
 * Delivery guarantee: at-least-once (Telegram Bot API does not provide
 * idempotency keys for sendMessage). Notifications are persisted inside the
 * business DB transaction and dispatched strictly outside the transaction.
 */
@Injectable()
export class TelegramOutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramOutboxService.name);
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private sender: TelegramMessageSender | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private rerunRequested = false;

  constructor(private readonly prisma: PrismaService) {}

  registerSender(sender: TelegramMessageSender | null, autoDispatch = true): void {
    this.sender = sender;
    if (sender && autoDispatch) {
      this.triggerDispatch();
    }
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.startPolling();
  }

  onModuleDestroy(): void {
    this.stopPolling();
  }

  startPolling(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processDueNotifications().catch((error: unknown) => {
        this.logger.error(
          `Outbox polling error: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    }, intervalMs);
    this.timer.unref();
    this.triggerDispatch();
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async enqueue(
    tx: Prisma.TransactionClient,
    input: EnqueueTelegramNotificationInput,
  ): Promise<void> {
    // Use PostgreSQL server now() for next_attempt_at/created_at/updated_at so
    // host-vs-DB clock skew never delays immediate outbox claims.
    const payloadJson = JSON.stringify({ text: input.text });
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    await tx.$executeRaw`
      INSERT INTO public.telegram_notifications (
        dedupe_key,
        chat_id,
        notification_type,
        order_id,
        payment_id,
        payload,
        status,
        attempts,
        max_attempts,
        next_attempt_at,
        created_at,
        updated_at
      )
      VALUES (
        ${input.dedupeKey},
        ${input.chatId},
        ${input.notificationType},
        ${input.orderId ?? null}::uuid,
        ${input.paymentId ?? null}::uuid,
        ${payloadJson}::jsonb,
        'PENDING',
        0,
        ${maxAttempts},
        now(),
        now(),
        now()
      )
      ON CONFLICT (dedupe_key) DO NOTHING
    `;
  }

  triggerDispatch(): void {
    if (!this.sender) return;
    if (this.draining) {
      this.rerunRequested = true;
      return;
    }
    void this.processDueNotifications().catch((error: unknown) => {
      this.logger.error(
        `Outbox dispatch error: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
  }

  async processDueNotifications(batchSize = 10, lockTtlMs = DEFAULT_LOCK_TTL_MS): Promise<number> {
    if (!this.sender) return 0;
    if (this.draining) {
      this.rerunRequested = true;
      return 0;
    }

    this.draining = true;
    let processed = 0;

    try {
      do {
        this.rerunRequested = false;
        const claimed = await this.claimDueBatch(batchSize, lockTtlMs);
        for (const item of claimed) {
          await this.deliverClaimedItem(item);
          processed += 1;
        }
        if (claimed.length === batchSize) {
          this.rerunRequested = true;
        }
      } while (this.rerunRequested && this.sender !== null);
    } finally {
      this.draining = false;
    }

    return processed;
  }

  private async claimDueBatch(
    batchSize: number,
    lockTtlMs: number,
  ): Promise<ClaimedNotificationRow[]> {
    // Raw SQL is required here because Prisma Client does not support
    // SELECT ... FOR UPDATE SKIP LOCKED combined with UPDATE ... RETURNING.
    return this.prisma.$queryRaw<ClaimedNotificationRow[]>`
      WITH claimed AS (
        SELECT id
        FROM public.telegram_notifications
        WHERE (status = 'PENDING' AND next_attempt_at <= now())
           OR (status = 'PROCESSING' AND lock_expires_at <= now())
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE public.telegram_notifications AS n
      SET
        status = 'PROCESSING',
        locked_at = now(),
        locked_by = ${this.workerId},
        lock_expires_at = now() + (${lockTtlMs} * interval '1 millisecond'),
        updated_at = now()
      FROM claimed
      WHERE n.id = claimed.id
      RETURNING
        n.id,
        n.dedupe_key AS "dedupeKey",
        n.chat_id AS "chatId",
        n.notification_type AS "notificationType",
        n.payload,
        n.attempts,
        n.max_attempts AS "maxAttempts"
    `;
  }

  private async deliverClaimedItem(item: ClaimedNotificationRow): Promise<void> {
    if (!this.sender) return;

    const text = this.extractText(item.payload);
    if (!text) {
      const now = new Date();
      await this.prisma.telegramNotification.updateMany({
        where: { id: item.id, lockedBy: this.workerId },
        data: {
          status: 'FAILED',
          attempts: item.attempts + 1,
          lastError: 'Invalid notification payload: missing text',
          lockedAt: null,
          lockedBy: null,
          lockExpiresAt: null,
          updatedAt: now,
        },
      });
      return;
    }

    let result;
    try {
      result = await this.sender.sendMessage(item.chatId, text);
    } catch (error: unknown) {
      result = {
        ok: false as const,
        errorMessage: error instanceof Error ? error.message : 'Unexpected sender error',
      };
    }

    const now = new Date();
    if (result.ok) {
      await this.prisma.telegramNotification.updateMany({
        where: { id: item.id, lockedBy: this.workerId },
        data: {
          status: 'SENT',
          sentAt: now,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          lockExpiresAt: null,
          updatedAt: now,
        },
      });
      return;
    }

    const nextAttempts = item.attempts + 1;
    const exhausted = result.permanent === true || nextAttempts >= item.maxAttempts;
    const sanitizedError = result.errorMessage.slice(0, 500);

    if (exhausted) {
      this.logger.error(
        `Notification ${item.id} (${item.notificationType}) permanently failed after ${nextAttempts} attempt(s): ${sanitizedError}`,
      );
      await this.prisma.telegramNotification.updateMany({
        where: { id: item.id, lockedBy: this.workerId },
        data: {
          status: 'FAILED',
          attempts: nextAttempts,
          lastError: sanitizedError,
          lockedAt: null,
          lockedBy: null,
          lockExpiresAt: null,
          updatedAt: now,
        },
      });
      return;
    }

    const delayMs = computeRetryDelayMs(nextAttempts, result.retryAfterSeconds);
    this.logger.warn(
      `Notification ${item.id} (${item.notificationType}) attempt ${nextAttempts}/${item.maxAttempts} failed; retrying in ${Math.ceil(delayMs / 1000)}s`,
    );
    await this.prisma.$executeRaw`
      UPDATE public.telegram_notifications
      SET
        status = 'PENDING',
        attempts = ${nextAttempts},
        next_attempt_at = now() + (${delayMs} * interval '1 millisecond'),
        last_error = ${sanitizedError},
        locked_at = NULL,
        locked_by = NULL,
        lock_expires_at = NULL,
        updated_at = now()
      WHERE id = ${item.id}::uuid AND locked_by = ${this.workerId}
    `;
  }

  private extractText(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const text = (payload as { text?: unknown }).text;
    return typeof text === 'string' && text.trim().length > 0 ? text : null;
  }
}
