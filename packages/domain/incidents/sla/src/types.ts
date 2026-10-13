import type { IncidentSeverity } from '../../cases/src/index.js';
import type { AlertKind, SlaState } from './catalog.js';

/** The target of one cycle, fixed when the cycle is first seen and revised when the severity changes. */
export interface CycleRow {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly cycle: number;
  /** UTC instant: `reportedAt` for cycle 1, the instant of the `reopen` for the rest. */
  readonly startedAt: string;
  readonly severity: IncidentSeverity;
  readonly targetDays: number;
  /** Starts at 1 and grows with every retarget; part of the dedupe key of the SLA notices. */
  readonly targetVersion: number;
}

/** A cycle as read now: stored when the scan has seen it, otherwise derived from the case. */
export interface CycleFacts extends Omit<CycleRow, 'tenantId' | 'incidentId'> {
  readonly resolvedAt: string | null;
  /** What the scan still has to write for this cycle. */
  readonly pending: 'open' | 'retarget' | null;
}

/** A notice as the scan decides it, before it has an id. No recipient, no name, no amount. */
export interface NewAlert {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly folio: string;
  readonly cycle: number;
  readonly kind: AlertKind;
  /** Part of the unique key: the target version, or the reference instant the notice was judged on. */
  readonly dedupeRef: string;
  readonly severity: IncidentSeverity | null;
  readonly deadline: string | null;
  /** The responsible an `assigned` notice is for; null for the rest. */
  readonly subjectId: string | null;
  readonly createdAt: string;
}
export interface SlaAlert extends NewAlert {
  readonly id: string;
}

export const DELIVERY_CHANNEL = 'email';
export type DeliveryChannel = typeof DELIVERY_CHANNEL;
export const DELIVERY_STATUSES = ['pending', 'sent', 'skipped', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export interface DeliveryKey {
  readonly tenantId: string;
  readonly alertId: string;
  readonly recipientId: string;
  readonly channel: DeliveryChannel;
}
/** One row per notice, recipient and channel. It keeps no address and no content. */
export interface DeliveryRow extends DeliveryKey {
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
}

/** What the screens get of a cycle that ended before the current one. */
export interface SlaPreviousCycle {
  readonly cycle: number;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly met: boolean;
}
/** The calculated SLA of a case, read on demand and never stored as such. */
export interface IncidentSlaView {
  readonly cycle: number;
  readonly state: SlaState;
  readonly startedAt: string | null;
  readonly deadline: string | null;
  readonly targetDays: number | null;
  /** Whole percent of the target already used; it freezes when the cycle is resolved. */
  readonly elapsedPercent: number;
  readonly resolvedAt: string | null;
  readonly previousCycles: readonly SlaPreviousCycle[];
}

/** A notice as the list shows it. */
export interface AlertItem {
  readonly id: string;
  readonly incidentId: string;
  readonly folio: string;
  readonly kind: AlertKind;
  readonly cycle: number;
  readonly createdAt: string;
  readonly severity: IncidentSeverity | null;
  readonly deadline: string | null;
}
export interface AlertPage {
  readonly items: readonly AlertItem[];
  readonly total: number;
}
