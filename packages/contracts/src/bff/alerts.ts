import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_ALERT_SOURCES = ['vehicle_document', 'insurance_policy'] as const;
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
 * An expiring or expired vehicle document or insurance policy, derived on every read from the
 * company's data as of the UTC date of the server (`asOf` of the page). Never stored, queued or
 * sent. Ids and dates only: no title, number or person. The company is implicit.
 */
export interface BffAlert {
  /** Dedupe key: source, subject and expiry date (a renewal changes the date: a new cycle). */
  readonly key: string;
  readonly source: BffAlertSource;
  /** Id of the document or of the policy. */
  readonly subjectId: string;
  readonly vehicleId: string;
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

/**
 * The company's alert settings. `version` is the concurrency token: 0 while the company has never
 * saved (the values are then the defaults: 30 days, administrators and editors).
 */
export interface BffAlertSettings {
  readonly expiryWindowDays: number;
  readonly recipientRoles: readonly BffAlertRecipientRole[];
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: ISODateTime | null;
}

/** A full replacement: a window of 1 to 30 days and one to five distinct roles. Needs `manage_config`. */
export interface BffAlertSettingsInput {
  readonly version: number;
  readonly expiryWindowDays: number;
  readonly recipientRoles: readonly BffAlertRecipientRole[];
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
