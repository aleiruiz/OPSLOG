import {
  type Assignment,
  type AssignmentEvent,
  type AssignmentStatus,
  type AssignmentType,
} from './types.js';

export interface AssignmentFilter {
  readonly vehicleId?: string;
  readonly employeeId?: string;
  readonly type?: AssignmentType;
  readonly status?: AssignmentStatus;
}

export interface AssignmentWindow {
  readonly limit: number;
  readonly offset: number;
}

export interface AssignmentSlice {
  readonly items: readonly Assignment[];
  /** Number of assignments matching the filter, not only the window. */
  readonly total: number;
}

export interface AssignmentEventSlice {
  readonly items: readonly AssignmentEvent[];
  readonly total: number;
}

/** The closing of the replaced principal, written atomically with the new assignment. */
export interface AssignmentClosing {
  readonly next: Assignment;
  readonly expectedVersion: number;
  readonly event: AssignmentEvent;
}

/**
 * Persistence port. Every method is tenant-scoped: an assignment of another tenant is simply
 * absent. The store itself guarantees BR-002 / BR-003 under concurrency: at most one current
 * principal per vehicle and per driver, and one current assignment per (vehicle, driver); a write
 * that would break one throws `AssignmentError('principal_taken' | 'already_assigned', field)`.
 */
export interface AssignmentStore {
  /** Inserts the assignment and its first event; with `closing`, ends the replaced one in the same transaction. False when `closing`'s version is stale. */
  insert(
    assignment: Assignment,
    event: AssignmentEvent,
    closing?: AssignmentClosing,
  ): Promise<boolean>;
  find(tenantId: string, id: string): Promise<Assignment | null>;
  /** Newest start first, then id. */
  list(
    tenantId: string,
    filter: AssignmentFilter,
    window: AssignmentWindow,
  ): Promise<AssignmentSlice>;
  /** Atomic compare-and-set of the closing: writes `next` and `event` only while the stored version is `expectedVersion`; false otherwise. */
  replace(next: Assignment, expectedVersion: number, event: AssignmentEvent): Promise<boolean>;
  /** Newest event first. */
  events(
    tenantId: string,
    assignmentId: string,
    window: AssignmentWindow,
  ): Promise<AssignmentEventSlice>;
}

/**
 * Ports to the vehicle and employee modules. Each resolves only when the entity can receive an
 * assignment in `tenantId`; unknown, foreign and ineligible ones are indistinguishable: they throw
 * `AssignmentError('invalid_vehicle', 'vehicle_id')` / `('invalid_employee', 'employee_id')`
 * (BR-014). Other failures propagate unchanged.
 */
export interface AssignmentVehicleGate {
  assertAssignable(tenantId: string, vehicleId: string): Promise<void>;
}

export interface AssignmentEmployeeGate {
  assertAssignable(tenantId: string, employeeId: string): Promise<void>;
}
