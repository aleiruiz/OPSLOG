import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_ASSIGNMENT_TYPES = ['principal', 'secondary', 'temporary'] as const;
export type BffAssignmentType = (typeof BFF_ASSIGNMENT_TYPES)[number];

/** Derived from `endedAt`: `current` while the assignment has not ended. */
export const BFF_ASSIGNMENT_STATUSES = ['current', 'ended'] as const;
export type BffAssignmentStatus = (typeof BFF_ASSIGNMENT_STATUSES)[number];

/** How an assignment ended: closed by a person or replaced by a new principal. */
export type BffAssignmentEndKind = 'ended' | 'replaced';

/**
 * A driver-vehicle assignment. The company is implicit (the session's); `version` is the
 * concurrency token. An assignment is never edited or deleted: it is closed (`endedAt`) and stays
 * as history. `startedAt` is the server clock at the moment of assigning.
 */
export interface BffVehicleAssignment {
  readonly id: string;
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: BffAssignmentType;
  readonly reason: string;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly assignedBy: string;
  readonly startedAt: ISODateTime;
  readonly endedAt: ISODateTime | null;
  readonly endKind: BffAssignmentEndKind | null;
  readonly endReason: string | null;
  readonly endedBy: string | null;
  readonly current: boolean;
  readonly version: number;
  readonly updatedAt: ISODateTime;
}

/**
 * Assigning a driver (`employeeId` of an active employee of kind driver) to a vehicle (neither
 * archived, inactive nor decommissioned). A second principal is rejected with `principal_taken`;
 * `replace: true` (principal only; needs `edit` besides `create`) closes the vehicle's current
 * principal in the same transaction and returns it as `replaced`.
 */
export interface BffVehicleAssignmentInput {
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: BffAssignmentType;
  readonly reason: string;
  readonly replace?: boolean;
}

export interface BffVehicleAssignmentCreated {
  readonly assignment: BffVehicleAssignment;
  readonly replaced: BffVehicleAssignment | null;
}

export interface BffVehicleAssignmentEnd {
  readonly version: number;
  readonly reason: string;
}

export interface BffVehicleAssignmentsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly vehicleId?: string;
  readonly employeeId?: string;
  readonly type?: BffAssignmentType;
  readonly status?: BffAssignmentStatus;
}

/** One row of the append-only history of an assignment. */
export interface BffVehicleAssignmentEvent {
  readonly seq: number;
  readonly kind: 'assigned' | BffAssignmentEndKind;
  readonly actorId: string;
  readonly reason: string;
  readonly at: ISODateTime;
}

export interface BffVehicleAssignmentHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** Request and response types of the assignments routes. */
export interface AssignmentsRouteTypes {
  'assignments.list': {
    query?: BffVehicleAssignmentsQuery;
    response: Page<BffVehicleAssignment>;
  };
  'assignments.create': { body: BffVehicleAssignmentInput; response: BffVehicleAssignmentCreated };
  'assignments.get': { params: { id: string }; response: BffVehicleAssignment };
  'assignments.end': {
    params: { id: string };
    body: BffVehicleAssignmentEnd;
    response: BffVehicleAssignment;
  };
  'assignments.history': {
    params: { id: string };
    query?: BffVehicleAssignmentHistoryQuery;
    response: Page<BffVehicleAssignmentEvent>;
  };
}

export const ASSIGNMENTS_ROUTES = {
  'assignments.list': {
    method: 'GET',
    path: ['api', 'vehicle-assignments'],
    kind: 'session',
    status: 200,
  },
  'assignments.create': {
    method: 'POST',
    path: ['api', 'vehicle-assignments'],
    kind: 'session-csrf',
    status: 201,
  },
  'assignments.get': {
    method: 'GET',
    path: ['api', 'vehicle-assignments', ':id'],
    kind: 'session',
    status: 200,
  },
  'assignments.end': {
    method: 'POST',
    path: ['api', 'vehicle-assignments', ':id', 'end'],
    kind: 'session-csrf',
    status: 200,
  },
  'assignments.history': {
    method: 'GET',
    path: ['api', 'vehicle-assignments', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof AssignmentsRouteTypes, BffRouteDefinition>;
