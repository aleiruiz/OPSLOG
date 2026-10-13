import type {
  BffIncident,
  BffIncidentCommand,
  BffInsurerResult,
  BffVehicleStatusDecision,
} from './incidents.js';
import type { BffRouteDefinition } from './shared.js';

/** Commands that cannot run without an `Idempotency-Key` header: they carry money or reopen a closed case. */
export const BFF_INCIDENT_IDEMPOTENCY_REQUIRED_COMMANDS: readonly BffIncidentCommand[] = [
  'approve_assumption',
  'approve_close',
  'close',
  'reopen',
];

/** A state command: `version` plus the fields its requirements need (SPECS §6.2). */
export interface BffIncidentTransitionInput {
  readonly command: BffIncidentCommand;
  readonly version: number;
  /** `assign` only: the member who takes the case. Needs `incidents:edit`. */
  readonly responsibleId?: string;
  /** Saved in the timeline only, never in events or audit. */
  readonly comment?: string;
  /** `cancel` only, and required there. */
  readonly reason?: string;
}
/** What a command still lacks: stable ids, never texts. Empty when it could run now. */
export interface BffIncidentNextStep {
  readonly command: BffIncidentCommand;
  readonly missingRequirements: readonly string[];
}
/** Partial update of the insurer data: an absent field stays, `null` clears it. */
export interface BffIncidentInsuranceInput {
  readonly version: number;
  /** Chooses the policy that covered the day of the event. */
  readonly policyId?: string | null;
  readonly insurerName?: string | null;
  readonly claimNumber?: string | null;
  readonly adjusterName?: string | null;
  readonly adjusterContact?: string | null;
  /** Calendar day `YYYY-MM-DD`: not in the future and not before the event. */
  readonly insurerReportedOn?: string | null;
  readonly insurerResult?: BffInsurerResult | null;
  readonly rejectionReason?: string | null;
  readonly appealNote?: string | null;
  readonly noInsuranceReason?: string | null;
}
/** Partial update of the resolution. A change drops the approvals already given. */
export interface BffIncidentResolutionInput {
  readonly version: number;
  readonly resolutionSummary?: string | null;
  readonly totalLoss?: boolean | null;
  readonly vehicleStatusDecision?: BffVehicleStatusDecision | null;
  readonly costAssumed?: boolean | null;
}

export interface IncidentWorkflowRouteTypes {
  'incidents.transition': {
    params: { incidentId: string };
    body: BffIncidentTransitionInput;
    /**
     * Sent as the `Idempotency-Key` header, never in the body. Required for
     * `BFF_INCIDENT_IDEMPOTENCY_REQUIRED_COMMANDS` (400 `idempotency_key_required`), optional for the
     * rest. The same key with the same body replays the first result (200); with another body it
     * answers 409 `idempotency_conflict`. Unmet requirements answer 422 `missing_requirements`.
     */
    idempotencyKey?: string;
    response: BffIncident;
  };
  'incidents.nextSteps': {
    params: { incidentId: string };
    response: { items: readonly BffIncidentNextStep[] };
  };
  'incidents.insurance.update': {
    params: { incidentId: string };
    body: BffIncidentInsuranceInput;
    response: BffIncident;
  };
  'incidents.resolution.update': {
    params: { incidentId: string };
    body: BffIncidentResolutionInput;
    response: BffIncident;
  };
}

const incident = ['api', 'v1', 'incidents', ':incidentId'] as const;
export const INCIDENT_WORKFLOW_ROUTES = {
  'incidents.transition': {
    method: 'POST',
    path: [...incident, 'transitions'],
    kind: 'session-csrf',
    status: 200,
    idempotency: { requiredFor: BFF_INCIDENT_IDEMPOTENCY_REQUIRED_COMMANDS },
  },
  'incidents.nextSteps': {
    method: 'GET',
    path: [...incident, 'next-steps'],
    kind: 'session',
    status: 200,
  },
  'incidents.insurance.update': {
    method: 'PUT',
    path: [...incident, 'insurance'],
    kind: 'session-csrf',
    status: 200,
  },
  'incidents.resolution.update': {
    method: 'PUT',
    path: [...incident, 'resolution'],
    kind: 'session-csrf',
    status: 200,
  },
} as const satisfies Record<keyof IncidentWorkflowRouteTypes, BffRouteDefinition>;
