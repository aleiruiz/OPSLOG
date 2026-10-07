import type { ApiError } from '@opslog/contracts';
import { BFF_COVERAGE_TYPES } from '@opslog/contracts';
import {
  MAX_EXPIRY_DATE,
  MIN_DATE,
  REFERENCE_NUMBER,
  isDateBetween,
  normalizeReference,
} from '../documents/rules';
import { CURRENCY, MAX_BASIS_POINTS, MAX_DEDUCTIBLE_MINOR } from '../insurance/rules';
import type { CoverageType, Deductible, InsurancePolicy, Result } from './types';

export const NOW = '2026-10-06T12:00:00.000Z';
export const DAY_MS = 86_400_000;
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
      correlationId: `corr-mock-policy-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const badRequest = () => failure(400, 'bad_request', 'Invalid request');
export const notFound = () => failure(404, 'not_found', 'Resource not found');
export const forbidden = () => failure(403, 'forbidden', 'Permission denied');
export const invalidVehicle = () =>
  failure(422, 'invalid_vehicle', 'Unprocessable request', 'vehicle_id');
export const conflict = (code: 'stale_version' | 'immutable') => failure(409, code, 'Conflict');

export const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

export const onlyKeys = (fields: Readonly<Record<string, unknown>>, allowed: readonly string[]) =>
  Object.keys(fields).every((key) => allowed.includes(key));

export const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export function parseDeductible(value: unknown): Deductible | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Readonly<Record<string, unknown>>;
  if (fields['kind'] === 'amount') {
    const { amountMinor, currency } = fields;
    return onlyKeys(fields, ['kind', 'amountMinor', 'currency']) &&
      isInt(amountMinor, 1, MAX_DEDUCTIBLE_MINOR) &&
      typeof currency === 'string' &&
      CURRENCY.test(currency)
      ? { kind: 'amount', amountMinor, currency }
      : null;
  }
  if (fields['kind'] === 'percent') {
    const { basisPoints } = fields;
    return onlyKeys(fields, ['kind', 'basisPoints']) && isInt(basisPoints, 1, MAX_BASIS_POINTS)
      ? { kind: 'percent', basisPoints }
      : null;
  }
  return null;
}

export interface Period {
  readonly startsOn: string;
  readonly endsOn: string;
}

export function parsePeriod(fields: Readonly<Record<string, unknown>>): Period | null {
  const { startsOn, endsOn } = fields;
  return typeof startsOn === 'string' &&
    typeof endsOn === 'string' &&
    isDateBetween(startsOn, MIN_DATE, MAX_EXPIRY_DATE) &&
    isDateBetween(endsOn, MIN_DATE, MAX_EXPIRY_DATE) &&
    endsOn >= startsOn
    ? { startsOn, endsOn }
    : null;
}

export const parseNumber = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = normalizeReference(value);
  return REFERENCE_NUMBER.test(text) ? text : null;
};
export const isCoverage = (value: unknown): value is CoverageType =>
  typeof value === 'string' && (BFF_COVERAGE_TYPES as readonly string[]).includes(value);

export interface RevisionData extends Period {
  readonly policyNumber: string;
  readonly coverageType: CoverageType;
  readonly deductible: Deductible | null;
}
export interface StoredRevision extends RevisionData {
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
}

/** Earlier revisions of a seeded policy are synthetic: one year apart, oldest first. */
export function seedRevisions(rows: readonly InsurancePolicy[]): Map<string, StoredRevision[]> {
  return new Map<string, StoredRevision[]>(
    rows.map((policy) => [
      policy.id,
      Array.from({ length: policy.revision }, (_, index): StoredRevision => {
        const revision = index + 1;
        const back = (policy.revision - revision) * 365 * DAY_MS;
        const move = (day: string) =>
          new Date(Date.parse(`${day}T00:00:00.000Z`) - back).toISOString().slice(0, 10);
        return {
          revision,
          policyNumber: policy.policyNumber,
          coverageType: policy.coverageType,
          startsOn: move(policy.startsOn),
          endsOn: move(policy.endsOn),
          deductible: policy.deductible,
          actorId: 'user-admin',
          at: policy.createdAt,
        };
      }),
    ]),
  );
}
