/** Incident states of SPECS §6.2. Ids are English snake_case; Spanish labels belong to the web layer. */
export const INCIDENT_STATUSES = [
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
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
/** Closed and cancelled cases accept no write of any package. */
export const TERMINAL_STATUSES: readonly IncidentStatus[] = ['closed', 'cancelled'];

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** D4: a traffic violation is a type of incident, not a module of its own. */
export const INCIDENT_TYPES = [
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
export type IncidentType = (typeof INCIDENT_TYPES)[number];

/** Route flags of a type (SPECS §6.2). INC-WORKFLOW applies them; they belong to the model. */
export interface IncidentTypeRules {
  /** The case may go on without the insurer. */
  readonly directRoute: boolean;
  readonly repairAllowed: boolean;
  /** A police report or complaint is required to open the insurer process. */
  readonly reportRequiredForInsurer: boolean;
}
export const INCIDENT_TYPE_RULES: Readonly<Record<IncidentType, IncidentTypeRules>> = {
  collision: { directRoute: false, repairAllowed: true, reportRequiredForInsurer: false },
  rollover: { directRoute: false, repairAllowed: true, reportRequiredForInsurer: false },
  theft_total: { directRoute: false, repairAllowed: false, reportRequiredForInsurer: true },
  theft_partial: { directRoute: false, repairAllowed: true, reportRequiredForInsurer: true },
  vandalism: { directRoute: false, repairAllowed: true, reportRequiredForInsurer: false },
  parking_damage: { directRoute: true, repairAllowed: true, reportRequiredForInsurer: false },
  mechanical_failure: { directRoute: true, repairAllowed: true, reportRequiredForInsurer: false },
  traffic_violation: { directRoute: true, repairAllowed: false, reportRequiredForInsurer: false },
  injury: { directRoute: false, repairAllowed: false, reportRequiredForInsurer: true },
  other: { directRoute: true, repairAllowed: true, reportRequiredForInsurer: false },
};

/** Zones of the damage checklist (BRD §10.2). A fixed list keeps free text out of the checklist. */
export const DAMAGE_ZONES = [
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
export type DamageZone = (typeof DAMAGE_ZONES)[number];

/**
 * Coverage at the event day: `unknown` while there is no event time, `covered` once exactly one
 * policy is linked (found alone or chosen), `multiple` while several cover the day and none is
 * chosen, `none` when no policy covers it.
 */
export const COVERAGE_STATUSES = ['unknown', 'covered', 'multiple', 'none'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** Insurer result of the process data (written by INC-WORKFLOW). */
export const INSURER_RESULTS = ['pending', 'accepted', 'partial', 'rejected'] as const;
export type InsurerResult = (typeof INSURER_RESULTS)[number];

export const ASSIGNMENT_ORDER = ['principal', 'secondary', 'temporary'] as const;
export type AssignmentOrder = (typeof ASSIGNMENT_ORDER)[number];

/** Rank used to sort by severity; a case without severity (draft) sorts below `low`. */
export const SEVERITY_RANK: Readonly<Record<IncidentSeverity | 'none', number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
