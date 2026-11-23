import { registerAs } from '@nestjs/config';
import {
  VIETQR_CONFIG_KEY,
  VIETQR_DEFAULT_BASE_URLS,
  VIETQR_DEFAULT_TOKEN_EXPIRES_IN,
  VIETQR_MIN_TOKEN_SECRET_LENGTH,
} from '../payments/vietqr/vietqr.constants.js';

export type VietqrEnv = 'uat' | 'production';
export type VietqrQrType = 0 | 1 | 3;

export interface VietqrConfig {
  enabled: boolean;
  env: VietqrEnv;
  merchantName: string;
  clientUsername: string;
  clientPassword: string;
  tokenSecret: string;
  tokenExpiresIn: number;
  baseUrl: string;
  systemUsername: string;
  systemPassword: string;
  qrType: VietqrQrType;
  bankCode: string;
  bankAccount: string;
  accountName: string;
  terminalCode: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error('VIETQR_ENABLED must be a boolean ("true" or "false")');
}

function parseEnv(value: string | undefined): VietqrEnv {
  const normalized = (value ?? 'uat').trim().toLowerCase();
  if (normalized === 'uat' || normalized === 'production') return normalized;
  throw new Error('VIETQR_ENV must be either "uat" or "production"');
}

function parseTokenExpiresIn(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return VIETQR_DEFAULT_TOKEN_EXPIRES_IN;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('VIETQR_TOKEN_EXPIRES_IN must be a positive integer (seconds)');
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 60 || parsed > 86_400) {
    throw new Error('VIETQR_TOKEN_EXPIRES_IN must be between 60 and 86400 seconds');
  }
  return parsed;
}

function parseQrType(value: string | undefined): VietqrQrType {
  if (value === undefined || value.trim() === '') return 0;
  const trimmed = value.trim();
  if (trimmed === '0') return 0;
  if (trimmed === '1') return 1;
  if (trimmed === '3') return 3;
  throw new Error('VIETQR_QR_TYPE must be 0, 1, or 3');
}

function parseBaseUrl(value: string | undefined, env: VietqrEnv, enabled: boolean): string {
  const raw = (value ?? '').trim() || VIETQR_DEFAULT_BASE_URLS[env];
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('VIETQR_BASE_URL must be a valid URL');
  }

  if (enabled && parsed.protocol !== 'https:') {
    throw new Error('VIETQR_BASE_URL must use HTTPS when VIETQR_ENABLED=true');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (env === 'production' && hostname === 'dev.vietqr.org') {
    throw new Error('VIETQR_BASE_URL cannot point to UAT host (dev.vietqr.org) when VIETQR_ENV=production');
  }
  if (env === 'uat' && hostname === 'api.vietqr.org') {
    throw new Error('VIETQR_BASE_URL cannot point to Production host (api.vietqr.org) when VIETQR_ENV=uat');
  }

  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

export function loadVietqrConfig(envSource: NodeJS.ProcessEnv = process.env): VietqrConfig {
  const enabled = parseBoolean(envSource.VIETQR_ENABLED, false);
  const env = parseEnv(envSource.VIETQR_ENV);
  const tokenExpiresIn = parseTokenExpiresIn(envSource.VIETQR_TOKEN_EXPIRES_IN);
  const qrType = parseQrType(envSource.VIETQR_QR_TYPE);
  const baseUrl = parseBaseUrl(envSource.VIETQR_BASE_URL, env, enabled);

  const clientUsername = (envSource.VIETQR_CLIENT_USERNAME ?? '').trim();
  const clientPassword = envSource.VIETQR_CLIENT_PASSWORD ?? '';
  const tokenSecret = envSource.VIETQR_TOKEN_SECRET ?? '';

  if (enabled) {
    if (!clientUsername || !clientPassword) {
      throw new Error('VIETQR_CLIENT_USERNAME and VIETQR_CLIENT_PASSWORD are required when VIETQR_ENABLED=true');
    }
    if (tokenSecret.length < VIETQR_MIN_TOKEN_SECRET_LENGTH) {
      throw new Error(
        `VIETQR_TOKEN_SECRET must be at least ${VIETQR_MIN_TOKEN_SECRET_LENGTH} characters when VIETQR_ENABLED=true`,
      );
    }
  }

  return {
    enabled,
    env,
    merchantName: (envSource.VIETQR_MERCHANT_NAME ?? '').trim(),
    clientUsername,
    clientPassword,
    tokenSecret,
    tokenExpiresIn,
    baseUrl,
    systemUsername: (envSource.VIETQR_SYSTEM_USERNAME ?? '').trim(),
    systemPassword: envSource.VIETQR_SYSTEM_PASSWORD ?? '',
    qrType,
    bankCode: (envSource.VIETQR_BANK_CODE ?? '').trim().toUpperCase(),
    bankAccount: (envSource.VIETQR_BANK_ACCOUNT ?? '').trim(),
    accountName: (envSource.VIETQR_ACCOUNT_NAME ?? '').trim(),
    terminalCode: (envSource.VIETQR_TERMINAL_CODE ?? '').trim(),
  };
}

export function hasVietqrOutboundCredentials(config: VietqrConfig): boolean {
  return Boolean(
    config.enabled
    && config.systemUsername
    && config.systemPassword
    && config.bankCode
    && config.bankAccount
    && config.accountName,
  );
}

export const vietqrConfig = registerAs(VIETQR_CONFIG_KEY, () => loadVietqrConfig(process.env));
