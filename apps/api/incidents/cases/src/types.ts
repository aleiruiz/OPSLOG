import type {
  Permission,
  TenantContext,
} from '../../../../../packages/domain/identity/src/index.js';
import type {
  CoverageStatus,
  DamageZone,
  DriverSuggestion,
  FieldIssue,
  IncidentService,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  PolicySnapshot,
  TimelineBefore,
  VehicleProposal,
  WritableKey,
} from '../../../../../packages/domain/incidents/cases/src/index.js';

export type IncidentApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  | 'invalid_transition'
  | 'rule_violation'
  | 'duplicate'
  | 'idempotency_conflict'
  | 'internal_error';

export interface IncidentApiResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly code: IncidentApiErrorCode;
    readonly status: number;
    readonly message: string;
    /** Names and reasons of the rejected fields of a 400; never the values. */
    readonly fieldErrors?: readonly FieldIssue[];
    /** Stable id of the broken business rule of a 422. */
    readonly rule?: string;
  };
}

/** A person with the name the screens show; the id is for links and commands only. */
export interface PersonRef {
  readonly id: string;
  readonly displayName: string;
}
export type CoverageAlert = 'no_policy_on_event_day' | 'several_policies';

export interface IncidentView {
  readonly id: string;
  readonly folio: string;
  readonly status: IncidentStatus;
  readonly version: number;
  readonly cycle: number;
  readonly reopenCount: number;
  readonly type: IncidentType;
  readonly severity: IncidentSeverity | null;
  readonly vehicle: {
    readonly id: string;
    readonly economicNumber: string;
    readonly plate: string;
  };
  readonly driver: { readonly employeeId: string; readonly displayName: string } | null;
  readonly noDriverReason: string | null;
  readonly occurredAt: string | null;
  readonly occurredOn: string | null;
  readonly location: {
    readonly text: string;
    readonly latitude: number | null;
    readonly longitude: number | null;
  } | null;
  readonly description: string | null;
  readonly vehicleOperable: boolean | null;
  readonly damage: { readonly description: string | null; readonly zones: readonly DamageZone[] };
  readonly noPhotoJustification: string | null;
  readonly coverage: {
    readonly status: CoverageStatus;
    readonly policy: PolicySnapshot | null;
    readonly alert: CoverageAlert | null;
  };
  readonly vehicleProposal: VehicleProposal | null;
  /** Insurer data and resolution belong to INC-WORKFLOW; `null` until then. */
  readonly insurance: null;
  readonly resolution: null;
  readonly reportedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: PersonRef;
  readonly responsible: PersonRef | null;
  readonly reportedBy: PersonRef | null;
  readonly editableFields: readonly WritableKey[];
}
export interface IncidentTimelineEntry {
  readonly sequence: number;
  readonly command: string;
  readonly from: IncidentStatus | null;
  readonly to: IncidentStatus;
  readonly actor: PersonRef;
  readonly comment: string | null;
  readonly occurredAt: string;
  readonly changedFields: readonly string[];
  readonly before: TimelineBefore | null;
}
export interface IncidentListView {
  readonly items: readonly IncidentView[];
  readonly total: number;
  readonly tenantId: string;
}
export interface IncidentSuggestionsView {
  readonly drivers: readonly DriverSuggestion[];
  readonly policies: readonly PolicySnapshot[];
  readonly coverage: { readonly status: CoverageStatus; readonly alert: CoverageAlert | null };
}

/** Where the screens get names from; ids are never shown as labels. */
export interface IncidentLabels {
  vehicle(
    tenantId: string,
    vehicleId: string,
  ): Promise<{ readonly economicNumber: string; readonly plate: string } | null>;
  driver(tenantId: string, employeeId: string): Promise<string | null>;
  /** `actorId` is `user-<subject>`. */
  member(tenantId: string, actorId: string): Promise<string>;
}

export interface IncidentApiDeps {
  readonly incidents: IncidentService;
  /** Authenticates the session and returns its effective grants (never from the request). */
  readonly authorize: (
    token: string,
    correlationId: string,
  ) => Promise<{ readonly context: TenantContext; readonly permissions: readonly Permission[] }>;
  /** Whether the member has any mechanic record, active or not (stable source of D9 scope). */
  readonly mechanicLinked: (tenantId: string, memberId: string) => Promise<boolean>;
  readonly labels: IncidentLabels;
  /** Best-effort audit of a refused access (403/404); a failure here never changes the answer. */
  readonly deny: (
    context: TenantContext,
    action: string,
    entityId: string,
    correlationId: string,
  ) => Promise<void>;
}
