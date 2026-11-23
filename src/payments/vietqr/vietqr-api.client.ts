import { Inject, Injectable, Logger } from '@nestjs/common';
import QRCode from 'qrcode';
import {
  hasVietqrOutboundCredentials,
  type VietqrConfig,
  vietqrConfig,
} from '../../config/vietqr.config.js';

export interface GenerateVietqrOrderInput {
  orderCode: string;
  amount: bigint;
  content: string;
  note?: string;
}

export interface GeneratedVietqrResult {
  bankCode: string;
  bankName: string | null;
  bankAccount: string;
  userBankName: string;
  vaAccount: string | null;
  amount: string;
  content: string;
  orderId: string;
  qrCode: string;
  qrLink: string | null;
  transactionRefId: string | null;
  qrImagePng: Buffer;
}

interface VietqrSystemTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  status?: string;
  message?: string;
}

interface VietqrGenerateCustomerResponse {
  bankCode?: string;
  bankName?: string;
  bankAccount?: string;
  userBankName?: string;
  amount?: string | number;
  content?: string;
  qrCode?: string;
  imgId?: string;
  existing?: number;
  transactionId?: string;
  transactionRefId?: string;
  qrLink?: string;
  orderId?: string;
  vaAccount?: string;
  status?: string;
  message?: string;
}

export class VietqrApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'VietqrApiError';
  }
}

const ASCII_ALPHANUMERIC_SPACE = /^[A-Za-z0-9 ]+$/;
const ASCII_ORDER_ID = /^[A-Za-z0-9]+$/;
const TOKEN_REFRESH_SAFETY_MARGIN_MS = 30_000;
const OUTBOUND_TIMEOUT_MS = 10_000;

@Injectable()
export class VietqrApiClient {
  private readonly logger = new Logger(VietqrApiClient.name);
  private cachedToken: { token: string; expiresAtMs: number } | null = null;
  private inflightTokenPromise: Promise<string> | null = null;

  constructor(
    @Inject(vietqrConfig.KEY)
    private readonly config: VietqrConfig,
  ) {}

  isConfigured(): boolean {
    return hasVietqrOutboundCredentials(this.config);
  }

  invalidateCachedToken(): void {
    this.cachedToken = null;
  }

  async getSystemAccessToken(forceRefresh = false): Promise<string> {
    if (!this.isConfigured()) {
      throw new VietqrApiError(
        'VIETQR_NOT_CONFIGURED',
        'VietQR outbound API credentials or bank account details are not configured',
      );
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAtMs > now) {
      return this.cachedToken.token;
    }

    if (this.inflightTokenPromise) {
      return this.inflightTokenPromise;
    }

    this.inflightTokenPromise = this.fetchSystemAccessToken().finally(() => {
      this.inflightTokenPromise = null;
    });
    return this.inflightTokenPromise;
  }

  async generateCustomerQr(input: GenerateVietqrOrderInput): Promise<GeneratedVietqrResult> {
    if (!this.isConfigured()) {
      throw new VietqrApiError(
        'VIETQR_NOT_CONFIGURED',
        'VietQR outbound API credentials or bank account details are not configured',
      );
    }

    const orderId = input.orderCode.trim();
    const content = input.content.trim();

    if (orderId.length === 0 || orderId.length > 13 || !ASCII_ORDER_ID.test(orderId)) {
      throw new VietqrApiError(
        'INVALID_ORDER_ID',
        'VietQR orderId must be 1..13 ASCII alphanumeric characters',
      );
    }
    if (content.length === 0 || content.length > 23 || !ASCII_ALPHANUMERIC_SPACE.test(content)) {
      throw new VietqrApiError(
        'INVALID_CONTENT',
        'VietQR content must be 1..23 ASCII alphanumeric/space characters without diacritics',
      );
    }
    if (input.amount <= 0n || input.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new VietqrApiError('INVALID_AMOUNT', 'VietQR amount must be a positive safe integer');
    }

    let token = await this.getSystemAccessToken();
    let response = await this.callGenerateCustomer(token, orderId, content, input);

    if (response.status === 401) {
      this.invalidateCachedToken();
      token = await this.getSystemAccessToken(true);
      response = await this.callGenerateCustomer(token, orderId, content, input);
    }

    const data = (await response.json().catch(() => null)) as VietqrGenerateCustomerResponse | null;
    if (!response.ok || !data || !data.qrCode || data.status === 'FAILED') {
      const errorMessage = data?.message || `VietQR generate-customer failed with HTTP ${response.status}`;
      this.logger.error(
        `VietQR generate-customer failed for order=${orderId} status=${response.status} env=${this.config.env}`,
      );
      throw new VietqrApiError('VIETQR_QR_GENERATION_FAILED', errorMessage, response.status);
    }

    const qrImagePng = await QRCode.toBuffer(data.qrCode, {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });

    return {
      bankCode: data.bankCode || this.config.bankCode,
      bankName: data.bankName ?? null,
      bankAccount: data.bankAccount || this.config.bankAccount,
      userBankName: data.userBankName || this.config.accountName,
      vaAccount: data.vaAccount?.trim() || null,
      amount: String(data.amount ?? input.amount.toString()),
      content: data.content || content,
      orderId: data.orderId || orderId,
      qrCode: data.qrCode,
      qrLink: data.qrLink?.trim() || null,
      transactionRefId: data.transactionRefId?.trim() || data.imgId?.trim() || null,
      qrImagePng,
    };
  }

  private async fetchSystemAccessToken(): Promise<string> {
    const basic = Buffer.from(
      `${this.config.systemUsername}:${this.config.systemPassword}`,
      'utf8',
    ).toString('base64');

    const url = `${this.config.baseUrl}/vqr/api/token_generate`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basic}`,
      },
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });

    const data = (await response.json().catch(() => null)) as VietqrSystemTokenResponse | null;
    if (!response.ok || !data?.access_token) {
      const detail = data?.message || `HTTP ${response.status}`;
      this.logger.error(
        `VietQR system token_generate failed (env=${this.config.env}, status=${response.status})`,
      );
      throw new VietqrApiError('VIETQR_SYSTEM_AUTH_FAILED', detail, response.status);
    }

    const expiresInSeconds =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
        ? data.expires_in
        : 300;
    const ttlMs = Math.max(5_000, expiresInSeconds * 1000 - TOKEN_REFRESH_SAFETY_MARGIN_MS);
    this.cachedToken = {
      token: data.access_token,
      expiresAtMs: Date.now() + ttlMs,
    };

    return data.access_token;
  }

  private callGenerateCustomer(
    token: string,
    orderId: string,
    content: string,
    input: GenerateVietqrOrderInput,
  ): Promise<Response> {
    const payload: Record<string, unknown> = {
      bankCode: this.config.bankCode,
      bankAccount: this.config.bankAccount,
      userBankName: this.config.accountName,
      content,
      qrType: this.config.qrType,
      amount: Number(input.amount),
      orderId,
      transType: 'C',
    };

    if (this.config.terminalCode) {
      payload.terminalCode = this.config.terminalCode;
    }
    if (input.note) {
      payload.note = input.note;
    }

    return fetch(`${this.config.baseUrl}/vqr/api/qr/generate-customer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
  }
}
