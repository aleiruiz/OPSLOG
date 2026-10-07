import { MAX_REASON_LENGTH } from './types.js';
import { EmployeeError } from './errors.js';

export const invalid = (): never => {
  throw new EmployeeError('invalid_input');
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,59}$/u;
const LABEL = /^[^\u0000-\u001f\u007f]{1,60}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYEE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;
const CODE = /^[a-z][a-z0-9_]{1,15}$/;
const IDENTIFICATION = /^[A-Z0-9][A-Z0-9 ./-]{3,31}$/;
const LICENSE_NUMBER = /^[A-Z0-9][A-Z0-9 ./-]{3,31}$/;
const LICENSE_TYPE = /^[A-Z0-9][A-Z0-9 ._-]{0,15}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export const requireOpaqueId = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : invalid();

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const requireVersion = (value: unknown): number =>
  isInteger(value, 1, 2_147_483_646) ? value : invalid();

export const dateOf = (now: Date): string => now.toISOString().slice(0, 10);

export function normalizeName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return NAME.test(text) ? text : invalid();
}

/** Ordering key of an employee: last name, then first name, case-folded. Not unique. */
export const nameKey = (firstName: string, lastName: string): string =>
  `${lastName} ${firstName}`.toLowerCase();

export function normalizeEmployeeNumber(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return EMPLOYEE_NUMBER.test(text) ? text : invalid();
}

/** Uniqueness key of an employee number: case-insensitive. */
export const employeeNumberKey = (employeeNumber: string): string => employeeNumber.toLowerCase();

export function normalizePosition(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return LABEL.test(text) ? text : invalid();
}

export function normalizeDate(value: unknown, min: string, max: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOf(parsed) !== value || value < min || value > max)
    return invalid();
  return value;
}

export function normalizeCode(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CODE.test(text) ? text : invalid();
}

const squeeze = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, ' ') : '';

export function normalizeNationalId(value: unknown): string {
  const text = squeeze(value);
  return IDENTIFICATION.test(text) ? text : invalid();
}

export function normalizeLicenseNumber(value: unknown): string {
  const text = squeeze(value);
  return LICENSE_NUMBER.test(text) ? text : invalid();
}

export function normalizeLicenseType(value: unknown): string {
  const text = squeeze(value);
  return LICENSE_TYPE.test(text) ? text : invalid();
}

/** International format: `+` and 8 to 15 digits; spaces, dots, hyphens and parentheses are dropped. */
export function normalizePhone(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\s().-]/g, '') : '';
  return PHONE.test(text) ? text : invalid();
}

export function normalizeEmail(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text.length <= 254 && EMAIL.test(text) ? text : invalid();
}

/** Blind-index key of an identification: type plus the number without separators. */
export const nationalIdKey = (idType: string, nationalId: string): string =>
  `${idType}:${nationalId.replace(/[ ./-]/g, '')}`;
/** Blind-index key of a license number: separators and case do not matter. */
export const licenseNumberKey = (licenseNumber: string): string =>
  licenseNumber.replace(/[ ./-]/g, '');

/** A status-change reason: required, one line, at most 200 characters. */
export function normalizeReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= 1 && text.length <= MAX_REASON_LENGTH && !CONTROL.test(text)
    ? text
    : invalid();
}

export type Fields = Readonly<Record<string, unknown>>;

export function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

export const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);
