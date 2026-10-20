import type { AssignmentOrder } from './catalog.js';
import type { IdempotencyRecord } from './idempotency.js';
import type {
  Incident,
  IncidentApplyResult,
  IncidentExtraWrite,
  IncidentListQuery,
  IncidentMutation,
  IncidentPage,
  IncidentTransition,
} from './types.js';

export interface IncidentStore {
  /**
   * Applies the mutation atomically (incident, timeline, audit, outbox, folio, idempotency key).
   * Returns `applied: false` on a stale version or a taken idempotency key; nothing is written then.
   * An `extra` write of another package joins the same transaction.
   */
  apply(mutation: IncidentMutation, extra?: IncidentExtraWrite): Promise<IncidentApplyResult>;
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

/**
 * Optional batch reads of the store for the reports: the same answers as `get` and `history`, for
 * many cases in a bounded number of reads. Ids unknown to the tenant are absent from the answer.
 */
export interface IncidentBatchReads {
  getMany(tenantId: string, ids: readonly string[]): Promise<readonly Incident[]>;
  /** Oldest first, by case id; a case without entries is absent. */
  historyMany(
    tenantId: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, readonly IncidentTransition[]>>;
}

/** Report, first resolution and closure instants of a case, for the dashboard. No text, no ids. */
export interface IncidentTimelineRow {
  readonly reportedAt: string | null;
  /** Resolution of the first cycle (the first `resolve` entry); null while it is unresolved. */
  readonly firstResolvedAt: string | null;
  readonly closedAt: string | null;
}
/** Optional aggregate reads of the store (dashboard). `areaIds: null` reads the whole company. */
export interface IncidentAnalyticsReads {
  /** Cases past `draft` and not `closed` or `cancelled`, whole (the SLA reader needs the case). */
  analyticsOpenCases(
    tenantId: string,
    areaIds: readonly string[] | null,
  ): Promise<readonly Incident[]>;
  /** Cases reported, first resolved or closed in `[from, to)`. */
  analyticsTimeline(
    tenantId: string,
    areaIds: readonly string[] | null,
    window: { readonly from: string; readonly to: string },
  ): Promise<readonly IncidentTimelineRow[]>;
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
  /** Live vehicles only, unless `includeArchived`: an existing case keeps its archived vehicle. */
  vehicle(
    tenantId: string,
    vehicleId: string,
    options?: { readonly includeArchived?: boolean },
  ): Promise<VehicleRef | null>;
  driver(tenantId: string, employeeId: string): Promise<DriverRef | null>;
  assignments(tenantId: string, vehicleId: string): Promise<readonly AssignmentRef[]>;
  policyRevisions(tenantId: string, vehicleId: string): Promise<readonly PolicyRevisionRef[]>;
  /** IANA zone of the tenant. */
  timeZone(tenantId: string): Promise<string>;
}
