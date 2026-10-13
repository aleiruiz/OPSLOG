export type IncidentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'stale_version'
  | 'invalid_transition'
  | 'rule_violation'
  | 'duplicate'
  | 'idempotency_conflict'
  | 'idempotency_key_required'
  | 'missing_requirements';

export type FieldIssueCode = 'required' | 'invalid' | 'unknown_property' | 'conflict';

/** A rejected input field: its name and why, never the value that was sent. */
export interface FieldIssue {
  readonly field: string;
  readonly code: FieldIssueCode;
}

export class IncidentError extends Error {
  public constructor(
    public readonly code: IncidentErrorCode,
    /** Per-field problems of a 400. Names only: values may carry personal data. */
    public readonly fieldErrors: readonly FieldIssue[] = [],
    /** Stable id of the broken business rule of a 422 (for example `occurred_at_in_future`). */
    public readonly rule: string | null = null,
    /** Stable ids of every unmet requirement of a 422 `missing_requirements` (SPECS §6). */
    public readonly missingRequirements: readonly string[] = [],
  ) {
    super(`Incident request rejected: ${code}`);
    this.name = 'IncidentError';
  }
}

export const RULES = {
  occurredAtInFuture: 'occurred_at_in_future',
  occurredBeforeRegistration: 'occurred_before_vehicle_registration',
  policyNotCovering: 'policy_not_covering_event_day',
  responsibleNotEligible: 'responsible_not_eligible',
  vehicleBlocked: 'vehicle_blocked',
} as const;
