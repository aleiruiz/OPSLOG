import { AssignmentError } from './errors.js';
import {
  type AssignmentClosing,
  type AssignmentEventSlice,
  type AssignmentFilter,
  type AssignmentSlice,
  type AssignmentStore,
  type AssignmentWindow,
} from './ports.js';
import { type Assignment, type AssignmentEvent } from './types.js';

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemoryAssignmentStore implements AssignmentStore {
  private readonly rows = new Map<string, Assignment>();
  private readonly eventRows: AssignmentEvent[] = [];

  /** The constraint the real store gets from its unique indexes. */
  private assertFree(next: Assignment, ignoring: string | null): void {
    if (next.endedAt !== null) return;
    for (const other of this.rows.values()) {
      if (other.tenantId !== next.tenantId || other.endedAt !== null || other.id === ignoring)
        continue;
      if (next.type === 'principal' && other.type === 'principal') {
        if (other.vehicleId === next.vehicleId)
          throw new AssignmentError('principal_taken', 'vehicle_id');
        if (other.employeeId === next.employeeId)
          throw new AssignmentError('principal_taken', 'employee_id');
      }
      if (other.vehicleId === next.vehicleId && other.employeeId === next.employeeId)
        throw new AssignmentError('already_assigned', 'employee_id');
    }
  }

  public async insert(
    assignment: Assignment,
    event: AssignmentEvent,
    closing?: AssignmentClosing,
  ): Promise<boolean> {
    const closed = closing
      ? this.rows.get(storeKey(closing.next.tenantId, closing.next.id))
      : undefined;
    if (closing && closed?.version !== closing.expectedVersion) return false;
    this.assertFree(assignment, closing?.next.id ?? null);
    if (closing) {
      this.rows.set(
        storeKey(closing.next.tenantId, closing.next.id),
        structuredClone(closing.next),
      );
      this.eventRows.push(structuredClone(closing.event));
    }
    this.rows.set(storeKey(assignment.tenantId, assignment.id), structuredClone(assignment));
    this.eventRows.push(structuredClone(event));
    return true;
  }

  public async find(tenantId: string, id: string): Promise<Assignment | null> {
    const found = this.rows.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async list(
    tenantId: string,
    filter: AssignmentFilter,
    window: AssignmentWindow,
  ): Promise<AssignmentSlice> {
    const matching = [...this.rows.values()]
      .filter(
        (row) =>
          row.tenantId === tenantId &&
          (filter.vehicleId === undefined || row.vehicleId === filter.vehicleId) &&
          (filter.employeeId === undefined || row.employeeId === filter.employeeId) &&
          (filter.type === undefined || row.type === filter.type) &&
          (filter.status === undefined || (row.endedAt === null) === (filter.status === 'current')),
      )
      .sort((a, b) => compareKeys(b.startedAt, a.startedAt) || compareKeys(a.id, b.id));
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: matching.length,
    };
  }

  public async replace(
    next: Assignment,
    expectedVersion: number,
    event: AssignmentEvent,
  ): Promise<boolean> {
    const key = storeKey(next.tenantId, next.id);
    if (this.rows.get(key)?.version !== expectedVersion) return false;
    this.rows.set(key, structuredClone(next));
    this.eventRows.push(structuredClone(event));
    return true;
  }

  public async events(
    tenantId: string,
    assignmentId: string,
    window: AssignmentWindow,
  ): Promise<AssignmentEventSlice> {
    const all = this.eventRows
      .filter((row) => row.tenantId === tenantId && row.assignmentId === assignmentId)
      .sort((a, b) => b.seq - a.seq);
    return {
      items: all
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: all.length,
    };
  }
}
