import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  requireOpaqueId,
  requireVersion,
} from '../../documents/src/index.js';

/**
 * Driver-vehicle assignments (FLT-VEH slice: BRD §8.7, FR-075, FR-076, FR-053, BR-002, BR-003,
 * BR-014, US-013). An assignment links a vehicle to an employee of kind `driver` with a type
 * (`principal`, `secondary`, `temporary`), a start, an optional end and a reason. The history is
 * never rewritten: an assignment is only ever closed (it is never edited or deleted) and every
 * change appends an event.
 */
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT };

export const ASSIGNMENT_TYPES = ['principal', 'secondary', 'temporary'] as const;
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];
export const isAssignmentType = (value: unknown): value is AssignmentType =>
  typeof value === 'string' && (ASSIGNMENT_TYPES as readonly string[]).includes(value);

/** Derived from `endedAt`; never stored on its own. */
export const ASSIGNMENT_STATUSES = ['current', 'ended'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const isAssignmentStatus = (value: unknown): value is AssignmentStatus =>
  typeof value === 'string' && (ASSIGNMENT_STATUSES as readonly string[]).includes(value);

/** How an assignment ended: closed by a person, or replaced by a new principal (US-013). */
export type EndKind = 'ended' | 'replaced';
export type AssignmentEventKind = 'assigned' | EndKind;

export type AssignmentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  /** The assignment already ended: it is read-only. */
  | 'immutable'
  /** The vehicle is unknown, of another tenant, archived or not assignable (indistinguishable). */
  | 'invalid_vehicle'
  /** The employee is unknown, of another tenant, archived, not a driver or not active (indistinguishable). */
  | 'invalid_employee'
  /** BR-002 / BR-003: a principal already exists for the vehicle or for the driver. */
  | 'principal_taken'
  /** The driver already holds a current assignment on this vehicle. */
  | 'already_assigned';

/** Which input is at fault. Never a value. */
export type AssignmentConflictField = 'vehicle_id' | 'employee_id';

export class AssignmentError extends Error {
  public constructor(
    public readonly code: AssignmentErrorCode,
    public readonly field?: AssignmentConflictField,
  ) {
    super(`Assignment request rejected: ${code}`);
    this.name = 'AssignmentError';
  }
}

export interface Assignment {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: AssignmentType;
  /** Why it was assigned (one line, at most 200 characters). */
  readonly reason: string;
  /** `user-<subject>` that assigned. */
  readonly assignedBy: string;
  readonly startedAt: string;
  /** `null` while the assignment is current. */
  readonly endedAt: string | null;
  readonly endKind: EndKind | null;
  readonly endReason: string | null;
  readonly endedBy: string | null;
  /** Optimistic concurrency token: starts at 1, +1 on every change. */
  readonly version: number;
  readonly updatedAt: string;
}

/** One row of the append-only history of an assignment. */
export interface AssignmentEvent {
  readonly tenantId: string;
  readonly assignmentId: string;
  /** 1 for `assigned`, 2 for the end. */
  readonly seq: number;
  readonly kind: AssignmentEventKind;
  readonly actorId: string;
  readonly reason: string;
  readonly at: string;
}

const invalid = (): never => {
  throw new AssignmentError('invalid_input');
};

export const MAX_REASON_LENGTH = 200;
const REASON = /^[^\u0000-\u001f\u007f]{1,200}$/u;

export function normalizeReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return REASON.test(text) ? text : invalid();
}

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);

/** The shared opaque-id and version guards raise `DocumentError`; assignments raise their own error. */
function guardId(value: unknown): string {
  try {
    return requireOpaqueId(value);
  } catch {
    return invalid();
  }
}

function guardVersion(value: unknown): number {
  try {
    return requireVersion(value);
  } catch {
    return invalid();
  }
}

export const CREATE_FIELDS = ['vehicleId', 'employeeId', 'type', 'reason', 'replace'] as const;
export const END_FIELDS = ['reason'] as const;

export interface NewAssignmentData {
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: AssignmentType;
  readonly reason: string;
  /** US-013: close the vehicle's current principal and assign this driver in its place. */
  readonly replace: boolean;
}

/** Validates a new assignment. Unknown properties are rejected; `replace` only makes sense for a principal. */
export function parseNewAssignment(input: unknown): NewAssignmentData {
  const fields = asFields(input, CREATE_FIELDS);
  if (['vehicleId', 'employeeId', 'type', 'reason'].some((key) => !has(fields, key)))
    return invalid();
  const type = fields['type'];
  if (!isAssignmentType(type)) return invalid();
  const replace = fields['replace'];
  if (replace !== undefined && typeof replace !== 'boolean') return invalid();
  if (replace === true && type !== 'principal') return invalid();
  return {
    vehicleId: guardId(fields['vehicleId']),
    employeeId: guardId(fields['employeeId']),
    type,
    reason: normalizeReason(fields['reason']),
    replace: replace ?? false,
  };
}

/** Closing an assignment needs a reason. */
export function parseEnd(input: unknown): { readonly reason: string } {
  const fields = asFields(input, END_FIELDS);
  if (!has(fields, 'reason')) return invalid();
  return { reason: normalizeReason(fields['reason']) };
}

// ---- pure state changes -----------------------------------------------------------------------

export const isCurrent = (assignment: Pick<Assignment, 'endedAt'>): boolean =>
  assignment.endedAt === null;

export const isCurrentPrincipal = (assignment: Pick<Assignment, 'endedAt' | 'type'>): boolean =>
  assignment.endedAt === null && assignment.type === 'principal';

/** The first record of an assignment: version 1, current. */
export function newAssignment(
  tenantId: string,
  id: string,
  actorId: string,
  data: NewAssignmentData,
  now: Date,
): Assignment {
  const at = now.toISOString();
  return {
    id,
    tenantId,
    vehicleId: data.vehicleId,
    employeeId: data.employeeId,
    type: data.type,
    reason: data.reason,
    assignedBy: actorId,
    startedAt: at,
    endedAt: null,
    endKind: null,
    endReason: null,
    endedBy: null,
    version: 1,
    updatedAt: at,
  };
}

export function assignedEvent(assignment: Assignment): AssignmentEvent {
  return {
    tenantId: assignment.tenantId,
    assignmentId: assignment.id,
    seq: 1,
    kind: 'assigned',
    actorId: assignment.assignedBy,
    reason: assignment.reason,
    at: assignment.startedAt,
  };
}

/** Closes an assignment (never edits it otherwise). An ended assignment is read-only. */
export function applyEnd(
  assignment: Assignment,
  kind: EndKind,
  reason: string,
  actorId: string,
  expectedVersion: number,
  now: Date,
): Assignment {
  if (assignment.endedAt !== null) throw new AssignmentError('immutable');
  if (assignment.version !== expectedVersion) throw new AssignmentError('stale_version');
  const at = now.toISOString();
  return {
    ...assignment,
    endedAt: at,
    endKind: kind,
    endReason: reason,
    endedBy: actorId,
    version: assignment.version + 1,
    updatedAt: at,
  };
}

export function endedEvent(assignment: Assignment): AssignmentEvent {
  return {
    tenantId: assignment.tenantId,
    assignmentId: assignment.id,
    seq: 2,
    kind: assignment.endKind as EndKind,
    actorId: assignment.endedBy as string,
    reason: assignment.endReason as string,
    at: assignment.endedAt as string,
  };
}

// ---- store port -------------------------------------------------------------------------------

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

// ---- service ----------------------------------------------------------------------------------

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
