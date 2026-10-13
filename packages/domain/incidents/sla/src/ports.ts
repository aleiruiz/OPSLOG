import type { SlaSettings } from './catalog.js';
import type { Viewer } from './recipients.js';
import type { CycleRow, DeliveryKey, DeliveryRow, NewAlert, SlaAlert } from './types.js';
import type { AlertKind } from './catalog.js';

export interface AlertFilter {
  readonly kind?: AlertKind;
  readonly incidentId?: string;
}
export interface AlertWindow {
  readonly limit: 25 | 50 | 100;
  readonly offset: number;
}

export interface SlaScanJob {
  readonly tenantId: string;
  /** Opaque and unique per job: it names the outbox event, so a repeated call is not a second job. */
  readonly jobId: string;
  readonly incidentId?: string;
  readonly at: string;
}

export type ClaimResult =
  | { readonly result: 'claimed'; readonly attempt: number }
  /** Another worker holds the row right now: the caller must try again later. */
  | { readonly result: 'busy' }
  /** The row is final (`sent`, `skipped` or `failed`): nothing to do. */
  | { readonly result: 'done' };

/** How an attempt ended: sent, or failed with the instant of the next try (null: attempts exhausted). */
export type Settlement =
  | { readonly status: 'sent' }
  | { readonly status: 'retry'; readonly nextAttemptAt: string }
  | { readonly status: 'failed' };

/**
 * Persistence of the SLA: the target of each cycle, the notices and the deliveries of each notice.
 * Every method names the tenant. A notice and its outbox event are written together or not at all.
 */
export interface IncidentSlaStore {
  /** Queues an `incident.sla.scan` job in the tenant's outbox (one case, or all when no id is given). */
  enqueueScan(job: SlaScanJob): Promise<void>;
  cycles(tenantId: string, incidentIds: readonly string[]): Promise<readonly CycleRow[]>;
  /** Writes the cycle unless it exists (two workers may open it at once). */
  openCycle(row: CycleRow): Promise<void>;
  /** Moves the target of a cycle while it is still at `expectedTargetVersion`; false when it moved. */
  retarget(row: CycleRow, expectedTargetVersion: number): Promise<boolean>;
  /** `incidentId|cycle|kind|dedupeRef` of the notices that exist, so a scan skips them. */
  alertKeys(tenantId: string, incidentIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** The notice and its `incident.sla_alert` event in one transaction; null when it already existed. */
  createAlert(alert: NewAlert): Promise<SlaAlert | null>;
  alert(tenantId: string, alertId: string): Promise<SlaAlert | null>;
  /** The notices the viewer may see, newest first. */
  listAlerts(
    tenantId: string,
    viewer: Viewer,
    filter: AlertFilter,
    window: AlertWindow,
  ): Promise<{ readonly rows: readonly SlaAlert[]; readonly total: number }>;
  /** Takes the row of the notice and recipient for one attempt, creating it as `pending` first. */
  claimDelivery(key: DeliveryKey, now: string, leaseMs: number): Promise<ClaimResult>;
  settleDelivery(key: DeliveryKey, attempt: number, settlement: Settlement): Promise<void>;
  /**
   * Final `skipped` for a recipient that must not get the message; a `sent` or `failed` row stays.
   * A pending row whose lease is live (another worker is sending) is left alone. `false`: the row is
   * still pending, so the recipient still awaits a settlement.
   */
  skipDelivery(key: DeliveryKey, now: string): Promise<boolean>;
  /** Last outbox try: a still-pending row becomes `failed`, so none stays pending for good. */
  abandonDelivery(key: DeliveryKey): Promise<void>;
  deliveries(tenantId: string, alertId: string): Promise<readonly DeliveryRow[]>;
}

/** The SLA parameters of the company, read when the job runs. */
export interface SlaSettingsReader {
  settings(tenantId: string): Promise<SlaSettings>;
}

/** What the directory knows of a member now. `null`: not an active member of the tenant. */
export interface MemberProfile {
  readonly permissions: readonly string[];
  /** The member has (or had) a mechanic record: no access to incidents in M4 (D9, fail closed). */
  readonly mechanicLinked: boolean;
}
export interface AlertMembers {
  /** `actorId` is `user-<subject>`. */
  profile(tenantId: string, actorId: string): Promise<MemberProfile | null>;
  /** Active members (as `user-<subject>`) who hold the permission now. */
  holders(
    tenantId: string,
    permission: 'incidents:edit' | 'incidents:approve',
  ): Promise<readonly string[]>;
}

/** Where a member's address lives. It is read at send time and goes nowhere but the mail port. */
export interface AlertAddresses {
  addressOf(tenantId: string, actorId: string): Promise<string | null>;
}

export interface AlertMessage {
  readonly tenantId: string;
  readonly alertId: string;
  readonly recipientId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}
/** The mail port (ADR-0014). A real adapter arrives with AWS; elsewhere a sink records the message. */
export interface IncidentAlertMailer {
  send(message: AlertMessage): Promise<void>;
}
