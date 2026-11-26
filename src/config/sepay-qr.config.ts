import { registerAs } from '@nestjs/config';

export const SEPAY_QR_CONFIG_KEY = 'sepayQr';

export type SepayQrTemplate = 'compact' | 'qronly' | 'default';

export const SEPAY_QR_DEFAULT_BASE_URL = 'https://qr.sepay.vn/img';
export const SEPAY_QR_DEFAULT_BANK = 'Vietcombank';
export const SEPAY_QR_DEFAULT_ACCOUNT = '9869983819';
export const SEPAY_QR_DEFAULT_ACCOUNT_NAME = 'DO QUANG HUNG';
export const SEPAY_QR_DEFAULT_TEMPLATE: SepayQrTemplate = 'compact';
export const SEPAY_QR_DEFAULT_ORDER_EXPIRES_MINUTES = 10;

export interface SepayQrConfig {
  baseUrl: string;
  bank: string;
  account: string;
  accountName: string;
  template: SepayQrTemplate;
  orderExpiresMinutes: number;
}

function parseTemplate(value: string | undefined): SepayQrTemplate {
  const normalized = (value ?? SEPAY_QR_DEFAULT_TEMPLATE).trim().toLowerCase();
  if (normalized === '' || normalized === 'default') return 'default';
  if (normalized === 'compact' || normalized === 'qronly') return normalized;
  throw new Error('SEPAY_QR_TEMPLATE must be "compact", "qronly", or "default"');
}

function parseBaseUrl(value: string | undefined): string {
  const raw = (value ?? '').trim() || SEPAY_QR_DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SEPAY_QR_BASE_URL must be a valid URL');
  }

  const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new Error('SEPAY_QR_BASE_URL must use HTTPS');
  }

  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

function parseOrderExpiresMinutes(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return SEPAY_QR_DEFAULT_ORDER_EXPIRES_MINUTES;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('ORDER_EXPIRES_MINUTES must be a positive integer');
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1440) {
    throw new Error('ORDER_EXPIRES_MINUTES must be between 1 and 1440');
  }
  return parsed;
}

export function loadSepayQrConfig(envSource: NodeJS.ProcessEnv = process.env): SepayQrConfig {
  return {
    baseUrl: parseBaseUrl(envSource.SEPAY_QR_BASE_URL),
    bank: (envSource.SEPAY_QR_BANK ?? '').trim() || SEPAY_QR_DEFAULT_BANK,
    account: (envSource.SEPAY_QR_BANK_ACCOUNT ?? '').trim() || SEPAY_QR_DEFAULT_ACCOUNT,
    accountName: (envSource.SEPAY_QR_ACCOUNT_NAME ?? '').trim() || SEPAY_QR_DEFAULT_ACCOUNT_NAME,
    template: parseTemplate(envSource.SEPAY_QR_TEMPLATE),
    orderExpiresMinutes: parseOrderExpiresMinutes(envSource.ORDER_EXPIRES_MINUTES),
  };
}

export const sepayQrConfig = registerAs(SEPAY_QR_CONFIG_KEY, () => loadSepayQrConfig(process.env));
