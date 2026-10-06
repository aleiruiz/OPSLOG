import { randomUUID } from 'node:crypto';
import type { PiiCipher } from '../../../platform/pii/src/index.js';

/**
 * Employee kinds (BRD §17 `Employee`: `Driver` / `Dispatcher` / `Other`). Only a driver has license
 * data and a fitness to operate. Mechanics are a separate BRD entity and are not part of this slice.
 */
export const EMPLOYEE_KINDS = ['driver', 'dispatcher', 'other'] as const;
export type EmployeeKind = (typeof EMPLOYEE_KINDS)[number];

/**
 * Employee statuses (BRD §7.2.1: `Activo`, `Inactivo`, `Suspendido`, `Baja`). `terminated` is the
 * BRD's `Baja`: terminal, read-only, history is kept. Ids are English snake_case; labels belong to
 * the web layer.
 */
export const EMPLOYEE_STATUSES = ['active', 'inactive', 'suspended', 'terminated'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/**
 * Allowed manual transitions. The BRD lists the states but no matrix (open question in the task
 * document): any live state moves to any other live state or to `terminated`, which has no way out.
 */
export const STATUS_TRANSITIONS: Readonly<Record<EmployeeStatus, readonly EmployeeStatus[]>> = {
  active: ['inactive', 'suspended', 'terminated'],
  inactive: ['active', 'suspended', 'terminated'],
  suspended: ['active', 'inactive', 'terminated'],
  terminated: [],
};

export const isEmployeeKind = (value: unknown): value is EmployeeKind =>
  typeof value === 'string' && (EMPLOYEE_KINDS as readonly string[]).includes(value);
export const isEmployeeStatus = (value: unknown): value is EmployeeStatus =>
  typeof value === 'string' && (EMPLOYEE_STATUSES as readonly string[]).includes(value);
export const canTransition = (from: EmployeeStatus, to: EmployeeStatus): boolean =>
  STATUS_TRANSITIONS[from].includes(to);

export type EmployeeErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_transition'
  | 'immutable'
  /** The target area is unknown, of another tenant or inactive (all indistinguishable). */
  | 'invalid_area';

/** Which unique key collided (`duplicate`) or which input is invalid (`invalid_area`). Never a value. */
export type EmployeeConflictField = 'employee_number' | 'national_id' | 'email' | 'area_id';

export class EmployeeError extends Error {
  public constructor(
    public readonly code: EmployeeErrorCode,
    public readonly field?: EmployeeConflictField,
  ) {
    super(`Employee request rejected: ${code}`);
    this.name = 'EmployeeError';
  }
}

export const MAX_REASON_LENGTH = 200;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 25;
export const MIN_DATE = '1950-01-01';
export const MAX_LICENSE_DATE = '2100-12-31';

/**
 * The personal data that is encrypted at rest (SPECS D23). Each field is stored only as a sealed
 * envelope; `index` is the tenant-scoped HMAC blind index used for uniqueness and exact lookup
 * (null for a field that has none).
 */
export const PII_FIELDS = ['nationalId', 'phone', 'email', 'licenseNumber'] as const;
export type PiiField = (typeof PII_FIELDS)[number];

/** Column-style names bound into every ciphertext and blind index. */
export const PII_FIELD_LABEL: Readonly<Record<PiiField, string>> = {
  nationalId: 'national_id',
  phone: 'phone',
  email: 'email',
  licenseNumber: 'license_number',
};

/** Fields that carry a blind index. Identification and e-mail are unique per tenant; the license is only indexed. */
const INDEXED_FIELDS: readonly PiiField[] = ['nationalId', 'email', 'licenseNumber'];

/**
 * Input keys that write personal data. Writing them needs the PII permission on top of the usual
 * one (see the task document): a unique-key collision on an identification would otherwise tell
 * a caller who may not read PII that a given id is registered.
 */
export const PII_INPUT_KEYS = ['nationalId', 'idType', 'phone', 'email', 'licenseNumber'] as const;

export interface SealedField {
  /** `pii1.` envelope (see `platform/pii`): the only form in which the value is stored. */
  readonly sealed: string;
  readonly index: string | null;
}
export type EmployeePii = { readonly [K in PiiField]: SealedField | null };
export type EmployeePiiValues = { readonly [K in PiiField]: string | null };

export interface Employee {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly kind: EmployeeKind;
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeNumber: string | null;
  readonly position: string | null;
  /** `YYYY-MM-DD`. */
  readonly hireDate: string | null;
  /**
   * The single area the employee belongs to. When set or changed it must be an active area of the
   * same tenant (checked through `EmployeeAreaGate`); an unchanged value is kept as is, even if
   * that area has been deactivated since.
   */
  readonly areaId: string;
  readonly status: EmployeeStatus;
  /** Reason of the last status change. */
  readonly statusReason: string;
  /** Identification type (catalog code such as `ine` or `dni`): not sensitive on its own. */
  readonly idType: string | null;
  /** Driver only. Type (catalog code) and expiry of the license; the number itself is PII. */
  readonly licenseType: string | null;
  readonly licenseExpiresOn: string | null;
  readonly pii: EmployeePii;
  /** Optimistic concurrency token: starts at 1, +1 on every change. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/**
 * One row of the change history. `kind: 'status'` records a status change with its reason (`from`
 * is null for the initial entry); `kind: 'area'` records a move between areas (ids, no reason).
 */
export interface EmployeeHistoryEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeId: string;
  readonly kind: 'status' | 'area';
  readonly from: string | null;
  readonly to: string;
  readonly reason: string | null;
  readonly actorId: string;
  /** Version the employee had right after this change: orders the history and is unique per employee. */
  readonly version: number;
  readonly at: string;
}

const invalid = (): never => {
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

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const requireVersion = (value: unknown): number =>
  isInteger(value, 1, 2_147_483_646) ? value : invalid();

export const dateOf = (now: Date): string => now.toISOString().slice(0, 10);

function normalizeName(value: unknown): string {
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

function normalizePosition(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return LABEL.test(text) ? text : invalid();
}

function normalizeDate(value: unknown, min: string, max: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOf(parsed) !== value || value < min || value > max)
    return invalid();
  return value;
}

function normalizeCode(value: unknown): string {
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

function normalizeLicenseType(value: unknown): string {
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

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);

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

// ---- fitness to operate -------------------------------------------------------------------

export type FitnessReason = 'not_active' | 'archived' | 'license_missing' | 'license_expired';

/** Derived fitness to operate a vehicle (FR-052, BR-012). Never stored: it changes with the calendar. */
export interface Fitness {
  readonly fit: boolean;
  readonly reasons: readonly FitnessReason[];
}

/**
 * A driver is fit when the employee is active and not archived and has a license (number, type
 * and expiry) whose last valid day (inclusive) is not before `today` (`YYYY-MM-DD`). Anyone who
 * is not a driver has no fitness (`null`). Mandatory documents (FR-052) do not exist yet.
 */
export function fitnessOf(
  employee: Pick<
    Employee,
    'kind' | 'status' | 'archivedAt' | 'licenseType' | 'licenseExpiresOn' | 'pii'
  >,
  today: string,
): Fitness | null {
  if (employee.kind !== 'driver') return null;
  const reasons: FitnessReason[] = [];
  if (employee.archivedAt !== null) reasons.push('archived');
  if (employee.status !== 'active') reasons.push('not_active');
  if (
    employee.pii.licenseNumber === null ||
    employee.licenseType === null ||
    employee.licenseExpiresOn === null
  )
    reasons.push('license_missing');
  else if (employee.licenseExpiresOn < today) reasons.push('license_expired');
  return { fit: reasons.length === 0, reasons };
}

// ---- pure state changes ---------------------------------------------------------------------

/** Archived and terminated employees are read-only (archiving a terminated one is allowed). */
function assertEditable(employee: Employee): void {
  if (employee.archivedAt !== null || employee.status === 'terminated')
    throw new EmployeeError('immutable');
}

function assertVersion(employee: Employee, expectedVersion: number): void {
  if (employee.version !== expectedVersion) throw new EmployeeError('stale_version');
}

const touched = (employee: Employee, now: Date): Pick<Employee, 'version' | 'updatedAt'> => ({
  version: employee.version + 1,
  updatedAt: now.toISOString(),
});

const NO_PII: EmployeePii = { nationalId: null, phone: null, email: null, licenseNumber: null };

/** The initial employee: always `active`, version 1, not archived. */
export function newEmployee(
  tenantId: string,
  id: string,
  data: NewEmployeeData,
  pii: Partial<EmployeePii>,
  idType: string | null,
  now: Date,
): Employee {
  return {
    id,
    tenantId,
    kind: data.kind,
    ...data.core,
    status: 'active',
    statusReason: 'Alta',
    idType,
    pii: { ...NO_PII, ...pii },
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
  };
}

export function statusEntry(
  employee: Employee,
  from: EmployeeStatus | null,
  id: string,
  actorId: string,
  now: Date,
): EmployeeHistoryEntry {
  return {
    id,
    tenantId: employee.tenantId,
    employeeId: employee.id,
    kind: 'status',
    from,
    to: employee.status,
    reason: employee.statusReason,
    actorId,
    version: employee.version,
    at: now.toISOString(),
  };
}

export function areaEntry(
  employee: Employee,
  fromAreaId: string,
  id: string,
  actorId: string,
  now: Date,
): EmployeeHistoryEntry {
  return {
    id,
    tenantId: employee.tenantId,
    employeeId: employee.id,
    kind: 'area',
    from: fromAreaId,
    to: employee.areaId,
    reason: null,
    actorId,
    version: employee.version,
    at: now.toISOString(),
  };
}

export function applyPatch(
  employee: Employee,
  core: EmployeePatch['core'],
  pii: Partial<EmployeePii>,
  idType: string | null | undefined,
  expectedVersion: number,
  now: Date,
): Employee {
  assertEditable(employee);
  assertVersion(employee, expectedVersion);
  return {
    ...employee,
    ...core,
    ...(idType === undefined ? {} : { idType }),
    pii: { ...employee.pii, ...pii },
    ...touched(employee, now),
  };
}

/** Manual status change: needs a reason and an allowed transition. */
export function applyStatus(
  employee: Employee,
  to: EmployeeStatus,
  reason: string,
  expectedVersion: number,
  now: Date,
): Employee {
  if (employee.archivedAt !== null) throw new EmployeeError('immutable');
  assertVersion(employee, expectedVersion);
  if (!canTransition(employee.status, to)) throw new EmployeeError('invalid_transition');
  return { ...employee, status: to, statusReason: reason, ...touched(employee, now) };
}

/** Soft delete (BR-009): the row stays, hidden from default listings and read-only. */
export function applyArchive(employee: Employee, expectedVersion: number, now: Date): Employee {
  if (employee.archivedAt !== null) throw new EmployeeError('immutable');
  assertVersion(employee, expectedVersion);
  return { ...employee, archivedAt: now.toISOString(), ...touched(employee, now) };
}

// ---- store port ----------------------------------------------------------------------------

export interface EmployeeFilter {
  readonly kind?: EmployeeKind;
  readonly status?: EmployeeStatus;
  readonly areaId?: string;
  readonly includeArchived: boolean;
}
export interface EmployeeWindow {
  readonly limit: number;
  readonly offset: number;
}
export interface EmployeeSlice {
  readonly items: readonly Employee[];
  /** Number of employees matching the filter, not only the window. */
  readonly total: number;
}
export interface EmployeeHistorySlice {
  readonly items: readonly EmployeeHistoryEntry[];
  readonly total: number;
}

/**
 * Persistence port. Every method is tenant-scoped: an employee of another tenant is simply absent.
 * `insert` and `replace` throw `EmployeeError('duplicate', field)` when an employee number,
 * identification or e-mail of the same tenant is already taken.
 */
export interface EmployeeStore {
  insert(employee: Employee, entry: EmployeeHistoryEntry): Promise<void>;
  find(tenantId: string, id: string): Promise<Employee | null>;
  /** Ordered by last name, first name (case-insensitive), then id. */
  list(tenantId: string, filter: EmployeeFilter, window: EmployeeWindow): Promise<EmployeeSlice>;
  /** Atomic compare-and-set: writes `next` (and the optional history entry) only while the stored version is `expectedVersion`; false otherwise. */
  replace(next: Employee, expectedVersion: number, entry?: EmployeeHistoryEntry): Promise<boolean>;
  /** Newest change first (by version, descending). */
  history(
    tenantId: string,
    employeeId: string,
    window: EmployeeWindow,
  ): Promise<EmployeeHistorySlice>;
  /**
   * Count port for the Areas module (BR-021): employees of the tenant in `areaId` that still count
   * as assigned people, i.e. not archived and not `terminated`. `inactive` and `suspended`
   * employees count: they can return to work inside that area.
   */
  countLiveInArea(tenantId: string, areaId: string): Promise<number>;
}

/** The employees that block deactivating their area (see `EmployeeStore.countLiveInArea`). */
export const isLiveEmployee = (employee: Pick<Employee, 'status' | 'archivedAt'>): boolean =>
  employee.archivedAt === null && employee.status !== 'terminated';

/** Plain code-unit order, so every store lists in the same order. */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

const orderKey = (employee: Employee): string => nameKey(employee.firstName, employee.lastName);

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemoryEmployeeStore implements EmployeeStore {
  private readonly employees = new Map<string, Employee>();
  private readonly entries: EmployeeHistoryEntry[] = [];

  private conflict(candidate: Employee): EmployeeConflictField | null {
    for (const other of this.employees.values()) {
      if (other.tenantId !== candidate.tenantId || other.id === candidate.id) continue;
      if (
        candidate.employeeNumber !== null &&
        other.employeeNumber !== null &&
        employeeNumberKey(other.employeeNumber) === employeeNumberKey(candidate.employeeNumber)
      )
        return 'employee_number';
      if (
        candidate.pii.nationalId !== null &&
        other.pii.nationalId?.index === candidate.pii.nationalId.index
      )
        return 'national_id';
      if (candidate.pii.email !== null && other.pii.email?.index === candidate.pii.email.index)
        return 'email';
    }
    return null;
  }

  public async insert(employee: Employee, entry: EmployeeHistoryEntry): Promise<void> {
    const key = storeKey(employee.tenantId, employee.id);
    const field = this.conflict(employee);
    if (this.employees.has(key)) throw new EmployeeError('duplicate');
    if (field) throw new EmployeeError('duplicate', field);
    this.employees.set(key, structuredClone(employee));
    this.entries.push(structuredClone(entry));
  }

  public async find(tenantId: string, id: string): Promise<Employee | null> {
    const found = this.employees.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async list(
    tenantId: string,
    filter: EmployeeFilter,
    window: EmployeeWindow,
  ): Promise<EmployeeSlice> {
    const matching = [...this.employees.values()]
      .filter(
        (employee) =>
          employee.tenantId === tenantId &&
          (filter.includeArchived || employee.archivedAt === null) &&
          (filter.kind === undefined || employee.kind === filter.kind) &&
          (filter.status === undefined || employee.status === filter.status) &&
          (filter.areaId === undefined || employee.areaId === filter.areaId),
      )
      .sort((a, b) => compareKeys(orderKey(a), orderKey(b)) || compareKeys(a.id, b.id));
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((employee) => structuredClone(employee)),
      total: matching.length,
    };
  }

  public async replace(
    next: Employee,
    expectedVersion: number,
    entry?: EmployeeHistoryEntry,
  ): Promise<boolean> {
    const key = storeKey(next.tenantId, next.id);
    const current = this.employees.get(key);
    if (current?.version !== expectedVersion) return false;
    const field = this.conflict(next);
    if (field) throw new EmployeeError('duplicate', field);
    this.employees.set(key, structuredClone(next));
    if (entry) this.entries.push(structuredClone(entry));
    return true;
  }

  public async countLiveInArea(tenantId: string, areaId: string): Promise<number> {
    return [...this.employees.values()].filter(
      (employee) =>
        employee.tenantId === tenantId && employee.areaId === areaId && isLiveEmployee(employee),
    ).length;
  }

  public async history(
    tenantId: string,
    employeeId: string,
    window: EmployeeWindow,
  ): Promise<EmployeeHistorySlice> {
    const all = this.entries
      .filter((entry) => entry.tenantId === tenantId && entry.employeeId === employeeId)
      .sort((a, b) => b.version - a.version);
    return {
      items: all
        .slice(window.offset, window.offset + window.limit)
        .map((entry) => structuredClone(entry)),
      total: all.length,
    };
  }
}

// ---- service -------------------------------------------------------------------------------

/**
 * Port to the Areas module (BR-021). `withActiveArea` runs `work` only while `areaId` is an ACTIVE
 * area of `tenantId` and cannot be deactivated: the implementation holds the same per-tenant
 * serialization the area deactivation runs under for the whole duration of `work`, so a
 * deactivation cannot commit between the check and the employee write. Unknown, foreign and
 * inactive areas are indistinguishable: it throws `EmployeeError('invalid_area', 'area_id')`
 * without running `work`. Errors of `work` propagate unchanged.
 */
export interface EmployeeAreaGate {
  withActiveArea<T>(tenantId: string, areaId: string, work: () => Promise<T>): Promise<T>;
}

export interface EmployeeListQuery {
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly areaId?: unknown;
  readonly includeArchived?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface EmployeeHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface EmployeeServiceOptions {
  /** Encrypts PII at rest and computes blind indexes. Required: nothing is ever stored in the clear. */
  readonly pii: PiiCipher;
  /**
   * Validates and serializes writes that set or change `areaId`. Without it the area is not
   * checked (only for tests of this package); the platform composition always supplies it.
   */
  readonly areas?: EmployeeAreaGate;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function windowOf(query: EmployeeHistoryQuery): EmployeeWindow {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
  return { limit, offset };
}

const ENTITY = 'employee';

/**
 * Employee use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class enforces the domain rules and is the only place that
 * seals and opens personal data. The tenant is always an argument taken from the server-side
 * session, never part of the input being validated.
 */
export class EmployeeService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly areas: EmployeeAreaGate | undefined;
  private readonly pii: PiiCipher;

  public constructor(
    private readonly store: EmployeeStore,
    options: EmployeeServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.areas = options.areas;
    this.pii = options.pii;
  }

  /** Runs a write that sets `areaId` under the area gate (a no-op wrapper without one). */
  private inArea<T>(tenantId: string, areaId: string, work: () => Promise<T>): Promise<T> {
    return this.areas ? this.areas.withActiveArea(tenantId, areaId, work) : work();
  }

  private async seal(
    tenantId: string,
    id: string,
    field: PiiField,
    plaintext: string,
    indexKey: string | null,
  ): Promise<SealedField> {
    const label = PII_FIELD_LABEL[field];
    const sealed = await this.pii.seal(
      { tenantId, entityType: ENTITY, entityId: id, field: label },
      plaintext,
    );
    const index =
      indexKey !== null && INDEXED_FIELDS.includes(field)
        ? await this.pii.blindIndex(tenantId, label, indexKey)
        : null;
    return { sealed, index };
  }

  /** Seals every present field of `input`; `null` clears. Returns only the fields that were present. */
  private async sealAll(
    tenantId: string,
    id: string,
    input: PiiInput,
  ): Promise<{ pii: Partial<EmployeePii>; idType: string | null | undefined }> {
    const pii: { -readonly [K in PiiField]?: SealedField | null } = {};
    let idType: string | null | undefined;
    if (input.nationalId !== undefined) {
      idType = input.nationalId === null ? null : input.nationalId.idType;
      pii.nationalId =
        input.nationalId === null
          ? null
          : await this.seal(
              tenantId,
              id,
              'nationalId',
              input.nationalId.value,
              nationalIdKey(input.nationalId.idType, input.nationalId.value),
            );
    }
    if (input.phone !== undefined)
      pii.phone =
        input.phone === null ? null : await this.seal(tenantId, id, 'phone', input.phone, null);
    if (input.email !== undefined)
      pii.email =
        input.email === null
          ? null
          : await this.seal(tenantId, id, 'email', input.email, input.email);
    if (input.licenseNumber !== undefined)
      pii.licenseNumber =
        input.licenseNumber === null
          ? null
          : await this.seal(
              tenantId,
              id,
              'licenseNumber',
              input.licenseNumber,
              licenseNumberKey(input.licenseNumber),
            );
    return { pii, idType };
  }

  /** The employee of this tenant, or `not_found` (also for ids of other tenants). */
  private async load(tenantId: string, id: unknown): Promise<Employee> {
    const employee = await this.store.find(requireOpaqueId(tenantId), requireOpaqueId(id));
    if (employee?.tenantId !== tenantId) throw new EmployeeError('not_found');
    return employee;
  }

  /** Writes `next`; a lost race reads as `stale_version` (or `not_found` when the row is gone). */
  private async commit(
    next: Employee,
    expectedVersion: number,
    entry?: EmployeeHistoryEntry,
  ): Promise<Employee> {
    if (await this.store.replace(next, expectedVersion, entry)) return next;
    const current = await this.store.find(next.tenantId, next.id);
    throw new EmployeeError(current ? 'stale_version' : 'not_found');
  }

  public async create(tenantId: string, actorId: string, input: unknown): Promise<Employee> {
    requireOpaqueId(tenantId);
    requireOpaqueId(actorId);
    const now = this.now();
    const data = parseNewEmployee(input, now);
    const id = this.newId();
    // Sealing talks to the KMS: it happens before the area lock is taken, which stays short.
    const sealed = await this.sealAll(tenantId, id, data.pii);
    const employee = newEmployee(tenantId, id, data, sealed.pii, sealed.idType ?? null, now);
    const entry = statusEntry(employee, null, this.newId(), actorId, now);
    await this.inArea(tenantId, employee.areaId, () => this.store.insert(employee, entry));
    return employee;
  }

  public get(tenantId: string, id: unknown): Promise<Employee> {
    return this.load(tenantId, id);
  }

  public async list(tenantId: string, query: EmployeeListQuery = {}): Promise<EmployeeSlice> {
    requireOpaqueId(tenantId);
    const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
    const offset = query.offset === undefined ? 0 : query.offset;
    if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
    if (query.kind !== undefined && !isEmployeeKind(query.kind)) return invalid();
    if (query.status !== undefined && !isEmployeeStatus(query.status)) return invalid();
    if (query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean')
      return invalid();
    const filter: EmployeeFilter = {
      includeArchived: query.includeArchived ?? false,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.areaId === undefined ? {} : { areaId: requireOpaqueId(query.areaId) }),
    };
    return this.store.list(tenantId, filter, { limit, offset });
  }

  public async update(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Employee> {
    requireOpaqueId(actorId);
    const now = this.now();
    const patch = parseEmployeePatch(input, now);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    if (current.kind !== 'driver') {
      const keys = new Set([...Object.keys(patch.core), ...Object.keys(patch.pii)]);
      if (LICENSE_KEYS.some((key) => keys.has(key))) return invalid();
    }
    // Cheap checks first: a stale or read-only employee never reaches the KMS.
    applyPatch(current, {}, {}, undefined, version, now);
    const sealed = await this.sealAll(tenantId, current.id, patch.pii);
    const next = applyPatch(current, patch.core, sealed.pii, sealed.idType, version, now);
    if (next.areaId === current.areaId) return this.commit(next, version);
    // Only a different area is validated: an employee may keep an area that was deactivated since.
    const entry = areaEntry(next, current.areaId, this.newId(), actorId, now);
    return this.inArea(tenantId, next.areaId, () => this.commit(next, version, entry));
  }

  public async changeStatus(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    status: unknown,
    reason: unknown,
  ): Promise<Employee> {
    requireOpaqueId(actorId);
    const now = this.now();
    if (!isEmployeeStatus(status)) return invalid();
    const text = normalizeReason(reason);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    const next = applyStatus(current, status, text, version, now);
    return this.commit(
      next,
      version,
      statusEntry(next, current.status, this.newId(), actorId, now),
    );
  }

  public async archive(tenantId: string, id: unknown, expectedVersion: unknown): Promise<Employee> {
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyArchive(current, version, this.now()), version);
  }

  public async history(
    tenantId: string,
    id: unknown,
    query: EmployeeHistoryQuery = {},
  ): Promise<EmployeeHistorySlice> {
    const employee = await this.load(tenantId, id);
    return this.store.history(tenantId, employee.id, windowOf(query));
  }

  /** Derived fitness to operate as of today (UTC date of the service clock). */
  public fitness(employee: Employee): Fitness | null {
    return fitnessOf(employee, dateOf(this.now()));
  }

  /**
   * Decrypts the personal data of an employee. The caller (composition) decides who may call it;
   * the tenant comes from the employee row, which was loaded for the session's tenant.
   */
  public async reveal(employee: Employee): Promise<EmployeePiiValues> {
    const open = async (field: PiiField): Promise<string | null> => {
      const sealed = employee.pii[field];
      return sealed === null
        ? null
        : this.pii.open(
            {
              tenantId: employee.tenantId,
              entityType: ENTITY,
              entityId: employee.id,
              field: PII_FIELD_LABEL[field],
            },
            sealed.sealed,
          );
    };
    return {
      nationalId: await open('nationalId'),
      phone: await open('phone'),
      email: await open('email'),
      licenseNumber: await open('licenseNumber'),
    };
  }
}

/** True when the raw input of a create or update writes personal data (needs the PII permission). */
export function writesPii(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    PII_INPUT_KEYS.some((key) => Object.hasOwn(input, key))
  );
}
