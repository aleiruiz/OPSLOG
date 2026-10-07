import {
  MAX_EXPIRY_DATE,
  MIN_DATE,
  dateOf,
  requireOpaqueId,
  requireVersion,
} from '../../documents/src/index.js';
import { PolicyError } from './errors.js';
import {
  MAX_DEDUCTIBLE_BASIS_POINTS,
  MAX_DEDUCTIBLE_MINOR,
  isCoverageType,
  type Deductible,
  type NewPolicyData,
  type PolicyPatch,
  type PolicyRevisionData,
} from './types.js';

export const invalid = (): never => {
  throw new PolicyError('invalid_input');
};

const INSURER = /^[^\u0000-\u001f\u007f]{2,80}$/u;

const NOTES = /^[^\u0000-\u001f\u007f]{1,500}$/u;

const POLICY_NUMBER = /^[A-Z0-9][A-Z0-9 ./-]{0,39}$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CURRENCY = /^[A-Z]{3}$/;

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function normalizeDate(value: unknown): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    dateOf(parsed) !== value ||
    value < MIN_DATE ||
    value > MAX_EXPIRY_DATE
  )
    return invalid();
  return value;
}

export function normalizeInsurer(value: unknown): string {
  const text = trimmed(value).replace(/\s+/g, ' ');
  return INSURER.test(text) ? text : invalid();
}

function normalizeNotes(value: unknown): string {
  const text = trimmed(value);
  return NOTES.test(text) ? text : invalid();
}

export function normalizePolicyNumber(value: unknown): string {
  const text = trimmed(value).toUpperCase().replace(/\s+/g, ' ');
  return POLICY_NUMBER.test(text) ? text : invalid();
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);

/** Validates a deductible: exactly the keys of its kind, integers in range, an ISO currency. */
export function parseDeductible(value: unknown): Deductible {
  const kind = typeof value === 'object' && value !== null ? (value as Fields)['kind'] : undefined;
  if (kind === 'amount') {
    const fields = asFields(value, ['kind', 'amountMinor', 'currency']);
    const { amountMinor, currency } = fields;
    if (!isInteger(amountMinor, 1, MAX_DEDUCTIBLE_MINOR)) return invalid();
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) return invalid();
    return { kind: 'amount', amountMinor, currency };
  }
  if (kind === 'percent') {
    const fields = asFields(value, ['kind', 'basisPoints']);
    const { basisPoints } = fields;
    if (!isInteger(basisPoints, 1, MAX_DEDUCTIBLE_BASIS_POINTS)) return invalid();
    return { kind: 'percent', basisPoints };
  }
  return invalid();
}

/**
 * True when the input mentions the deductible at all, an explicit `null` included: the composition
 * then asks for `view_costs`. Only omitting the key is free (a renewal then carries it over), so a
 * caller without the permission can neither set, change nor erase the amount, and a malformed
 * value is a 403 before it is ever validated.
 */
export const writesDeductible = (input: unknown): boolean =>
  typeof input === 'object' &&
  input !== null &&
  !Array.isArray(input) &&
  Object.hasOwn(input, 'deductible');

export const REVISION_FIELDS = [
  'policyNumber',
  'coverageType',
  'startsOn',
  'endsOn',
  'deductible',
] as const;

export const CREATE_FIELDS = ['vehicleId', 'insurer', 'coverageNotes', ...REVISION_FIELDS] as const;

export const UPDATE_FIELDS = ['insurer', 'coverageNotes'] as const;

export const RENEW_FIELDS = REVISION_FIELDS;

function parsePeriod(fields: Fields): { startsOn: string; endsOn: string } {
  if (!has(fields, 'startsOn') || !has(fields, 'endsOn')) return invalid();
  const startsOn = normalizeDate(fields['startsOn']);
  const endsOn = normalizeDate(fields['endsOn']);
  return endsOn < startsOn ? invalid() : { startsOn, endsOn };
}

/** Validates a new policy. Unknown properties are rejected; a missing deductible means none. */
export function parseNewPolicy(input: unknown): NewPolicyData {
  const fields = asFields(input, CREATE_FIELDS);
  if (['vehicleId', 'insurer', 'policyNumber', 'coverageType'].some((key) => !has(fields, key)))
    return invalid();
  const coverageType = fields['coverageType'];
  if (!isCoverageType(coverageType)) return invalid();
  const notes = fields['coverageNotes'];
  const deductible = fields['deductible'];
  return {
    vehicleId: guardId(fields['vehicleId']),
    insurer: normalizeInsurer(fields['insurer']),
    coverageNotes: notes === undefined || notes === null ? null : normalizeNotes(notes),
    revision: {
      policyNumber: normalizePolicyNumber(fields['policyNumber']),
      coverageType,
      ...parsePeriod(fields),
      deductible:
        deductible === undefined || deductible === null ? null : parseDeductible(deductible),
    },
  };
}

/**
 * Validates a renewal. The new period is required; the policy number, the coverage type and the
 * deductible are carried over from the current revision when absent (an explicit `null`
 * deductible removes it). Carrying the deductible over lets a caller without `view_costs` renew
 * a policy without ever reading or erasing the amount.
 */
export function parseRenewal(input: unknown, current: PolicyRevisionData): PolicyRevisionData {
  const fields = asFields(input, RENEW_FIELDS);
  const coverageType = has(fields, 'coverageType') ? fields['coverageType'] : current.coverageType;
  if (!isCoverageType(coverageType)) return invalid();
  const deductible = fields['deductible'];
  return {
    policyNumber: has(fields, 'policyNumber')
      ? normalizePolicyNumber(fields['policyNumber'])
      : current.policyNumber,
    coverageType,
    ...parsePeriod(fields),
    deductible: !has(fields, 'deductible')
      ? current.deductible
      : deductible === null
        ? null
        : parseDeductible(deductible),
  };
}

/** Only the insurer name and the notes are editable in place; at least one field is required. */
export function parsePolicyPatch(input: unknown): PolicyPatch {
  const fields = asFields(input, UPDATE_FIELDS);
  if (Object.keys(fields).length === 0) return invalid();
  return {
    ...(has(fields, 'insurer') ? { insurer: normalizeInsurer(fields['insurer']) } : {}),
    ...(has(fields, 'coverageNotes')
      ? {
          coverageNotes:
            fields['coverageNotes'] === null ? null : normalizeNotes(fields['coverageNotes']),
        }
      : {}),
  };
}

/** The shared opaque-id and version guards raise `DocumentError`; policies raise their own error. */
export function guardId(value: unknown): string {
  try {
    return requireOpaqueId(value);
  } catch {
    return invalid();
  }
}

export function guardVersion(value: unknown): number {
  try {
    return requireVersion(value);
  } catch {
    return invalid();
  }
}
