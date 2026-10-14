import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_ALERT_SOURCES = [
  'vehicle_document',
  'insurance_policy',
  'employee_license',
] as const;
export type BffAlertSource = (typeof BFF_ALERT_SOURCES)[number];

/** `expiring`: from the window start to the last valid day (inclusive); `expired`: after it. */
export const BFF_ALERT_SEVERITIES = ['expiring', 'expired'] as const;
export type BffAlertSeverity = (typeof BFF_ALERT_SEVERITIES)[number];

/** Roles a company can address its alerts to. */
export const BFF_ALERT_RECIPIENT_ROLES = [
  'admin',
  'editor',
  'viewer',
  'auditor',
  'pii_reader',
] as const;
export type BffAlertRecipientRole = (typeof BFF_ALERT_RECIPIENT_ROLES)[number];

/**
 * An expiring or expired vehicle document, insurance policy or driver's license, derived on every
 * read from the company's data as of the UTC date of the server (`asOf` of the page). Never stored,
 * queued or sent. A license alert exposes only the internal employee id, fixed type code and expiry
 * date; no name, license number or encrypted field. The company is implicit.
 */
export interface BffAlert {
  /** Dedupe key: source, subject and expiry date (a renewal changes the date: a new cycle). */
  readonly key: string;
  readonly source: BffAlertSource;
  /** Id of the source record; for a license alert this is the employee id. */
  readonly subjectId: string;
  /** Linked vehicle for vehicle records; null for a driver's license. */
  readonly vehicleId: string | null;
  /** Document type code, or the coverage type of the policy. */
  readonly typeCode: string;
  /** `YYYY-MM-DD`: the last valid day, inclusive. */
  readonly dueOn: string;
  /** Whole days to `dueOn` (0 on the last valid day, negative once expired). */
  readonly daysToExpiry: number;
  readonly severity: BffAlertSeverity;
}

export interface BffAlertsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly source?: BffAlertSource;
  readonly severity?: BffAlertSeverity;
  readonly vehicleId?: string;
}

/** Soonest due date first. `windowDays` is the company's expiry window. */
export interface BffAlertPage extends Page<BffAlert> {
  readonly asOf: string;
  readonly windowDays: number;
}

export type BffMaintenanceEvidenceRequirement = 'none' | 'evidence' | 'evidence_invoice';
export const BFF_MAINTENANCE_EVIDENCE_REQUIREMENTS: readonly BffMaintenanceEvidenceRequirement[] = [
  'none',
  'evidence',
  'evidence_invoice',
];
/** Photo evidence that reporting an incident requires: a clean photo or a justification, or a clean photo only. */
export type BffIncidentReportPhoto = 'photo_or_justification' | 'photo_required';
export const BFF_INCIDENT_REPORT_PHOTO_MODES: readonly BffIncidentReportPhoto[] = [
  'photo_or_justification',
  'photo_required',
];
/** Exact amount in the currency's minor unit (digits) with its ISO 4217 code. */
export interface BffCloseCostThreshold {
  readonly amountMinor: string;
  readonly currency: string;
}

/** Calendar days of the incident SLA per severity (D17); each a whole number from 1 to 365. */
export interface BffIncidentSlaDays {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

/**
 * The company's alert settings. `version` is the concurrency token: 0 while the company has never
 * saved (the values are then the defaults: 30 days, administrators and editors).
 */
export interface BffAlertSettings {
  readonly expiryWindowDays: number;
  readonly recipientRoles: readonly BffAlertRecipientRole[];
  /** Evidence/invoice that completing and closing a maintenance order requires (default `none`). */
  readonly maintenanceEvidence: BffMaintenanceEvidenceRequirement;
  /**
   * D20: when set, a closure whose company-borne cost exceeds it needs a prior supervisor approval.
   * `null` (default): none is asked. Left out for a caller without `incidents:view_costs`; a write
   * that leaves it out keeps the stored value.
   */
  readonly closeCostThreshold?: BffCloseCostThreshold | null;
  /** IANA zone of the company; calendar days are computed in it (default `UTC`). */
  readonly timeZone: string;
  /** Photo evidence reporting an incident requires (default `photo_or_justification`). The server always sends it. */
  readonly incidentReportPhoto?: BffIncidentReportPhoto;
  /** Incident SLA target per severity (default 7/15/30/45). The server always sends it. */
  readonly incidentSlaDays?: BffIncidentSlaDays;
  /** Days without movement before a case is flagged, escalated at twice that (1 to 60, default 5). The server always sends it. */
  readonly incidentInactivityDays?: number;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: ISODateTime | null;
}

/** A full replacement: a window of 1 to 30 days and one to five distinct roles. Needs `manage_config`. */
export interface BffAlertSettingsInput {
  readonly version: number;
  readonly expiryWindowDays: number;
  readonly recipientRoles: readonly BffAlertRecipientRole[];
  /** A field that is left out keeps its stored value; `closeCostThreshold: null` clears the threshold. */
  readonly maintenanceEvidence?: BffMaintenanceEvidenceRequirement;
  readonly closeCostThreshold?: BffCloseCostThreshold | null;
  readonly timeZone?: string;
  readonly incidentReportPhoto?: BffIncidentReportPhoto;
  /** All four severities when sent; a bad or partial object is a 400. Left out keeps the stored values. */
  readonly incidentSlaDays?: BffIncidentSlaDays;
  readonly incidentInactivityDays?: number;
}

/** Request and response types of the alerts routes. */
export interface AlertsRouteTypes {
  'alerts.list': { query?: BffAlertsQuery; response: BffAlertPage };
  'alerts.settings.get': { response: BffAlertSettings };
  'alerts.settings.update': { body: BffAlertSettingsInput; response: BffAlertSettings };
}

export const ALERTS_ROUTES = {
  'alerts.list': { method: 'GET', path: ['api', 'alerts'], kind: 'session', status: 200 },
  'alerts.settings.get': {
    method: 'GET',
    path: ['api', 'alerts', 'settings'],
    kind: 'session',
    status: 200,
  },
  'alerts.settings.update': {
    method: 'PUT',
    path: ['api', 'alerts', 'settings'],
    kind: 'session-csrf',
    status: 200,
  },
} as const satisfies Record<keyof AlertsRouteTypes, BffRouteDefinition>;
