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
export const INDEXED_FIELDS: readonly PiiField[] = ['nationalId', 'email', 'licenseNumber'];

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
