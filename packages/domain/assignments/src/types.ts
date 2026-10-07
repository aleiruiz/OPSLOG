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

export const MAX_REASON_LENGTH = 200;

export interface NewAssignmentData {
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: AssignmentType;
  readonly reason: string;
  /** US-013: close the vehicle's current principal and assign this driver in its place. */
  readonly replace: boolean;
}
