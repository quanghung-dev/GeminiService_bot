import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_CODE_PREFIX = 'GS';
const ORDER_CODE_RANDOM_LENGTH = 10;

/**
 * Generates an uppercase ASCII alphanumeric order code (12 chars total),
 * satisfying VietQR dynamic QR constraints:
 * - orderId <= 13 chars, no special characters
 * - content <= 23 chars, no diacritics or special characters
 */
export function generateOrderCode(): string {
  const bytes = randomBytes(ORDER_CODE_RANDOM_LENGTH);
  let suffix = '';
  for (let i = 0; i < ORDER_CODE_RANDOM_LENGTH; i++) {
    suffix += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${ORDER_CODE_PREFIX}${suffix}`;
}

const ORDER_CODE_REGEX = /\b(GS[A-Z0-9]{8,11})\b/i;

export function extractOrderCodeFromContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const match = ORDER_CODE_REGEX.exec(content.trim());
  return match ? match[1].toUpperCase() : null;
}
