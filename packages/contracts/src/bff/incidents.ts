import type { ISODateTime, Page } from '../index.js';
import type { BffIncidentSla } from './incident-sla.js';
import type { BffRouteDefinition } from './shared.js';

/** Incident states (SPECS §6.2). Ids are English snake_case; Spanish labels belong to the web layer. */
export const BFF_INCIDENT_STATUSES = [
  'draft',
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'closed',
  'reopened',
  'cancelled',
] as const;
export type BffIncidentStatus = (typeof BFF_INCIDENT_STATUSES)[number];
export const BFF_INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type BffIncidentSeverity = (typeof BFF_INCIDENT_SEVERITIES)[number];
/** D4: a traffic violation is a type of incident, not a module of its own. */
export const BFF_INCIDENT_TYPES = [
  'collision',
  'rollover',
  'theft_total',
  'theft_partial',
  'vandalism',
  'parking_damage',
  'mechanical_failure',
  'traffic_violation',
  'injury',
  'other',
] as const;
export type BffIncidentType = (typeof BFF_INCIDENT_TYPES)[number];
export const BFF_DAMAGE_ZONES = [
  'front',
  'rear',
  'left_side',
  'right_side',
  'roof',
  'windshield',
  'wheels',
  'engine',
  'underbody',
  'interior',
  'cargo_area',
  'other',
] as const;
export type BffDamageZone = (typeof BFF_DAMAGE_ZONES)[number];
/** State commands (SPECS §6.2). `POST /api/v1/incidents/:incidentId/transitions` takes one of them as `command`. */
export const BFF_INCIDENT_COMMANDS = [
  'report',
  'assign',
  'review',
  'insure',
  'no_insurance',
  'reject',
  'appeal',
  'approve_assumption',
  'repair',
  'resolve',
  'approve_close',
  'close',
  'reopen',
  'cancel',
] as const;
export type BffIncidentCommand = (typeof BFF_INCIDENT_COMMANDS)[number];
export const BFF_INSURER_RESULTS = ['pending', 'accepted', 'partial', 'rejected'] as const;
export type BffInsurerResult = (typeof BFF_INSURER_RESULTS)[number];
export const BFF_INCIDENT_SORT_FIELDS = ['occurredAt', 'createdAt', 'severity', 'folio'] as const;
export type BffIncidentSortField = (typeof BFF_INCIDENT_SORT_FIELDS)[number];

/** `unknown` while there is no event time; `multiple` while several policies cover the day and none is chosen. */
export type BffCoverageStatus = 'unknown' | 'covered' | 'multiple' | 'none';
export type BffCoverageAlert = 'no_policy_on_event_day' | 'several_policies';

/** A person with the name the screens show; the id is for links and commands only. */
export interface BffIncidentPerson {
  readonly id: string;
  readonly displayName: string;
}
/** The policy revision that covered the event day, frozen when it was linked (BR-019). */
export interface BffIncidentPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly insurer: string;
  readonly policyNumber: string;
  readonly coverageType: string;
  readonly startsOn: string;
  readonly endsOn: string;
}
export interface BffIncidentLocation {
  readonly text: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
}
export interface BffIncidentDamage {
  readonly description: string | null;
  readonly zones: readonly BffDamageZone[];
}
/** Fields a caller may write: the event plus the explicit choice of the covering policy. */
export type BffIncidentField =
  | 'vehicleId'
  | 'type'
  | 'severity'
  | 'driverId'
  | 'noDriverReason'
  | 'occurredAt'
  | 'location'
  | 'description'
  | 'vehicleOperable'
  | 'damage'
  | 'noPhotoJustification'
  | 'policyId';

/** A D20 approval: who gave it (with the name the screens show) and when. */
export interface BffIncidentApproval {
  readonly by: BffIncidentPerson;
  readonly at: ISODateTime;
}
/** Process data of the insurer. Visible with `incidents:view`; it carries no amounts. */
export interface BffIncidentInsurance {
  readonly insurerName: string | null;
  readonly claimNumber: string | null;
  readonly adjusterName: string | null;
  readonly adjusterContact: string | null;
  /** Calendar day in the company's time zone. */
  readonly insurerReportedOn: string | null;
  readonly insurerResult: BffInsurerResult | null;
  readonly rejectionReason: string | null;
  readonly appealNote: string | null;
  /** The decision to go on without the insurer. The screens never say the company lacks legal coverage. */
  readonly noInsuranceReason: string | null;
  readonly costAssumed: boolean | null;
  readonly assumptionApproval: BffIncidentApproval | null;
}
export interface BffIncidentResolution {
  readonly resolutionSummary: string | null;
  readonly totalLoss: boolean | null;
  /** One of `BFF_VEHICLE_STATUS_DECISIONS`. Recorded, never applied by the case (D11). */
  readonly vehicleStatusDecision: string | null;
  readonly resolvedAt: ISODateTime | null;
  readonly closeApproval: BffIncidentApproval | null;
  readonly closedAt: ISODateTime | null;
  readonly closedBy: BffIncidentPerson | null;
  readonly cancelReason: string | null;
}
export const BFF_VEHICLE_STATUS_DECISIONS = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
] as const;
export type BffVehicleStatusDecision = (typeof BFF_VEHICLE_STATUS_DECISIONS)[number];

export interface BffIncident {
  readonly id: string;
  readonly folio: string;
  readonly status: BffIncidentStatus;
  /** Concurrency token of `PATCH`. */
  readonly version: number;
  readonly cycle: number;
  readonly reopenCount: number;
  readonly type: BffIncidentType;
  readonly severity: BffIncidentSeverity | null;
  readonly vehicle: {
    readonly id: string;
    readonly economicNumber: string;
    readonly plate: string;
  };
  readonly driver: { readonly employeeId: string; readonly displayName: string } | null;
  readonly noDriverReason: string | null;
  readonly occurredAt: ISODateTime | null;
  /** Calendar day of `occurredAt` in the company's time zone. */
  readonly occurredOn: string | null;
  readonly location: BffIncidentLocation | null;
  readonly description: string | null;
  readonly vehicleOperable: boolean | null;
  readonly damage: BffIncidentDamage;
  readonly noPhotoJustification: string | null;
  readonly coverage: {
    readonly status: BffCoverageStatus;
    readonly policy: BffIncidentPolicy | null;
    readonly alert: BffCoverageAlert | null;
  };
  /**
   * A suggestion while the vehicle cannot operate, or `decommissioned` after a total loss; the
   * incident never changes the vehicle by itself (D11).
   */
  readonly vehicleProposal: {
    readonly suggestedStatus: 'out_of_service' | 'decommissioned';
    readonly reason: string;
  } | null;
  readonly insurance: BffIncidentInsurance;
  readonly resolution: BffIncidentResolution;
  readonly reportedAt: ISODateTime | null;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly createdBy: BffIncidentPerson;
  readonly responsible: BffIncidentPerson | null;
  readonly reportedBy: BffIncidentPerson | null;
  /** Fields the caller may change in the current state; empty when the case is read-only for them. */
  readonly editableFields: readonly BffIncidentField[];
  /** State commands the caller's permission and the current state allow now; their requirements are in `next-steps`. */
  readonly allowedCommands: readonly BffIncidentCommand[];
  /** The calculated SLA (INC-SLA); absent when the case has none. */
  readonly sla?: BffIncidentSla;
}

/** Draft (FR-110): the vehicle and the type are enough; every other field may be missing. */
export interface BffIncidentInput {
  readonly vehicleId: string;
  readonly type: BffIncidentType;
  readonly severity?: BffIncidentSeverity | null;
  readonly driverId?: string | null;
  readonly noDriverReason?: string | null;
  readonly occurredAt?: ISODateTime | null;
  readonly location?: BffIncidentLocation | { readonly text: string } | null;
  readonly description?: string | null;
  readonly vehicleOperable?: boolean | null;
  readonly damage?: {
    readonly description?: string | null;
    readonly zones?: readonly BffDamageZone[];
  };
  readonly noPhotoJustification?: string | null;
  readonly policyId?: string | null;
}
/**
 * Fields of the event with the `version` they were read at; at least one besides it. Never `status`.
 * `damage`, when present, replaces the whole object (description and zones); it is not merged.
 */
export interface BffIncidentPatch extends Partial<Omit<BffIncidentInput, 'vehicleId' | 'type'>> {
  readonly version: number;
  readonly vehicleId?: string;
  readonly type?: BffIncidentType;
}

export interface BffIncidentsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  /** Comma-separated states, for example `draft,reported`. */
  readonly status?: string;
  readonly severity?: BffIncidentSeverity;
  readonly type?: BffIncidentType;
  readonly vehicleId?: string;
  readonly responsible?: 'me';
  readonly createdBy?: 'me';
  /** `YYYY-MM-DD` in the company's time zone, inclusive. */
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly sort?: BffIncidentSortField;
  readonly direction?: 'asc' | 'desc';
}
export interface BffIncidentSuggestionsQuery {
  readonly vehicleId: string;
  readonly occurredAt: ISODateTime;
}
/** Append-only timeline entry. Field names only: never values, free text or amounts. */
export interface BffIncidentTimelineEntry {
  readonly sequence: number;
  readonly command: string;
  readonly from: BffIncidentStatus | null;
  readonly to: BffIncidentStatus;
  readonly actor: BffIncidentPerson;
  readonly comment: string | null;
  readonly occurredAt: ISODateTime;
  readonly changedFields: readonly string[];
  /** Structured facts before the change (ids, states, instants). */
  readonly before: Readonly<Record<string, string | number | boolean | null>> | null;
}
export interface BffIncidentSuggestions {
  /** Drivers assigned to the vehicle at the instant, principal first. */
  readonly drivers: readonly {
    readonly employeeId: string;
    readonly displayName: string;
    readonly type: 'principal' | 'secondary' | 'temporary';
  }[];
  /** Policies that cover the company's calendar day of the instant; no deductible. */
  readonly policies: readonly BffIncidentPolicy[];
  readonly coverage: {
    readonly status: BffCoverageStatus;
    readonly alert: BffCoverageAlert | null;
  };
}

/** Request and response types of the incident routes. */
export interface IncidentRouteTypes {
  'incidents.list': { query?: BffIncidentsQuery; response: Page<BffIncident> };
  'incidents.create': {
    body: BffIncidentInput;
    /**
     * Sent as the `Idempotency-Key` header, never in the body. Optional: the same key with the same
     * body replays the first result, with another body it answers 409 `idempotency_conflict`.
     */
    idempotencyKey?: string;
    response: BffIncident;
  };
  'incidents.suggestions': {
    query: BffIncidentSuggestionsQuery;
    response: BffIncidentSuggestions;
  };
  'incidents.get': { params: { incidentId: string }; response: BffIncident };
  'incidents.update': {
    params: { incidentId: string };
    body: BffIncidentPatch;
    response: BffIncident;
  };
  'incidents.timeline': {
    params: { incidentId: string };
    response: { items: readonly BffIncidentTimelineEntry[] };
  };
}

const incidents = ['api', 'v1', 'incidents'] as const;
export const INCIDENT_ROUTES = {
  'incidents.list': { method: 'GET', path: incidents, kind: 'session', status: 200 },
  'incidents.create': {
    method: 'POST',
    path: incidents,
    kind: 'session-csrf',
    status: 201,
    idempotency: { requiredFor: [] },
  },
  // Declared before `:incidentId` so the literal segment is never read as an id.
  'incidents.suggestions': {
    method: 'GET',
    path: [...incidents, 'suggestions'],
    kind: 'session',
    status: 200,
  },
  'incidents.get': {
    method: 'GET',
    path: [...incidents, ':incidentId'],
    kind: 'session',
    status: 200,
  },
  'incidents.update': {
    method: 'PATCH',
    path: [...incidents, ':incidentId'],
    kind: 'session-csrf',
    status: 200,
  },
  'incidents.timeline': {
    method: 'GET',
    path: [...incidents, ':incidentId', 'timeline'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof IncidentRouteTypes, BffRouteDefinition>;
