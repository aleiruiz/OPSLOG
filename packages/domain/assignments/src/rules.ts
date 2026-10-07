import { AssignmentError } from './errors.js';
import {
  type Assignment,
  type AssignmentEvent,
  type EndKind,
  type NewAssignmentData,
} from './types.js';

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
