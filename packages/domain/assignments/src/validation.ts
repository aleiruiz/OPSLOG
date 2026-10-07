import { requireOpaqueId, requireVersion } from '../../documents/src/index.js';
import { AssignmentError } from './errors.js';
import { isAssignmentType, type NewAssignmentData } from './types.js';

export const invalid = (): never => {
  throw new AssignmentError('invalid_input');
};

const REASON = /^[^\u0000-\u001f\u007f]{1,200}$/u;

export function normalizeReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return REASON.test(text) ? text : invalid();
}

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);

/** The shared opaque-id and version guards raise `DocumentError`; assignments raise their own error. */
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

export const CREATE_FIELDS = ['vehicleId', 'employeeId', 'type', 'reason', 'replace'] as const;

export const END_FIELDS = ['reason'] as const;

/** Validates a new assignment. Unknown properties are rejected; `replace` only makes sense for a principal. */
export function parseNewAssignment(input: unknown): NewAssignmentData {
  const fields = asFields(input, CREATE_FIELDS);
  if (['vehicleId', 'employeeId', 'type', 'reason'].some((key) => !has(fields, key)))
    return invalid();
  const type = fields['type'];
  if (!isAssignmentType(type)) return invalid();
  const replace = fields['replace'];
  if (replace !== undefined && typeof replace !== 'boolean') return invalid();
  if (replace === true && type !== 'principal') return invalid();
  return {
    vehicleId: guardId(fields['vehicleId']),
    employeeId: guardId(fields['employeeId']),
    type,
    reason: normalizeReason(fields['reason']),
    replace: replace ?? false,
  };
}

/** Closing an assignment needs a reason. */
export function parseEnd(input: unknown): { readonly reason: string } {
  const fields = asFields(input, END_FIELDS);
  if (!has(fields, 'reason')) return invalid();
  return { reason: normalizeReason(fields['reason']) };
}
