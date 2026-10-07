import type { ApiError } from '@opslog/contracts';
import { demoEmployees, type EmployeePiiValues } from '../employees/fixtures';
import {
  EMAIL,
  EMPLOYEE_NUMBER,
  ID_TYPE,
  IDENTIFICATION,
  LABEL,
  LICENSE_NUMBER,
  LICENSE_TYPE,
  MAX_LICENSE_DATE,
  MIN_DATE,
  NAME,
  OPAQUE_ID,
  PHONE,
  isDateBetween,
  normalizeCode,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeUpper,
} from '../employees/rules';
import type {
  Employee,
  EmployeeDetail,
  EmployeeHistoryEntry,
  EmployeeStatus,
  Page,
  Result,
} from './types';

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
      correlationId: `corr-mock-employee-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const badRequest = () => failure(400, 'bad_request', 'Invalid request');
export const notFound = () => failure(404, 'not_found', 'Resource not found');
export const invalidArea = () => failure(422, 'invalid_area', 'Unprocessable request', 'area_id');
export const conflict = (code: 'stale_version' | 'immutable' | 'invalid_transition') =>
  failure(409, code, 'Conflict');
export const duplicate = (field: string) => failure(409, 'duplicate', 'Conflict', field);

export const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

export const CREATE_KEYS = [
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
export const LICENSE_KEYS = ['licenseNumber', 'licenseType', 'licenseExpiresOn'] as const;

export type Row = EmployeeDetail & { readonly pii: EmployeePiiValues };

interface Core {
  firstName: string;
  lastName: string;
  employeeNumber: string | null;
  position: string | null;
  hireDate: string | null;
  areaId: string;
  idType: string | null;
  licenseType: string | null;
  licenseExpiresOn: string | null;
}
export type Parsed = { core: Partial<Core>; pii: Partial<EmployeePiiValues> };

/** Validates and normalizes the fields that are present; `null` when anything is invalid. */
export function parseFields(
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  today: string,
): Parsed | null {
  if (Object.keys(input).some((key) => !allowed.includes(key))) return null;
  const core: { -readonly [K in keyof Core]?: Core[K] } = {};
  const pii: { -readonly [K in keyof EmployeePiiValues]?: string | null } = {};
  const has = (key: string) => Object.hasOwn(input, key);
  const text = (key: string, pattern: RegExp, normalize: (value: string) => string) => {
    const value = input[key];
    if (typeof value !== 'string') return undefined;
    const normalized = normalize(value);
    return pattern.test(normalized) ? normalized : undefined;
  };
  /** `null` clears; otherwise the normalized text, or `false` when invalid. */
  const nullable = (key: string, pattern: RegExp, normalize: (value: string) => string) =>
    input[key] === null ? null : (text(key, pattern, normalize) ?? false);

  for (const key of ['firstName', 'lastName'] as const) {
    if (!has(key)) continue;
    const value = text(key, NAME, normalizeName);
    if (value === undefined) return null;
    core[key] = value;
  }
  if (has('areaId')) {
    const value = input['areaId'];
    if (typeof value !== 'string' || !OPAQUE_ID.test(value)) return null;
    core.areaId = value;
  }
  const simple: [keyof Core, RegExp, (value: string) => string][] = [
    ['employeeNumber', EMPLOYEE_NUMBER, (value) => value.trim()],
    ['position', LABEL, (value) => value.trim()],
    ['licenseType', LICENSE_TYPE, normalizeUpper],
  ];
  for (const [key, pattern, normalize] of simple) {
    if (!has(key)) continue;
    const value = nullable(key, pattern, normalize);
    if (value === false) return null;
    (core as Record<string, unknown>)[key] = value;
  }
  if (has('hireDate')) {
    const value = input['hireDate'];
    if (value !== null && (typeof value !== 'string' || !isDateBetween(value, MIN_DATE, today)))
      return null;
    core.hireDate = value as string | null;
  }
  if (has('licenseExpiresOn')) {
    const value = input['licenseExpiresOn'];
    if (
      value !== null &&
      (typeof value !== 'string' || !isDateBetween(value, MIN_DATE, MAX_LICENSE_DATE))
    )
      return null;
    core.licenseExpiresOn = value as string | null;
  }
  // `idType` and `nationalId` go together (both set or both cleared).
  if (has('idType') || has('nationalId')) {
    if (!has('idType') || !has('nationalId')) return null;
    if ((input['idType'] === null) !== (input['nationalId'] === null)) return null;
    if (input['idType'] === null) {
      core.idType = null;
      pii.nationalId = null;
    } else {
      const idType = text('idType', ID_TYPE, normalizeCode);
      const nationalId = text('nationalId', IDENTIFICATION, normalizeUpper);
      if (idType === undefined || nationalId === undefined) return null;
      core.idType = idType;
      pii.nationalId = nationalId;
    }
  }
  for (const [key, pattern, normalize] of [
    ['phone', PHONE, normalizePhone],
    ['email', EMAIL, normalizeEmail],
    ['licenseNumber', LICENSE_NUMBER, normalizeUpper],
  ] as const) {
    if (!has(key)) continue;
    const value = nullable(key, pattern, normalize);
    if (value === false || (key === 'email' && typeof value === 'string' && value.length > 254))
      return null;
    pii[key] = value;
  }
  return { core, pii };
}

export const idKey = (idType: string | null, nationalId: string) =>
  `${idType}:${nationalId.replace(/[ ./-]/g, '')}`;
export const sortKey = (employee: Pick<Employee, 'firstName' | 'lastName'>) =>
  `${employee.lastName} ${employee.firstName}`.toLowerCase();
export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The demo staff, with a long history on the first employee so the history needs a second page. */
export const demoMockEmployees = (): EmployeeDetail[] =>
  demoEmployees().map((employee) =>
    employee.id === 'emp-001' ? { ...employee, version: 31 } : employee,
  );

export const pageWindow = (query: { limit?: number; cursor?: string }) => {
  const limit = query.limit ?? 25;
  const offset = query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
  return [25, 50, 100].includes(limit) && Number.isSafeInteger(offset) ? { limit, offset } : null;
};
export const page = <T>(
  items: readonly T[],
  limit: number,
  offset: number,
  field: string,
): Page<T> => {
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? `mock:${next}` : null,
    total: items.length,
    sort: { field, direction: field === 'lastName' ? 'asc' : 'desc' },
  };
};

/** Builds one history entry; the caller owns the sequence that numbers them. */
export type HistoryEntryFactory = (
  id: string,
  kind: EmployeeHistoryEntry['kind'],
  from: string | null,
  to: string,
  reason: string | null,
  actorId: string,
  version: number,
  at: string,
) => EmployeeHistoryEntry;

export function seedHistory(
  rows: readonly Row[],
  entry: HistoryEntryFactory,
): Map<string, EmployeeHistoryEntry[]> {
  // Every employee starts with a believable history: the hiring and, for long-lived ones, status changes.
  const history = new Map<string, EmployeeHistoryEntry[]>();
  for (const row of rows) {
    const entries = [
      entry(row.id, 'status', null, 'active', 'Alta', 'user-admin', 1, row.createdAt),
    ];
    let state: EmployeeStatus = 'active';
    for (let version = 2; version <= row.version; version += 1) {
      const last = version === row.version;
      const to: EmployeeStatus = last ? row.status : state === 'active' ? 'suspended' : 'active';
      if (to === state) continue;
      entries.push(
        entry(
          row.id,
          'status',
          state,
          to,
          last ? row.statusReason : 'Cambio de estado de demostración',
          'user-admin',
          version,
          last ? row.updatedAt : row.createdAt,
        ),
      );
      state = to;
    }
    history.set(row.id, entries);
  }
  return history;
}
