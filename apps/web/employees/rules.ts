import type { Employee, EmployeeKind, EmployeeStatus, Fitness, FitnessReason } from '../app/types';

/**
 * Field rules of an employee, mirrored from the domain (`packages/domain/employees`). The server stays the
 * authority and answers a uniform 400 without saying which field failed, so the forms check the same rules
 * first and explain the problem next to the field.
 */
export { OPAQUE_ID, isPastOrToday, todayOf } from '../vehicles/rules';

export const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,59}$/u;
export const LABEL = /^[^\u0000-\u001f\u007f]{1,60}$/u;
export const EMPLOYEE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;
/** Catalog code of an identification type (`ine`, `curp`...). */
export const ID_TYPE = /^[a-z][a-z0-9_]{1,15}$/;
export const IDENTIFICATION = /^[A-Z0-9][A-Z0-9 ./-]{3,31}$/;
export const LICENSE_NUMBER = /^[A-Z0-9][A-Z0-9 ./-]{3,31}$/;
export const LICENSE_TYPE = /^[A-Z0-9][A-Z0-9 ._-]{0,15}$/;
export const PHONE = /^\+[1-9][0-9]{7,14}$/;
export const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MIN_DATE = '1950-01-01';
export const MAX_LICENSE_DATE = '2100-12-31';
export const MAX_REASON_LENGTH = 200;

export const normalizeName = (value: string): string => value.trim().replace(/\s+/g, ' ');
export const normalizeUpper = (value: string): string =>
  value.trim().toUpperCase().replace(/\s+/g, ' ');
export const normalizeEmail = (value: string): string => value.trim().toLowerCase();
/** International format: `+` and 8 to 15 digits; spaces, dots, hyphens and parentheses are dropped. */
export const normalizePhone = (value: string): string => value.replace(/[\s().-]/g, '');
export const normalizeCode = (value: string): string => value.trim().toLowerCase();

export const isReasonValid = (value: string): boolean => {
  const text = value.trim();
  return text.length >= 1 && text.length <= MAX_REASON_LENGTH && !CONTROL.test(text);
};

/** A real calendar date `YYYY-MM-DD` between `min` and `max` (inclusive). */
export function isDateBetween(value: string, min: string, max: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value &&
    value >= min &&
    value <= max
  );
}

/**
 * Allowed manual transitions (domain `STATUS_TRANSITIONS`): any live state moves to any other live state or
 * to `terminated`, which has no way out.
 */
export const STATUS_TRANSITIONS: Readonly<Record<EmployeeStatus, readonly EmployeeStatus[]>> = {
  active: ['inactive', 'suspended', 'terminated'],
  inactive: ['active', 'suspended', 'terminated'],
  suspended: ['active', 'inactive', 'terminated'],
  terminated: [],
};

export const canTransition = (from: EmployeeStatus, to: EmployeeStatus): boolean =>
  STATUS_TRANSITIONS[from].includes(to);

/** Only drivers carry license data and a fitness to operate. */
export const hasLicense = (kind: EmployeeKind): boolean => kind === 'driver';

/**
 * Derived fitness to operate (domain `fitnessOf`, BR-012): active, not archived, with a license (number, type
 * and expiry) whose last valid day (inclusive) is not before `today`. `null` for anyone who is not a driver.
 * Used by the mock only: the real BFF sends it ready-made.
 */
export function fitnessOf(
  employee: Pick<
    Employee,
    'kind' | 'status' | 'archivedAt' | 'licenseType' | 'licenseExpiresOn' | 'piiPresent'
  >,
  today: string,
): Fitness | null {
  if (employee.kind !== 'driver') return null;
  const reasons: FitnessReason[] = [];
  if (employee.archivedAt !== null) reasons.push('archived');
  if (employee.status !== 'active') reasons.push('not_active');
  if (
    !employee.piiPresent.licenseNumber ||
    employee.licenseType === null ||
    employee.licenseExpiresOn === null
  )
    reasons.push('license_missing');
  else if (employee.licenseExpiresOn < today) reasons.push('license_expired');
  return { fit: reasons.length === 0, reasons };
}
