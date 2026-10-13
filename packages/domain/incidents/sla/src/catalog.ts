import type { IncidentSeverity, IncidentStatus } from '../../cases/src/index.js';

/**
 * The notices of the incident SLA (SPECS §2.3 D17, §7). `assigned` is the notice to a new
 * responsible; the rest are derived from the clock.
 */
export const ALERT_KINDS = [
  'assigned',
  'sla_warning',
  'sla_breach',
  'unassigned',
  'unassigned_escalation',
  'inactive',
  'inactive_escalation',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const isAlertKind = (value: unknown): value is AlertKind =>
  typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value);

/** Wall-clock hours: no work calendar and no pauses (D17). */
export const UNASSIGNED_AFTER_HOURS = 4;
export const UNASSIGNED_ESCALATION_HOURS = 24;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** SPECS §7: the 80 % threshold, compared as `5 * elapsed >= 4 * target` so no float is involved. */
export const WARNING_NUMERATOR = 4;
export const WARNING_DENOMINATOR = 5;

/** The company's SLA parameters, read at execution time (never cached across scans). */
export interface SlaSettings {
  /** IANA zone of the tenant: deadlines keep the local hour of the start. */
  readonly timeZone: string;
  readonly targetDays: Readonly<Record<IncidentSeverity, number>>;
  readonly inactivityDays: number;
}

export const SLA_STATES = [
  'not_started',
  'on_track',
  'warning',
  'breached',
  'met',
  'missed',
] as const;
export type SlaState = (typeof SLA_STATES)[number];

/** Statuses a case is watched in: a draft has no SLA and `closed` and `cancelled` accept no notice. */
export const WATCHED_STATUSES: readonly IncidentStatus[] = [
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'reopened',
];
export const isWatched = (status: IncidentStatus): boolean => WATCHED_STATUSES.includes(status);
