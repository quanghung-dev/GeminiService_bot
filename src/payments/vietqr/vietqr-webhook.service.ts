import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { type VietqrConfig, vietqrConfig } from '../../config/vietqr.config.js';
import { PaymentProvider } from '../../generated/prisma/client.js';
import { PaymentReconciliationService } from '../payment-reconciliation.service.js';
import { VIETQR_CALLBACK_ERROR_REASONS } from './vietqr.constants.js';
import type {
  VietqrTransactionSyncRequest,
  VietqrTransactionSyncResponse,
} from './vietqr.types.js';

export interface ParsedVietqrTransaction {
  bankAccount: string;
  amount: bigint;
  transType: 'C' | 'D';
  content: string;
  transactionId: string;
  transactionAt: Date;
  referenceNumber: string;
  orderId: string;
  hasOptionalSign: boolean;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException({
      error: true,
      errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
      toastMessage: `Field "${fieldName}" is required and must be a non-empty string`,
      object: null,
    } satisfies VietqrTransactionSyncResponse);
  }
  return value.trim();
}

/**
 * Parses monetary amount strictly as a positive integer BigInt.
 * Rejects floating-point numbers to comply with no-float money calculation rules.
 */
export function parseStrictPositiveBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
        toastMessage: `Field "${fieldName}" must be a positive integer`,
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }
    return BigInt(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new BadRequestException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
        toastMessage: `Field "${fieldName}" must be a positive integer`,
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }
    const parsed = BigInt(trimmed);
    if (parsed <= 0n) {
      throw new BadRequestException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
        toastMessage: `Field "${fieldName}" must be greater than zero`,
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }
    return parsed;
  }

  throw new BadRequestException({
    error: true,
    errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
    toastMessage: `Field "${fieldName}" is required`,
    object: null,
  } satisfies VietqrTransactionSyncResponse);
}

/**
 * Parses VietQR official `transactiontime` (Unix timestamp in milliseconds).
 */
export function parseTransactionTimeMs(value: unknown): Date {
  let timestampMs: number;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    timestampMs = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    timestampMs = Number(value.trim());
  } else {
    throw new BadRequestException({
      error: true,
      errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
      toastMessage: 'Field "transactiontime" must be a Unix timestamp in milliseconds',
      object: null,
    } satisfies VietqrTransactionSyncResponse);
  }

  // Sanity bounds: year 2000 .. year 2100 in ms (rejects accidental seconds-only timestamps)
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 946_684_800_000 || timestampMs > 4_102_444_800_000) {
    throw new BadRequestException({
      error: true,
      errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
      toastMessage: 'Field "transactiontime" is out of valid millisecond timestamp range',
      object: null,
    } satisfies VietqrTransactionSyncResponse);
  }

  const parsed = new Date(timestampMs);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException({
      error: true,
      errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
      toastMessage: 'Field "transactiontime" is invalid',
      object: null,
    } satisfies VietqrTransactionSyncResponse);
  }
  return parsed;
}

export function parseVietqrTransactionSyncPayload(raw: unknown): ParsedVietqrTransaction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException({
      error: true,
      errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
      toastMessage: 'Request body must be a JSON object',
      object: null,
    } satisfies VietqrTransactionSyncResponse);
  }

  const body = raw as Partial<VietqrTransactionSyncRequest>;
  const bankAccount = requireNonEmptyString(body.bankaccount, 'bankaccount');
  const amount = parseStrictPositiveBigInt(body.amount, 'amount');
  const transTypeRaw = requireNonEmptyString(body.transType, 'transType').toUpperCase();
  if (transTypeRaw !== 'C' && transTypeRaw !== 'D') {
    throw new BadRequestException({
      error: true,
      errorReason: VIETQR_CALLBACK_ERROR_REASONS.INVALID_PAYLOAD,
      toastMessage: 'Field "transType" must be "C" or "D"',
      object: null,
    } satisfies VietqrTransactionSyncResponse);
  }

  const content = requireNonEmptyString(body.content, 'content');
  const transactionId = requireNonEmptyString(body.transactionid, 'transactionid');
  const transactionAt = parseTransactionTimeMs(body.transactiontime);
  const referenceNumber = requireNonEmptyString(body.referencenumber, 'referencenumber');
  // orderId may be empty/null on manual transfers or debit movements; reconciliation falls back to content.
  const orderId =
    typeof body.orderId === 'string' && body.orderId.trim().length > 0
      ? body.orderId.trim()
      : '';

  // Optional `sign` field per official public docs: do NOT invent a verification algorithm.
  const hasOptionalSign = typeof body.sign === 'string' && body.sign.trim().length > 0;

  return {
    bankAccount,
    amount,
    transType: transTypeRaw,
    content,
    transactionId,
    transactionAt,
    referenceNumber,
    orderId,
    hasOptionalSign,
  };
}

@Injectable()
export class VietqrWebhookService {
  private readonly logger = new Logger(VietqrWebhookService.name);

  constructor(
    @Inject(vietqrConfig.KEY)
    private readonly config: VietqrConfig,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

  async handleTransactionSync(rawBody: unknown): Promise<VietqrTransactionSyncResponse> {
    const parsed = parseVietqrTransactionSyncPayload(rawBody);
    const receivedAt = new Date();

    if (parsed.hasOptionalSign) {
      this.logger.debug(
        `VietQR callback ${parsed.transactionId} included optional "sign" field (unverified until official algorithm is confirmed before Go-Live).`,
      );
    }

    try {
      const result = await this.reconciliation.reconcile({
        provider: PaymentProvider.VIETQR,
        providerTransactionId: parsed.transactionId,
        referenceCode: parsed.referenceNumber,
        bankAccount: parsed.bankAccount,
        expectedBankAccount: this.config.bankAccount || null,
        bankName: this.config.bankCode || null,
        amount: parsed.amount,
        currency: 'VND',
        transType: parsed.transType,
        content: parsed.content,
        orderCodeHint: parsed.orderId || null,
        transactionAt: parsed.transactionAt,
        receivedAt,
        rawPayload: rawBody,
      });

      this.logger.log(
        `VietQR transaction-sync processed: env=${this.config.env} tx=${parsed.transactionId} outcome=${result.outcome} paymentId=${result.paymentId}`,
      );

      return {
        error: false,
        errorReason: null,
        toastMessage: 'Transaction processed successfully',
        object: {
          reftransactionid: result.paymentId,
        },
      };
    } catch (error: unknown) {
      this.logger.error(
        `VietQR transaction-sync failed for tx=${parsed.transactionId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new InternalServerErrorException({
        error: true,
        errorReason: VIETQR_CALLBACK_ERROR_REASONS.TRANSACTION_FAILED,
        toastMessage: 'Internal processing error',
        object: null,
      } satisfies VietqrTransactionSyncResponse);
    }
  }
}
