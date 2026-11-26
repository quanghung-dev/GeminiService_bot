import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SepayQrConfig, sepayQrConfig } from '../../config/sepay-qr.config.js';

export interface GenerateSepayQrInput {
  orderCode: string;
  amount: bigint;
}

export interface GeneratedSepayQrResult {
  bankCode: string;
  bankName: string | null;
  bankAccount: string;
  userBankName: string;
  amount: string;
  content: string;
  orderId: string;
  qrLink: string;
  qrImagePng: Buffer;
}

export class SepayQrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'SepayQrError';
  }
}

const OUTBOUND_TIMEOUT_MS = 10_000;

@Injectable()
export class SepayQrClient {
  private readonly logger = new Logger(SepayQrClient.name);

  constructor(
    @Inject(sepayQrConfig.KEY)
    private readonly config: SepayQrConfig,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.baseUrl && this.config.bank && this.config.account && this.config.accountName,
    );
  }

  buildTransferContent(orderCode: string): string {
    const trimmedOrderCode = orderCode.trim();
    if (!trimmedOrderCode) {
      throw new SepayQrError('INVALID_ORDER_CODE', 'Order code must not be empty');
    }
    return trimmedOrderCode;
  }

  buildQrImageUrl(amount: bigint, content: string): string {
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SepayQrError('INVALID_AMOUNT', 'SePay QR amount must be a positive integer');
    }
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      throw new SepayQrError('INVALID_CONTENT', 'SePay QR transfer content must not be empty');
    }

    const params = [
      `acc=${encodeURIComponent(this.config.account)}`,
      `bank=${encodeURIComponent(this.config.bank)}`,
      `amount=${encodeURIComponent(amount.toString())}`,
      `des=${encodeURIComponent(trimmedContent)}`,
    ];
    if (this.config.template !== 'default') {
      params.push(`template=${encodeURIComponent(this.config.template)}`);
    }

    return `${this.config.baseUrl}?${params.join('&')}`;
  }

  /**
   * Fetches the rendered VietQR PNG image from qr.sepay.vn without requiring
   * SePay webhook/API credentials.
   */
  async generateCustomerQr(input: GenerateSepayQrInput): Promise<GeneratedSepayQrResult> {
    if (!this.isConfigured()) {
      throw new SepayQrError('SEPAY_NOT_CONFIGURED', 'SePay QR bank configuration is incomplete');
    }

    const orderId = input.orderCode.trim();
    const content = this.buildTransferContent(orderId);
    const qrLink = this.buildQrImageUrl(input.amount, content);

    const response = await fetch(qrLink, {
      method: 'GET',
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });

    if (!response.ok) {
      this.logger.error(
        `SePay QR image fetch failed for order=${orderId} status=${response.status}`,
      );
      throw new SepayQrError(
        'SEPAY_QR_FETCH_FAILED',
        `SePay QR returned HTTP ${response.status}`,
        response.status,
      );
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('image/')) {
      this.logger.error(
        `SePay QR returned unexpected content-type="${contentType}" for order=${orderId}`,
      );
      throw new SepayQrError(
        'SEPAY_QR_INVALID_RESPONSE',
        `Expected image response from SePay QR, got "${contentType || 'unknown'}"`,
      );
    }

    const qrImagePng = Buffer.from(await response.arrayBuffer());
    if (qrImagePng.length === 0) {
      throw new SepayQrError('SEPAY_QR_EMPTY_IMAGE', 'SePay QR returned an empty image body');
    }

    return {
      bankCode: this.config.bank,
      bankName: null,
      bankAccount: this.config.account,
      userBankName: this.config.accountName,
      amount: input.amount.toString(),
      content,
      orderId,
      qrLink,
      qrImagePng,
    };
  }
}
