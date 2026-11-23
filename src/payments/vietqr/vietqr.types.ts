import type { VietqrEnv } from '../../config/vietqr.config.js';
import type { VIETQR_TOKEN_TYPE } from './vietqr.constants.js';

export interface VietqrTokenSuccessResponse {
  access_token: string;
  token_type: typeof VIETQR_TOKEN_TYPE;
  expires_in: number;
}

export interface VietqrTokenErrorResponse {
  status: 'FAILED';
  message: string;
}

export interface VietqrJwtPayload {
  sub: string;
  username: string;
  env: VietqrEnv;
  jti: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

/**
 * Official VietQR Transaction Sync request payload contract:
 * https://api.vietqr.vn/vi/api-vietqr-callback/api-transaction-sync
 */
export interface VietqrTransactionSyncRequest {
  bankaccount: string;
  amount: number | string;
  transType: 'C' | 'D' | string;
  content: string;
  transactionid: string;
  transactiontime: number | string;
  referencenumber: string;
  orderId: string;
  terminalCode?: string | null;
  subTerminalCode?: string | null;
  serviceCode?: string | null;
  urlLink?: string | null;
  sign?: string | null;
}

export interface VietqrTransactionSyncResponseObject {
  reftransactionid: string;
}

export interface VietqrTransactionSyncResponse {
  error: boolean;
  errorReason: string | null;
  toastMessage: string;
  object: VietqrTransactionSyncResponseObject | null;
}
