export const VIETQR_CONFIG_KEY = 'vietqr';

export const VIETQR_TOKEN_TYPE = 'Bearer' as const;
export const VIETQR_JWT_ALGORITHM = 'HS512' as const;
export const VIETQR_JWT_ISSUER = 'geminiservice-vietqr';
export const VIETQR_JWT_AUDIENCE = 'vietqr-callback';
export const VIETQR_DEFAULT_TOKEN_EXPIRES_IN = 300;
export const VIETQR_MIN_TOKEN_SECRET_LENGTH = 32;

export const VIETQR_DEFAULT_BASE_URLS = {
  uat: 'https://dev.vietqr.org',
  production: 'https://api.vietqr.org',
} as const;

export const VIETQR_CALLBACK_ERROR_REASONS = {
  INVALID_AUTH_HEADER: 'INVALID_AUTH_HEADER',
  INVALID_TOKEN: 'INVALID_TOKEN',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
} as const;
