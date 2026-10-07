import type { Employee, EmployeeHistoryEntry, EmployeeKind, EmployeeStatus } from './types.js';
import { EmployeeError } from './errors.js';
import type { EmployeeConflictField } from './errors.js';
import { employeeNumberKey, nameKey } from './validation.js';

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
