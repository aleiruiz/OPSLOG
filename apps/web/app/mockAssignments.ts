import type { ApiError } from '@opslog/contracts';
import { BFF_ASSIGNMENT_STATUSES, BFF_ASSIGNMENT_TYPES } from '@opslog/contracts';
import { demoAssignments } from '../assignments/fixtures';
import { OPAQUE_ID, REASON, normalizeReason } from '../assignments/rules';
import type {
  AssignmentCreated,
  AssignmentEvent,
  AssignmentInput,
  AssignmentListQuery,
  AssignmentsPort,
  AssignmentType,
  Page,
  Result,
  VehicleAssignment,
} from './types';

/**
 * In-memory driver-vehicle assignments with the semantics of the real backend (`packages/domain/assignments`): the
 * server clock is the start and the end (no client dates), an assignment is never edited or deleted, only closed
 * (409 `immutable` when it already is, 409 `stale_version` for an old version), at most one current principal per
 * vehicle (BR-002) and per driver (BR-003: 409 `principal_taken` naming `vehicle_id` or `employee_id`), one current
 * assignment per vehicle and driver pair (409 `already_assigned`), a replacement that closes the principal and creates
 * the new one in one step, an eligible vehicle and driver (BR-014: a uniform 422 `invalid_vehicle` / `invalid_employee`)
 * and an append-only history. Permissions of the operations themselves are enforced by the caller (`mockApi`).
 */
export interface MockAssignmentStore {
  readonly port: AssignmentsPort;
  /** Another actor closes the assignment on the server: the caller's copy is stale and read-only. */
  endExternally(id: string): void;
  /** Assignments as stored, for assertions. */
  snapshot(): readonly VehicleAssignment[];
}

export interface MockAssignmentEnvironment {
  /** Whether the vehicle exists, is not archived, and is neither inactive nor decommissioned (BR-014). */
  readonly isEligibleVehicle: (vehicleId: string) => boolean;
  /** Whether the employee exists, is an active driver and is not archived (BR-014). */
  readonly isEligibleDriver: (employeeId: string) => boolean;
  /** The signed-in user, recorded in the history. */
  readonly actorId: () => string;
}

const NOW = '2026-10-06T12:00:00.000Z';
let correlation = 0;

function failure(
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
      correlationId: `corr-mock-assignment-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');
const notFound = () => failure(404, 'not_found', 'Resource not found');
const conflict = (code: 'stale_version' | 'immutable') => failure(409, code, 'Conflict');
const taken = (field: 'vehicle_id' | 'employee_id') =>
  failure(409, 'principal_taken', 'Conflict', field);

const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

const onlyKeys = (fields: Readonly<Record<string, unknown>>, allowed: readonly string[]) =>
  Object.keys(fields).every((key) => allowed.includes(key));

const isType = (value: unknown): value is AssignmentType =>
  typeof value === 'string' && (BFF_ASSIGNMENT_TYPES as readonly string[]).includes(value);

const reasonOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = normalizeReason(value);
  return REASON.test(text) ? text : null;
};

const offsetOf = (cursor: string | undefined): number =>
  cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(cursor)?.[1]);

function pageOf<T>(
  all: readonly T[],
  query: { limit?: number; cursor?: string },
  sort: Page<T>['sort'],
): Result<Page<T>> {
  const limit = query.limit ?? 25;
  const offset = offsetOf(query.cursor);
  if (![25, 50, 100].includes(limit) || !Number.isSafeInteger(offset)) return badRequest();
  const next = offset + limit;
  return ok({
    items: all.slice(offset, next),
    nextCursor: next < all.length ? `mock:${next}` : null,
    total: all.length,
    sort,
  });
}

export function createMockAssignmentStore(
  env: MockAssignmentEnvironment,
  seed: readonly VehicleAssignment[] = demoAssignments(),
  now: () => string = () => NOW,
): MockAssignmentStore {
  let rows: VehicleAssignment[] = seed.map((assignment) => ({ ...assignment }));
  let sequence = rows.length;
  const events = new Map<string, AssignmentEvent[]>(
    rows.map((assignment) => [
      assignment.id,
      [
        {
          seq: 1,
          kind: 'assigned',
          actorId: assignment.assignedBy,
          reason: assignment.reason,
          at: assignment.startedAt,
        },
        ...(assignment.endedAt === null
          ? []
          : [
              {
                seq: 2,
                kind: assignment.endKind ?? 'ended',
                actorId: assignment.endedBy ?? assignment.assignedBy,
                reason: assignment.endReason ?? '',
                at: assignment.endedAt,
              } satisfies AssignmentEvent,
            ]),
      ],
    ]),
  );

  const index = (id: string) => rows.findIndex((assignment) => assignment.id === id);
  const replace = (id: string, next: VehicleAssignment) => {
    rows = rows.map((assignment) => (assignment.id === id ? next : assignment));
    return next;
  };
  const closeRow = (
    assignment: VehicleAssignment,
    endKind: 'ended' | 'replaced',
    reason: string,
    actor: string,
  ): VehicleAssignment => {
    const at = now();
    events.set(assignment.id, [
      ...(events.get(assignment.id) ?? []),
      { seq: 2, kind: endKind, actorId: actor, reason, at },
    ]);
    return replace(assignment.id, {
      ...assignment,
      endedAt: at,
      endKind,
      endReason: reason,
      endedBy: actor,
      current: false,
      version: assignment.version + 1,
      updatedAt: at,
    });
  };
  const currentOf = (match: (assignment: VehicleAssignment) => boolean) =>
    rows.find((assignment) => assignment.endedAt === null && match(assignment));

  const port: AssignmentsPort = {
    list: async (query: AssignmentListQuery = {}) => {
      if (
        (query.vehicleId !== undefined && !OPAQUE_ID.test(query.vehicleId)) ||
        (query.employeeId !== undefined && !OPAQUE_ID.test(query.employeeId)) ||
        (query.type !== undefined && !isType(query.type)) ||
        (query.status !== undefined && !BFF_ASSIGNMENT_STATUSES.includes(query.status))
      )
        return badRequest();
      const matches = rows
        .filter(
          (assignment) =>
            (query.vehicleId === undefined || assignment.vehicleId === query.vehicleId) &&
            (query.employeeId === undefined || assignment.employeeId === query.employeeId) &&
            (query.type === undefined || assignment.type === query.type) &&
            (query.status === undefined ||
              (assignment.endedAt === null) === (query.status === 'current')),
        )
        .sort((a, b) =>
          a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? -1 : 1,
        );
      return pageOf(matches, query, { field: 'startedAt', direction: 'desc' });
    },
    get: async (id) => {
      const found = rows[index(id)];
      return found ? ok({ ...found }) : notFound();
    },
    assign: async (input: AssignmentInput) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      const { vehicleId, employeeId, type, replace: replaceFlag } = fields;
      const reason = reasonOf(fields['reason']);
      if (
        !onlyKeys(fields, ['vehicleId', 'employeeId', 'type', 'reason', 'replace']) ||
        typeof vehicleId !== 'string' ||
        !OPAQUE_ID.test(vehicleId) ||
        typeof employeeId !== 'string' ||
        !OPAQUE_ID.test(employeeId) ||
        !isType(type) ||
        reason === null ||
        (replaceFlag !== undefined && typeof replaceFlag !== 'boolean') ||
        (replaceFlag === true && type !== 'principal')
      )
        return badRequest();
      if (!env.isEligibleVehicle(vehicleId))
        return failure(422, 'invalid_vehicle', 'Unprocessable request', 'vehicle_id');
      if (!env.isEligibleDriver(employeeId))
        return failure(422, 'invalid_employee', 'Unprocessable request', 'employee_id');
      if (currentOf((a) => a.vehicleId === vehicleId && a.employeeId === employeeId))
        return failure(409, 'already_assigned', 'Conflict', 'employee_id');
      let replaced: VehicleAssignment | null = null;
      if (type === 'principal') {
        const holder = currentOf((a) => a.vehicleId === vehicleId && a.type === 'principal');
        if (holder && replaceFlag !== true) return taken('vehicle_id');
        if (currentOf((a) => a.employeeId === employeeId && a.type === 'principal'))
          return taken('employee_id');
        if (holder) replaced = closeRow(holder, 'replaced', reason, env.actorId());
      }
      sequence += 1;
      const at = now();
      const assignment: VehicleAssignment = {
        id: `asg-nueva-${sequence}`,
        vehicleId,
        employeeId,
        type,
        reason,
        assignedBy: env.actorId(),
        startedAt: at,
        endedAt: null,
        endKind: null,
        endReason: null,
        endedBy: null,
        current: true,
        version: 1,
        updatedAt: at,
      };
      rows = [...rows, assignment];
      events.set(assignment.id, [
        { seq: 1, kind: 'assigned', actorId: assignment.assignedBy, reason, at },
      ]);
      return ok({ assignment: { ...assignment }, replaced } satisfies AssignmentCreated);
    },
    end: async (id, end) => {
      const { version, ...rest } = end as unknown as Record<string, unknown>;
      const reason = reasonOf(rest['reason']);
      if (!validVersion(version) || reason === null || !onlyKeys(rest, ['reason']))
        return badRequest();
      const current = rows[index(id)];
      if (!current) return notFound();
      if (current.endedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      return ok({ ...closeRow(current, 'ended', reason, env.actorId()) });
    },
    history: async (id, query = {}) => {
      if (index(id) === -1) return notFound();
      const all = [...(events.get(id) ?? [])].sort((a, b) => b.seq - a.seq);
      return pageOf(all, query, { field: 'seq', direction: 'desc' });
    },
  };

  return {
    port,
    endExternally: (id) => {
      const current = rows[index(id)];
      if (current && current.endedAt === null)
        closeRow(current, 'ended', 'Cierre de otra persona', 'user-otra');
    },
    snapshot: () => rows.map((assignment) => ({ ...assignment })),
  };
}
