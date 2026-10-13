import type { AssignmentOrder } from './catalog.js';
import type { IdempotencyRecord } from './idempotency.js';
import type {
  Incident,
  IncidentApplyResult,
  IncidentListQuery,
  IncidentMutation,
  IncidentPage,
  IncidentTransition,
} from './types.js';

export interface IncidentStore {
  /**
   * Applies the mutation atomically (incident, timeline, audit, outbox, folio, idempotency key).
   * Returns `applied: false` on a stale version or a taken idempotency key; nothing is written then.
   */
  apply(mutation: IncidentMutation): Promise<IncidentApplyResult>;
  get(tenantId: string, id: string): Promise<Incident | null>;
  list(tenantId: string, query: IncidentListQuery): Promise<IncidentPage>;
  /** Oldest first. */
  history(tenantId: string, id: string): Promise<readonly IncidentTransition[]>;
  /** The stored key of (tenant, actor, command, key), expired or not; null when unknown. */
  idempotency(
    tenantId: string,
    actorId: string,
    command: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
}

/** A live (not archived) vehicle of the tenant. */
export interface VehicleRef {
  readonly id: string;
  readonly areaId: string;
  /** `YYYY-MM-DD`. */
  readonly registeredOn: string;
}
/** An employee of kind driver, in any status: a driver who left keeps their historical reference. */
export interface DriverRef {
  readonly id: string;
  readonly displayName: string;
}
export interface AssignmentRef {
  readonly employeeId: string;
  readonly type: AssignmentOrder;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
/** One immutable revision of a policy of the vehicle, archived or renewed policies included. */
export interface PolicyRevisionRef {
  readonly policyId: string;
  readonly revision: number;
  readonly insurer: string;
  readonly policyNumber: string;
  readonly coverageType: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

/** Ports to other modules; each answers `null` or an empty list for an unknown or foreign id. */
export interface IncidentReferences {
  vehicle(tenantId: string, vehicleId: string): Promise<VehicleRef | null>;
  driver(tenantId: string, employeeId: string): Promise<DriverRef | null>;
  assignments(tenantId: string, vehicleId: string): Promise<readonly AssignmentRef[]>;
  policyRevisions(tenantId: string, vehicleId: string): Promise<readonly PolicyRevisionRef[]>;
  /** IANA zone of the tenant. */
  timeZone(tenantId: string): Promise<string>;
}
