import { canTransition } from './types.js';
import type { Employee, EmployeeHistoryEntry, EmployeePii, EmployeeStatus } from './types.js';
import { EmployeeError } from './errors.js';
import type { EmployeePatch, NewEmployeeData } from './parsing.js';

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
