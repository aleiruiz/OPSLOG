import { DocumentError } from './errors.js';
import {
  DOCUMENT_TYPES,
  MAX_EXPIRY_DATE,
  MIN_DATE,
  isDocumentType,
  isOwnerType,
  type DocumentOwnerType,
  type DocumentPatch,
  type ExpiryRule,
  type NewDocumentData,
  type RevisionData,
} from './types.js';

export const invalid = (): never => {
  throw new DocumentError('invalid_input');
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const TITLE = /^[^\u0000-\u001f\u007f]{1,80}$/u;

const NOTES = /^[^\u0000-\u001f\u007f]{1,500}$/u;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DOCUMENT_NUMBER = /^[A-Z0-9][A-Z0-9 ./-]{0,39}$/;

export const requireOpaqueId = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : invalid();

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const requireVersion = (value: unknown): number =>
  isInteger(value, 1, 2_147_483_646) ? value : invalid();

export const dateOf = (now: Date): string => now.toISOString().slice(0, 10);

/** The calendar day `days` after `day` (`YYYY-MM-DD`, UTC arithmetic). */
export const addDays = (day: string, days: number): string =>
  dateOf(new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000));

export const DAY_MS = 86_400_000;

function normalizeDate(value: unknown, min: string, max: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOf(parsed) !== value || value < min || value > max)
    return invalid();
  return value;
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function normalizeTitle(value: unknown): string {
  const text = trimmed(value).replace(/\s+/g, ' ');
  return TITLE.test(text) ? text : invalid();
}

function normalizeNotes(value: unknown): string {
  const text = trimmed(value);
  return NOTES.test(text) ? text : invalid();
}

export function normalizeDocumentNumber(value: unknown): string {
  const text = trimmed(value).toUpperCase().replace(/\s+/g, ' ');
  return DOCUMENT_NUMBER.test(text) ? text : invalid();
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);

const optional = <T>(fields: Fields, key: string, parse: (value: unknown) => T): T | null =>
  has(fields, key) && fields[key] !== null && fields[key] !== undefined ? parse(fields[key]) : null;

export const REVISION_FIELDS = ['issuedOn', 'expiresOn', 'documentNumber'] as const;

export const CREATE_FIELDS = [
  'ownerType',
  'ownerId',
  'typeCode',
  'title',
  'notes',
  ...REVISION_FIELDS,
] as const;

export const UPDATE_FIELDS = ['title', 'notes'] as const;

/** Validates the validity fields: dates are real calendar days, expiry is not before issue. */
function parseRevisionData(fields: Fields, now: Date, rule: ExpiryRule): RevisionData {
  const issuedOn = optional(fields, 'issuedOn', (value) =>
    normalizeDate(value, MIN_DATE, dateOf(now)),
  );
  const expiresOn = optional(fields, 'expiresOn', (value) =>
    normalizeDate(value, MIN_DATE, MAX_EXPIRY_DATE),
  );
  if (rule === 'required' && expiresOn === null) return invalid();
  if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn) return invalid();
  return {
    issuedOn,
    expiresOn,
    documentNumber: optional(fields, 'documentNumber', normalizeDocumentNumber),
  };
}

/** Validates the data of a new document. Unknown properties are rejected. */
export function parseNewDocument(input: unknown, now: Date): NewDocumentData {
  const fields = asFields(input, CREATE_FIELDS);
  if (['ownerType', 'ownerId', 'typeCode', 'title'].some((key) => !has(fields, key)))
    return invalid();
  const ownerType = fields['ownerType'];
  if (!isOwnerType(ownerType)) return invalid();
  const typeCode = fields['typeCode'];
  if (!isDocumentType(ownerType, typeCode)) return invalid();
  return {
    ownerType,
    ownerId: requireOpaqueId(fields['ownerId']),
    typeCode,
    title: normalizeTitle(fields['title']),
    notes: optional(fields, 'notes', normalizeNotes),
    revision: parseRevisionData(fields, now, DOCUMENT_TYPES[ownerType][typeCode] as ExpiryRule),
  };
}

/** Validates a renewal: the same validity fields as a new document, for an existing one. */
export function parseRenewal(
  input: unknown,
  now: Date,
  ownerType: DocumentOwnerType,
  typeCode: string,
): RevisionData {
  const fields = asFields(input, REVISION_FIELDS);
  return parseRevisionData(fields, now, DOCUMENT_TYPES[ownerType][typeCode] as ExpiryRule);
}

/** Only the title and the notes are editable in place; at least one field is required. */
export function parseDocumentPatch(input: unknown): DocumentPatch {
  const fields = asFields(input, UPDATE_FIELDS);
  if (Object.keys(fields).length === 0) return invalid();
  return {
    ...(has(fields, 'title') ? { title: normalizeTitle(fields['title']) } : {}),
    ...(has(fields, 'notes')
      ? { notes: fields['notes'] === null ? null : normalizeNotes(fields['notes']) }
      : {}),
  };
}
