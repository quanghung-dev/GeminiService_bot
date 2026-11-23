import { BadRequestException } from '@nestjs/common';
import { PlanHandleType, type Prisma } from '../generated/prisma/client.js';

export type CustomerFieldKey = 'usernameOrEmail' | 'password' | 'twoFactor' | 'note';
export type FieldValidationRule = 'email' | 'text';

export interface HandleFieldConfig {
  key: CustomerFieldKey;
  required: boolean;
  validate?: FieldValidationRule;
  labelVi?: string;
  labelEn?: string;
  promptVi?: string;
  promptEn?: string;
}

export interface PlanHandleConfig {
  fields?: HandleFieldConfig[];
  instructionVi?: string;
  instructionEn?: string;
}

export interface CustomerOrderInput {
  usernameOrEmail?: string;
  password?: string;
  twoFactor?: string;
  note?: string;
}

export interface LinkDeliveryData {
  link: string;
  note?: string;
}

export interface ProvidedAccountDeliveryData {
  username: string;
  password: string;
  twoFactor?: string;
  note?: string;
}

export interface NoteOnlyDeliveryData {
  note?: string;
}

export type DeliveryOrderData =
  | LinkDeliveryData
  | ProvidedAccountDeliveryData
  | NoteOnlyDeliveryData;

const VALID_FIELD_KEYS = new Set<CustomerFieldKey>([
  'usernameOrEmail',
  'password',
  'twoFactor',
  'note',
]);

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_DELIVERY_NOTE_LENGTH = 1500;

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 255 && SIMPLE_EMAIL_PATTERN.test(trimmed);
}

export function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parsePlanHandleConfig(raw: unknown): PlanHandleConfig {
  const record = asRecord(raw);
  if (!record) return {};

  const out: PlanHandleConfig = {};
  const instructionVi = optionalTrimmedString(record.instructionVi);
  const instructionEn = optionalTrimmedString(record.instructionEn);
  if (instructionVi) out.instructionVi = instructionVi;
  if (instructionEn) out.instructionEn = instructionEn;

  if (Array.isArray(record.fields)) {
    const seen = new Set<CustomerFieldKey>();
    const parsedFields: HandleFieldConfig[] = [];

    for (const item of record.fields) {
      const entry = asRecord(item);
      if (!entry) continue;
      const key = entry.key;
      if (typeof key !== 'string' || !VALID_FIELD_KEYS.has(key as CustomerFieldKey)) {
        continue;
      }
      const typedKey = key as CustomerFieldKey;
      if (seen.has(typedKey)) continue;
      seen.add(typedKey);

      const field: HandleFieldConfig = {
        key: typedKey,
        required: Boolean(entry.required),
        validate: entry.validate === 'email' ? 'email' : 'text',
      };

      const labelVi = optionalTrimmedString(entry.labelVi);
      const labelEn = optionalTrimmedString(entry.labelEn);
      const promptVi = optionalTrimmedString(entry.promptVi);
      const promptEn = optionalTrimmedString(entry.promptEn);
      if (labelVi) field.labelVi = labelVi;
      if (labelEn) field.labelEn = labelEn;
      if (promptVi) field.promptVi = promptVi;
      if (promptEn) field.promptEn = promptEn;

      parsedFields.push(field);
    }

    out.fields = parsedFields;
  }

  return out;
}

export function resolveCheckoutFields(
  handleType: PlanHandleType,
  rawConfig: unknown,
): HandleFieldConfig[] {
  const parsed = parsePlanHandleConfig(rawConfig);
  if (Array.isArray(parsed.fields)) {
    return parsed.fields;
  }

  if (handleType === PlanHandleType.CUSTOMER_ACCOUNT) {
    return [
      {
        key: 'usernameOrEmail',
        required: true,
        validate: 'text',
      },
    ];
  }

  return [];
}

export function parseCustomerOrderInput(raw: unknown): CustomerOrderInput | null {
  const record = asRecord(raw);
  if (!record) return null;

  const cleaned: CustomerOrderInput = {};
  const usernameOrEmail = optionalTrimmedString(record.usernameOrEmail);
  const password = optionalTrimmedString(record.password);
  const twoFactor = optionalTrimmedString(record.twoFactor);
  const note = optionalTrimmedString(record.note);

  if (usernameOrEmail) cleaned.usernameOrEmail = usernameOrEmail;
  if (password) cleaned.password = password;
  if (twoFactor) cleaned.twoFactor = twoFactor;
  if (note) cleaned.note = note;

  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

export function parseDeliveryOrderData(raw: unknown): DeliveryOrderData | null {
  const record = asRecord(raw);
  if (!record) return null;

  const link = optionalTrimmedString(record.link);
  const username = optionalTrimmedString(record.username);
  const password = optionalTrimmedString(record.password);
  const twoFactor = optionalTrimmedString(record.twoFactor);
  const note = optionalTrimmedString(record.note);

  if (link) {
    return note ? { link, note } : { link };
  }
  if (username || password) {
    const out: ProvidedAccountDeliveryData = {
      username: username ?? '',
      password: password ?? '',
    };
    if (twoFactor) out.twoFactor = twoFactor;
    if (note) out.note = note;
    return out;
  }
  if (note) {
    return { note };
  }
  return null;
}

export function validateAndNormalizeDeliveryData(
  handleType: PlanHandleType,
  rawDeliveryData: unknown,
  legacyNote?: string,
): DeliveryOrderData | null {
  if (
    rawDeliveryData !== undefined
    && rawDeliveryData !== null
    && (typeof rawDeliveryData !== 'object' || Array.isArray(rawDeliveryData))
  ) {
    throw new BadRequestException('deliveryData must be a JSON object');
  }

  const record = asRecord(rawDeliveryData) ?? {};
  const note = optionalTrimmedString(record.note) ?? optionalTrimmedString(legacyNote);
  if (note && note.length > MAX_DELIVERY_NOTE_LENGTH) {
    throw new BadRequestException(
      `deliveryData.note must not exceed ${MAX_DELIVERY_NOTE_LENGTH} characters`,
    );
  }

  if (handleType === PlanHandleType.LINK) {
    const link = optionalTrimmedString(record.link);
    if (!link || !isValidHttpUrl(link)) {
      throw new BadRequestException(
        'deliveryData.link must be a valid http(s) URL for LINK plans',
      );
    }
    return note ? { link, note } : { link };
  }

  if (handleType === PlanHandleType.PROVIDED_ACCOUNT) {
    const username = optionalTrimmedString(record.username);
    const password = optionalTrimmedString(record.password);
    const twoFactor = optionalTrimmedString(record.twoFactor);
    if (!username || !password) {
      throw new BadRequestException(
        'deliveryData.username and deliveryData.password are required for PROVIDED_ACCOUNT plans',
      );
    }
    const result: ProvidedAccountDeliveryData = { username, password };
    if (twoFactor) result.twoFactor = twoFactor;
    if (note) result.note = note;
    return result;
  }

  return note ? { note } : null;
}

export function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function formatHandleTypeLabel(handleType: PlanHandleType, lang: 'vi' | 'en'): string {
  if (lang === 'en') {
    switch (handleType) {
      case PlanHandleType.LINK:
        return 'Activation Link';
      case PlanHandleType.CUSTOMER_ACCOUNT:
        return 'Customer Account';
      case PlanHandleType.PROVIDED_ACCOUNT:
        return 'Provided Account';
      case PlanHandleType.OTHER:
      default:
        return 'Other';
    }
  }

  switch (handleType) {
    case PlanHandleType.LINK:
      return 'Gửi link xác nhận';
    case PlanHandleType.CUSTOMER_ACCOUNT:
      return 'Tài khoản khách hàng';
    case PlanHandleType.PROVIDED_ACCOUNT:
      return 'Cấp tài khoản';
    case PlanHandleType.OTHER:
    default:
      return 'Khác';
  }
}
