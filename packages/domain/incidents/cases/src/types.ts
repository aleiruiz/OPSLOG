import type {
  CoverageStatus,
  DamageZone,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  InsurerResult,
} from './catalog.js';
import type { IdempotencyClaim } from './idempotency.js';

export interface IncidentLocation {
  readonly text: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
}
export interface IncidentDamage {
  readonly description: string | null;
  readonly zones: readonly DamageZone[];
}
/** The policy revision that covered the event day, frozen when it is linked (BR-019). */
export interface PolicySnapshot {
  readonly policyId: string;
  readonly revision: number;
  readonly insurer: string;
  readonly policyNumber: string;
  readonly coverageType: string;
  readonly startsOn: string;
  readonly endsOn: string;
}
export interface Approval {
  readonly by: string;
  readonly at: string;
}

/**
 * The whole aggregate of M4. INC-CASES writes the identity, event and coverage groups; the report,
 * process and resolution groups exist from the first migration and are written by INC-WORKFLOW,
 * so no later package redefines the model.
 */
export interface Incident {
  readonly id: string;
  readonly tenantId: string;
  readonly folio: string;
  readonly status: IncidentStatus;
  readonly version: number;
  readonly cycle: number;
  readonly reopenCount: number;
  // Event
  readonly type: IncidentType;
  readonly severity: IncidentSeverity | null;
  readonly vehicleId: string;
  /** Area of the vehicle when the case was written. */
  readonly areaId: string;
  readonly driverId: string | null;
  readonly noDriverReason: string | null;
  /** UTC instant of the event. */
  readonly occurredAt: string | null;
  /** Calendar day of `occurredAt` in the tenant's IANA zone. */
  readonly occurredOn: string | null;
  readonly location: IncidentLocation | null;
  readonly description: string | null;
  readonly vehicleOperable: boolean | null;
  readonly damage: IncidentDamage;
  readonly noPhotoJustification: string | null;
  // Coverage
  readonly coverageStatus: CoverageStatus;
  readonly policySnapshot: PolicySnapshot | null;
  // Report (INC-WORKFLOW)
  readonly reportedAt: string | null;
  readonly reportedBy: string | null;
  // Process (INC-WORKFLOW)
  readonly responsibleId: string | null;
  readonly insurerName: string | null;
  readonly claimNumber: string | null;
  readonly adjusterName: string | null;
  readonly adjusterContact: string | null;
  readonly insurerReportedOn: string | null;
  readonly insurerResult: InsurerResult | null;
  readonly rejectionReason: string | null;
  readonly appealNote: string | null;
  readonly noInsuranceReason: string | null;
  readonly costAssumed: boolean | null;
  // Resolution (INC-WORKFLOW)
  readonly resolutionSummary: string | null;
  readonly totalLoss: boolean | null;
  readonly vehicleStatusDecision: string | null;
  readonly resolvedAt: string | null;
  readonly assumptionApproval: Approval | null;
  readonly closeApproval: Approval | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly cancelReason: string | null;
  // Own audit
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** Timeline commands that keep the status (edits and children); the state commands are INC-WORKFLOW's. */
export const INCIDENT_TIMELINE_COMMANDS = [
  'create',
  'update',
  'coverage_none',
  'third_party_added',
  'third_party_updated',
  'third_party_removed',
  'evidence_attached',
  'evidence_detached',
  'insurance_updated',
  'resolution_updated',
] as const;
export type IncidentTimelineCommand = (typeof INCIDENT_TIMELINE_COMMANDS)[number];

/** Facts a timeline entry may keep of the state before a change: structured ones, never free text. */
export type TimelineBefore = Readonly<Record<string, string | number | boolean | null>>;

/** An entry as the service builds it; the store assigns `sequence` inside the transaction. */
export interface NewIncidentTransition {
  readonly command: string;
  readonly from: IncidentStatus | null;
  readonly to: IncidentStatus;
  readonly actorId: string;
  readonly comment: string | null;
  readonly occurredAt: string;
  /** Names of the fields the entry changed, never their values. */
  readonly changedFields: readonly string[];
  readonly before: TimelineBefore | null;
}
/** Append-only timeline entry. */
export interface IncidentTransition extends NewIncidentTransition {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly sequence: number;
}

/** Outbox events of this module. Payloads are allowlisted before persistence. */
export const INCIDENT_CREATED_EVENT = 'incident.created';
export const INCIDENT_UPDATED_EVENT = 'incident.updated';
/** INC-WORKFLOW events (SPECS §7): one per state command, with ids, the version and the status only. */
export const INCIDENT_STATUS_CHANGED_EVENT = 'incident.status_changed';
export const INCIDENT_ASSIGNED_EVENT = 'incident.assigned';
export const INCIDENT_CANCELLED_EVENT = 'incident.cancelled';
export interface IncidentEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, string | number>>;
}

/**
 * One atomic write: incident row (version CAS), timeline, local audit and outbox in one tenant
 * transaction. For a creation the store also allocates the folio from the atomic sequence.
 */
export interface IncidentMutation {
  readonly incident: Incident;
  /** `null` for a new incident; otherwise the version the write is conditional on. */
  readonly expectedVersion: number | null;
  /** Year of the folio when the incident is new. */
  readonly folioYear: number | null;
  readonly transitions: readonly NewIncidentTransition[];
  readonly auditActions: readonly string[];
  readonly events: readonly IncidentEvent[];
  readonly idempotency?: IdempotencyClaim;
}
/**
 * A write of another package (the third parties and evidence of the case) that commits or fails
 * together with the incident mutation. `tx` is whatever the store runs in: the ORM manager of the
 * transaction for MySQL, nothing in memory. It resolves `false` on a uniqueness conflict, which
 * aborts the whole mutation; any other failure throws and aborts it as well.
 */
export interface IncidentExtraWrite {
  run(tx: unknown): Promise<boolean>;
}
export type IncidentApplyResult =
  | { readonly applied: false }
  | { readonly applied: true; readonly incident: Incident };

export const LIST_SORT_FIELDS = ['occurredAt', 'createdAt', 'severity', 'folio'] as const;
export type IncidentSortField = (typeof LIST_SORT_FIELDS)[number];
export const LIST_LIMITS = [25, 50, 100] as const;

export interface IncidentListFilter {
  readonly statuses?: readonly IncidentStatus[];
  readonly severity?: IncidentSeverity;
  readonly type?: IncidentType;
  readonly vehicleId?: string;
  readonly responsibleId?: string;
  readonly createdBy?: string;
  /** Inclusive tenant calendar days compared with `occurredOn`. */
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
}
export interface IncidentListQuery {
  readonly filter: IncidentListFilter;
  readonly sort: IncidentSortField;
  readonly direction: 'asc' | 'desc';
  readonly limit: 25 | 50 | 100;
  readonly offset: number;
}
export interface IncidentPage {
  readonly items: readonly Incident[];
  readonly total: number;
}
