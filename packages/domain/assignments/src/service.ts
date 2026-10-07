import { randomUUID } from 'node:crypto';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../documents/src/index.js';
import { AssignmentError } from './errors.js';
import {
  type AssignmentClosing,
  type AssignmentEmployeeGate,
  type AssignmentEventSlice,
  type AssignmentFilter,
  type AssignmentSlice,
  type AssignmentStore,
  type AssignmentVehicleGate,
  type AssignmentWindow,
} from './ports.js';
import { applyEnd, assignedEvent, endedEvent, newAssignment } from './rules.js';
import { isAssignmentStatus, isAssignmentType, type Assignment } from './types.js';
import {
  guardId,
  guardVersion,
  invalid,
  isInteger,
  parseEnd,
  parseNewAssignment,
} from './validation.js';

export interface AssignmentListQuery {
  readonly vehicleId?: unknown;
  readonly employeeId?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface AssignmentHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface AssignmentServiceOptions {
  /**
   * Checks the vehicle and the driver of a new assignment (BR-014). Without them nothing is checked
   * (only for tests of this package); the platform composition always supplies both. The checks are
   * best effort (check, then act): an employee or a vehicle changed concurrently can still receive
   * the assignment, which is the same as it having been made just before the change.
   */
  readonly vehicles?: AssignmentVehicleGate;
  readonly employees?: AssignmentEmployeeGate;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface Assigned {
  readonly assignment: Assignment;
  /** The principal closed by `replace`, when there was one. */
  readonly replaced: Assignment | null;
}

function windowOf(query: AssignmentHistoryQuery): AssignmentWindow {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
  return { limit, offset };
}

const ONE = { limit: 1, offset: 0 } as const;

/**
 * Assignment use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class enforces the domain rules. The tenant is always an argument
 * taken from the server-side session, never part of the input being validated.
 */
export class AssignmentService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly vehicles: AssignmentVehicleGate | undefined;
  private readonly employees: AssignmentEmployeeGate | undefined;

  public constructor(
    private readonly store: AssignmentStore,
    options: AssignmentServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.vehicles = options.vehicles;
    this.employees = options.employees;
  }

  /** The assignment of this tenant, or `not_found` (also for ids of other tenants). */
  private async load(tenantId: string, id: unknown): Promise<Assignment> {
    const found = await this.store.find(guardId(tenantId), guardId(id));
    if (found?.tenantId !== tenantId) throw new AssignmentError('not_found');
    return found;
  }

  /** The first current assignment matching `filter`, if any. */
  private async firstCurrent(
    tenantId: string,
    filter: Omit<AssignmentFilter, 'status'>,
  ): Promise<Assignment | null> {
    const slice = await this.store.list(tenantId, { ...filter, status: 'current' }, ONE);
    return slice.items[0] ?? null;
  }

  /**
   * US-013: assigns a driver. A principal is rejected (`principal_taken`, naming the field) while
   * the vehicle or the driver already has one (BR-002 / BR-003); `replace: true` closes the
   * vehicle's current principal in the same transaction instead.
   */
  public async create(tenantId: string, actorId: string, input: unknown): Promise<Assigned> {
    guardId(tenantId);
    guardId(actorId);
    const now = this.now();
    const data = parseNewAssignment(input);
    await this.vehicles?.assertAssignable(tenantId, data.vehicleId);
    await this.employees?.assertAssignable(tenantId, data.employeeId);
    if (
      await this.firstCurrent(tenantId, { vehicleId: data.vehicleId, employeeId: data.employeeId })
    )
      throw new AssignmentError('already_assigned', 'employee_id');
    let closing: AssignmentClosing | undefined;
    if (data.type === 'principal') {
      const holder = await this.firstCurrent(tenantId, {
        vehicleId: data.vehicleId,
        type: 'principal',
      });
      if (holder && !data.replace) throw new AssignmentError('principal_taken', 'vehicle_id');
      if (await this.firstCurrent(tenantId, { employeeId: data.employeeId, type: 'principal' }))
        throw new AssignmentError('principal_taken', 'employee_id');
      if (holder) {
        const next = applyEnd(holder, 'replaced', data.reason, actorId, holder.version, now);
        closing = { next, expectedVersion: holder.version, event: endedEvent(next) };
      }
    }
    const assignment = newAssignment(tenantId, this.newId(), actorId, data, now);
    if (!(await this.store.insert(assignment, assignedEvent(assignment), closing)))
      throw new AssignmentError('stale_version');
    return { assignment, replaced: closing?.next ?? null };
  }

  public get(tenantId: string, id: unknown): Promise<Assignment> {
    return this.load(tenantId, id);
  }

  public async list(tenantId: string, query: AssignmentListQuery = {}): Promise<AssignmentSlice> {
    guardId(tenantId);
    const window = windowOf(query);
    if (query.type !== undefined && !isAssignmentType(query.type)) return invalid();
    if (query.status !== undefined && !isAssignmentStatus(query.status)) return invalid();
    const filter: AssignmentFilter = {
      ...(query.vehicleId === undefined ? {} : { vehicleId: guardId(query.vehicleId) }),
      ...(query.employeeId === undefined ? {} : { employeeId: guardId(query.employeeId) }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    return this.store.list(tenantId, filter, window);
  }

  /** Closes an assignment with a reason; the row stays as history. */
  public async end(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Assignment> {
    guardId(actorId);
    const now = this.now();
    const { reason } = parseEnd(input);
    const version = guardVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    const next = applyEnd(current, 'ended', reason, actorId, version, now);
    if (await this.store.replace(next, version, endedEvent(next))) return next;
    const after = await this.store.find(tenantId, next.id);
    throw new AssignmentError(after ? 'stale_version' : 'not_found');
  }

  /** Events of one assignment, newest first. */
  public async history(
    tenantId: string,
    id: unknown,
    query: AssignmentHistoryQuery = {},
  ): Promise<AssignmentEventSlice> {
    const assignment = await this.load(tenantId, id);
    return this.store.events(tenantId, assignment.id, windowOf(query));
  }
}
