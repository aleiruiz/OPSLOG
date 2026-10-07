import type { ApiError } from '@opslog/contracts';
import {
  EXPIRING_WINDOW_DAYS,
  MAX_EXPIRY_DATE,
  MIN_DATE,
  REFERENCE_NUMBER,
  isDateBetween,
  normalizeReference,
} from '../documents/rules';
import type { Document, Result } from './types';

export const NOW = '2026-10-06T12:00:00.000Z';
export const DAY_MS = 86_400_000;
export const NO_EXPIRY_KEY = '9999-12-31';
let correlation = 0;

export function failure(
  status: ApiError['status'],
  code: string,
  message: string,
  field?: string,
): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      correlationId: `corr-mock-document-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const badRequest = () => failure(400, 'bad_request', 'Invalid request');
export const notFound = () => failure(404, 'not_found', 'Resource not found');
export const invalidOwner = () =>
  failure(422, 'invalid_owner', 'Unprocessable request', 'owner_id');
export const conflict = (code: 'stale_version' | 'immutable') => failure(409, code, 'Conflict');

export const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

/** Derived state as of the server clock: never stored. */
export function derive(
  document: Document,
  today: string,
): Pick<Document, 'status' | 'daysToExpiry'> {
  if (document.expiresOn === null) return { status: 'valid', daysToExpiry: null };
  const days = Math.round(
    (Date.parse(`${document.expiresOn}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) /
      DAY_MS,
  );
  return {
    status: days < 0 ? 'expired' : days <= EXPIRING_WINDOW_DAYS ? 'expiring' : 'valid',
    daysToExpiry: days,
  };
}

export interface Validity {
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
}

export interface StoredRevision extends Validity {
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
}

/** Validates the validity fields of a creation or a renewal; `null` when anything is invalid. */
export function parseValidity(
  fields: Readonly<Record<string, unknown>>,
  required: boolean,
  today: string,
): Validity | null {
  const date = (key: string, max: string): string | null | undefined => {
    const value = fields[key];
    if (value === undefined || value === null) return null;
    return typeof value === 'string' && isDateBetween(value, MIN_DATE, max) ? value : undefined;
  };
  const issuedOn = date('issuedOn', today);
  const expiresOn = date('expiresOn', MAX_EXPIRY_DATE);
  if (issuedOn === undefined || expiresOn === undefined) return null;
  if (required && expiresOn === null) return null;
  if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn) return null;
  const raw = fields['documentNumber'];
  let documentNumber: string | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string') return null;
    documentNumber = normalizeReference(raw);
    if (!REFERENCE_NUMBER.test(documentNumber)) return null;
  }
  return { issuedOn, expiresOn, documentNumber };
}

export const onlyKeys = (fields: Readonly<Record<string, unknown>>, allowed: readonly string[]) =>
  Object.keys(fields).every((key) => allowed.includes(key));

/** Earlier revisions of a seeded document are synthetic: one year apart, oldest first. */
export function seedRevisions(rows: readonly Document[]): Map<string, StoredRevision[]> {
  return new Map<string, StoredRevision[]>(
    rows.map((document) => [
      document.id,
      Array.from({ length: document.revision }, (_, index): StoredRevision => {
        const revision = index + 1;
        const back = (document.revision - revision) * 365;
        const move = (day: string | null) =>
          day === null
            ? null
            : new Date(Date.parse(`${day}T00:00:00.000Z`) - back * DAY_MS)
                .toISOString()
                .slice(0, 10);
        return {
          revision,
          issuedOn: move(document.issuedOn),
          expiresOn: move(document.expiresOn),
          documentNumber: document.documentNumber,
          actorId: 'user-admin',
          at: document.createdAt,
        };
      }),
    ]),
  );
}
