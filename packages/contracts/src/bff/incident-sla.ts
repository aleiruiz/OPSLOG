import type { ISODateTime } from '../index.js';
import type { BffIncidentSeverity } from './incidents.js';
import type { BffRouteDefinition } from './shared.js';

/** Notices of the incident SLA (INC-SLA). The text a screen shows for each is its own (Spanish) label. */
export const BFF_INCIDENT_ALERT_KINDS = [
  'assigned',
  'sla_warning',
  'sla_breach',
  'unassigned',
  'unassigned_escalation',
  'inactive',
  'inactive_escalation',
] as const;
export type BffIncidentAlertKind = (typeof BFF_INCIDENT_ALERT_KINDS)[number];
export const BFF_INCIDENT_ALERT_PAGE_SIZES = [25, 50, 100] as const;

export const BFF_INCIDENT_SLA_STATES = [
  'not_started',
  'on_track',
  'warning',
  'breached',
  'met',
  'missed',
] as const;
export type BffIncidentSlaState = (typeof BFF_INCIDENT_SLA_STATES)[number];

/** A cycle that ended before the current one. */
export interface BffIncidentSlaPreviousCycle {
  readonly cycle: number;
  readonly startedAt: ISODateTime;
  readonly resolvedAt: ISODateTime | null;
  /** Resolved on or before the target of that cycle. */
  readonly met: boolean;
}
/**
 * The SLA of a case, calculated on every read and never stored as such. Optional on the case: absent
 * when the deployment does not provide it or the case has none (a cancelled case that never resolved).
 */
export interface BffIncidentSla {
  readonly cycle: number;
  readonly state: BffIncidentSlaState;
  /** `null` while the case is a draft (`not_started`). */
  readonly startedAt: ISODateTime | null;
  readonly deadline: ISODateTime | null;
  readonly targetDays: number | null;
  /** Whole percent of the target already used; it freezes when the cycle is resolved. */
  readonly elapsedPercent: number;
  readonly resolvedAt: ISODateTime | null;
  readonly previousCycles: readonly BffIncidentSlaPreviousCycle[];
}

/** A notice: folio, kind, severity and the way to the case. No amount, no name, no free text. */
export interface BffIncidentAlert {
  readonly id: string;
  readonly incidentId: string;
  readonly folio: string;
  readonly kind: BffIncidentAlertKind;
  readonly cycle: number;
  readonly createdAt: ISODateTime;
  readonly severity: BffIncidentSeverity | null;
  readonly deadline: ISODateTime | null;
}
export interface BffIncidentAlertPage {
  readonly items: readonly BffIncidentAlert[];
  readonly total: number;
}
export interface BffIncidentAlertsQuery {
  readonly kind?: BffIncidentAlertKind;
  readonly incidentId?: string;
  readonly limit?: 25 | 50 | 100;
  readonly offset?: number;
}

export interface IncidentSlaRouteTypes {
  'incidents.alerts.list': { query?: BffIncidentAlertsQuery; response: BffIncidentAlertPage };
}

export const INCIDENT_SLA_ROUTES = {
  // Declared before `:incidentId` so the literal segment is never read as an id.
  'incidents.alerts.list': {
    method: 'GET',
    path: ['api', 'v1', 'incidents', 'alerts'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof IncidentSlaRouteTypes, BffRouteDefinition>;
