import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_EMPLOYEE_KINDS = ['driver', 'dispatcher', 'other'] as const;
export type BffEmployeeKind = (typeof BFF_EMPLOYEE_KINDS)[number];

export const BFF_EMPLOYEE_STATUSES = ['active', 'inactive', 'suspended', 'terminated'] as const;
export type BffEmployeeStatus = (typeof BFF_EMPLOYEE_STATUSES)[number];

/** Which personal data an employee has on file. Presence only, never a value. */
export interface BffEmployeePiiPresent {
  readonly nationalId: boolean;
  readonly phone: boolean;
  readonly email: boolean;
  readonly licenseNumber: boolean;
}

/** Why a driver is not fit to operate (BR-012); several can apply at once. */
export type BffFitnessReason = 'not_active' | 'archived' | 'license_missing' | 'license_expired';

/** Derived fitness to operate. `null` on the employee when the kind has none (not a driver). */
export interface BffFitness {
  readonly fit: boolean;
  readonly reasons: readonly BffFitnessReason[];
}

/**
 * A person of the company's staff. The company is implicit (the session's); `version` is the
 * concurrency token. Personal data never appears here: only `piiPresent` flags and the
 * non-sensitive `idType`, `licenseType` and `licenseExpiresOn`.
 */
export interface BffEmployee {
  readonly id: string;
  readonly kind: BffEmployeeKind;
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeNumber: string | null;
  readonly position: string | null;
  /** `YYYY-MM-DD`. */
  readonly hireDate: string | null;
  readonly areaId: string;
  readonly status: BffEmployeeStatus;
  readonly statusReason: string;
  /** Identification type (catalog code); the number is personal data. */
  readonly idType: string | null;
  /** Driver only. */
  readonly licenseType: string | null;
  /** Driver only, `YYYY-MM-DD`; the last valid day, inclusive. */
  readonly licenseExpiresOn: string | null;
  readonly piiPresent: BffEmployeePiiPresent;
  readonly fitness: BffFitness | null;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

/** Decrypted personal data, normalized (upper-case ids, E.164 phone, lower-case e-mail). */
export interface BffEmployeePii {
  readonly nationalId: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly licenseNumber: string | null;
}

/**
 * The single-employee read. `pii` is `null` (masked) unless the session holds the PII permission;
 * a read that returns personal data is audited.
 */
export interface BffEmployeeDetail extends BffEmployee {
  readonly pii: BffEmployeePii | null;
}

/**
 * Creating an employee. `idType` and `nationalId` go together; the license fields are for drivers
 * only. Sending any of `idType`, `nationalId`, `phone`, `email` or `licenseNumber` also requires
 * the PII permission.
 */
export interface BffEmployeeInput {
  readonly kind: BffEmployeeKind;
  readonly firstName: string;
  readonly lastName: string;
  readonly areaId: string;
  readonly employeeNumber?: string | null;
  readonly position?: string | null;
  /** `YYYY-MM-DD`, not in the future. */
  readonly hireDate?: string | null;
  readonly idType?: string | null;
  readonly nationalId?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly licenseNumber?: string | null;
  readonly licenseType?: string | null;
  readonly licenseExpiresOn?: string | null;
}

/**
 * Fields that can be edited in place (never `kind`); at least one besides `version`, `null` clears
 * an optional field. A different `areaId` moves the employee (recorded in the history).
 */
export interface BffEmployeePatch extends Partial<Omit<BffEmployeeInput, 'kind'>> {
  readonly version: number;
}

export interface BffEmployeesQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly kind?: BffEmployeeKind;
  readonly status?: BffEmployeeStatus;
  readonly areaId?: string;
  /** `true` to include archived employees (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

/** `status` entries carry the reason and the status ids; `area` entries carry the area ids and no reason. */
export interface BffEmployeeHistoryEntry {
  readonly id: string;
  readonly kind: 'status' | 'area';
  readonly from: string | null;
  readonly to: string;
  readonly reason: string | null;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

export interface BffEmployeeHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** Request and response types of the employees routes. */
export interface EmployeesRouteTypes {
  'employees.list': { query?: BffEmployeesQuery; response: Page<BffEmployee> };
  'employees.create': { body: BffEmployeeInput; response: BffEmployee };
  'employees.get': { params: { id: string }; response: BffEmployeeDetail };
  'employees.update': { params: { id: string }; body: BffEmployeePatch; response: BffEmployee };
  'employees.status': {
    params: { id: string };
    body: { version: number; status: BffEmployeeStatus; reason: string };
    response: BffEmployee;
  };
  'employees.archive': { params: { id: string }; body: { version: number }; response: BffEmployee };
  'employees.history': {
    params: { id: string };
    query?: BffEmployeeHistoryQuery;
    response: Page<BffEmployeeHistoryEntry>;
  };
}

export const EMPLOYEES_ROUTES = {
  'employees.list': { method: 'GET', path: ['api', 'employees'], kind: 'session', status: 200 },
  'employees.create': {
    method: 'POST',
    path: ['api', 'employees'],
    kind: 'session-csrf',
    status: 201,
  },
  'employees.get': {
    method: 'GET',
    path: ['api', 'employees', ':id'],
    kind: 'session',
    status: 200,
  },
  'employees.update': {
    method: 'PUT',
    path: ['api', 'employees', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'employees.status': {
    method: 'POST',
    path: ['api', 'employees', ':id', 'status'],
    kind: 'session-csrf',
    status: 200,
  },
  'employees.archive': {
    method: 'POST',
    path: ['api', 'employees', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'employees.history': {
    method: 'GET',
    path: ['api', 'employees', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof EmployeesRouteTypes, BffRouteDefinition>;
