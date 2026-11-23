import type { PaymentProvider, PaymentStatus } from '../generated/prisma/client.js';

export interface IncomingBankTransaction {
  provider: PaymentProvider;
  providerTransactionId: string;
  referenceCode: string | null;
  bankAccount: string;
  expectedBankAccount: string | null;
  bankName?: string | null;
  amount: bigint;
  currency: string;
  transType: string;
  content: string;
  orderCodeHint: string | null;
  transactionAt: Date;
  receivedAt: Date;
  rawPayload: unknown;
}

export type PaymentReconciliationOutcome =
  | 'VERIFIED'
  | 'DUPLICATE'
  | 'UNMATCHED'
  | 'REJECTED';

export interface PaymentReconciliationResult {
  outcome: PaymentReconciliationOutcome;
  paymentId: string;
  paymentStatus: PaymentStatus;
  orderId: string | null;
  orderCode: string | null;
  reason: string | null;
}
