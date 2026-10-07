import { MAX_LICENSE_DATE, MIN_DATE, isEmployeeKind } from './types.js';
import type { EmployeeKind } from './types.js';
import {
  asFields,
  dateOf,
  has,
  invalid,
  normalizeCode,
  normalizeDate,
  normalizeEmail,
  normalizeEmployeeNumber,
  normalizeLicenseNumber,
  normalizeLicenseType,
  normalizeName,
  normalizeNationalId,
  normalizePhone,
  normalizePosition,
  requireOpaqueId,
} from './validation.js';
import type { Fields } from './validation.js';

export const CREATE_FIELDS = [
  'kind',
  'firstName',
  'lastName',
  'employeeNumber',
  'position',
  'hireDate',
  'areaId',
  'idType',
  'nationalId',
  'phone',
  'email',
  'licenseNumber',
  'licenseType',
  'licenseExpiresOn',
] as const;
export const UPDATE_FIELDS = CREATE_FIELDS.filter((key) => key !== 'kind');
export const LICENSE_KEYS = ['licenseNumber', 'licenseType', 'licenseExpiresOn'] as const;

/** Plaintext personal data of an input, already normalized. Never stored in this form. */
export interface PiiInput {
  readonly nationalId?: { readonly idType: string; readonly value: string } | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly licenseNumber?: string | null;
}

export interface EmployeeCore {
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeNumber: string | null;
  readonly position: string | null;
  readonly hireDate: string | null;
  readonly areaId: string;
  readonly licenseType: string | null;
  readonly licenseExpiresOn: string | null;
}
export interface NewEmployeeData {
  readonly kind: EmployeeKind;
  readonly core: EmployeeCore;
  readonly pii: PiiInput;
}

const optional = <T>(fields: Fields, key: string, parse: (value: unknown) => T): T | null =>
  has(fields, key) && fields[key] !== null && fields[key] !== undefined ? parse(fields[key]) : null;

/** Reads the identification pair: `idType` and `nationalId` are given together or not at all. */
function parseIdentification(fields: Fields): PiiInput['nationalId'] | undefined {
  const typed = has(fields, 'idType');
  const numbered = has(fields, 'nationalId');
  if (!typed && !numbered) return undefined;
  if (!typed || !numbered) return invalid();
  const idType = fields['idType'];
  const value = fields['nationalId'];
  if ((idType === null) !== (value === null)) return invalid();
  return idType === null
    ? null
    : { idType: normalizeCode(idType), value: normalizeNationalId(value) };
}

/** Validates and normalizes the data of a new employee. Unknown properties are rejected. */
export function parseNewEmployee(input: unknown, now: Date): NewEmployeeData {
  const fields = asFields(input, CREATE_FIELDS);
  if (['kind', 'firstName', 'lastName', 'areaId'].some((key) => !has(fields, key)))
    return invalid();
  const kind = fields['kind'];
  if (!isEmployeeKind(kind)) return invalid();
  if (kind !== 'driver' && LICENSE_KEYS.some((key) => has(fields, key))) return invalid();
  const identification = parseIdentification(fields);
  const licenseNumber = optional(fields, 'licenseNumber', normalizeLicenseNumber);
  const licenseType = optional(fields, 'licenseType', normalizeLicenseType);
  const licenseExpiresOn = optional(fields, 'licenseExpiresOn', (value) =>
    normalizeDate(value, MIN_DATE, MAX_LICENSE_DATE),
  );
  return {
    kind,
    core: {
      firstName: normalizeName(fields['firstName']),
      lastName: normalizeName(fields['lastName']),
      employeeNumber: optional(fields, 'employeeNumber', normalizeEmployeeNumber),
      position: optional(fields, 'position', normalizePosition),
      hireDate: optional(fields, 'hireDate', (value) =>
        normalizeDate(value, MIN_DATE, dateOf(now)),
      ),
      areaId: requireOpaqueId(fields['areaId']),
      licenseType,
      licenseExpiresOn,
    },
    pii: {
      ...(identification ? { nationalId: identification } : {}),
      ...(has(fields, 'phone') && fields['phone'] !== null
        ? { phone: normalizePhone(fields['phone']) }
        : {}),
      ...(has(fields, 'email') && fields['email'] !== null
        ? { email: normalizeEmail(fields['email']) }
        : {}),
      ...(licenseNumber === null ? {} : { licenseNumber }),
    },
  };
}

export interface EmployeePatch {
  readonly core: { -readonly [K in keyof EmployeeCore]?: EmployeeCore[K] };
  readonly pii: { -readonly [K in keyof PiiInput]?: PiiInput[K] };
  /** `idType` alone changes nothing: it only travels with `nationalId`. */
  readonly idType?: string | null;
}

/**
 * Validates a partial update; only the fields that are present are returned, and `null` clears an
 * optional one. At least one field is required.
 */
export function parseEmployeePatch(input: unknown, now: Date): EmployeePatch {
  const fields = asFields(input, UPDATE_FIELDS);
  if (Object.keys(fields).length === 0) return invalid();
  const core: { -readonly [K in keyof EmployeeCore]?: EmployeeCore[K] } = {};
  const pii: { -readonly [K in keyof PiiInput]?: PiiInput[K] } = {};
  const nullable = <T>(key: string, parse: (value: unknown) => T): T | null | undefined =>
    has(fields, key) ? (fields[key] === null ? null : parse(fields[key])) : undefined;
  if (has(fields, 'firstName')) core.firstName = normalizeName(fields['firstName']);
  if (has(fields, 'lastName')) core.lastName = normalizeName(fields['lastName']);
  if (has(fields, 'areaId')) core.areaId = requireOpaqueId(fields['areaId']);
  const set = <K extends keyof EmployeeCore>(key: K, value: EmployeeCore[K] | undefined): void => {
    if (value !== undefined) core[key] = value;
  };
  set('employeeNumber', nullable('employeeNumber', normalizeEmployeeNumber));
  set('position', nullable('position', normalizePosition));
  set(
    'hireDate',
    nullable('hireDate', (value) => normalizeDate(value, MIN_DATE, dateOf(now))),
  );
  set('licenseType', nullable('licenseType', normalizeLicenseType));
  set(
    'licenseExpiresOn',
    nullable('licenseExpiresOn', (value) => normalizeDate(value, MIN_DATE, MAX_LICENSE_DATE)),
  );
  const identification = parseIdentification(fields);
  if (identification !== undefined) pii.nationalId = identification;
  const phone = nullable('phone', normalizePhone);
  if (phone !== undefined) pii.phone = phone;
  const email = nullable('email', normalizeEmail);
  if (email !== undefined) pii.email = email;
  const licenseNumber = nullable('licenseNumber', normalizeLicenseNumber);
  if (licenseNumber !== undefined) pii.licenseNumber = licenseNumber;
  return { core, pii };
}
