import {
  TERMINAL_STATUSES,
  canView,
  type Incident,
  type IncidentActor,
  type IncidentStore,
} from '../../cases/src/index.js';
import { backoffMs } from '../../../../platform/outbox/src/index.js';
import { composeMessage } from './mail.js';
import type {
  AlertAddresses,
  AlertMembers,
  IncidentAlertMailer,
  IncidentSlaStore,
} from './ports.js';
import { recipientsOf } from './recipients.js';
import { DELIVERY_CHANNEL, type DeliveryKey, type SlaAlert } from './types.js';
import { parseSlaAlertPayload } from './events.js';

/** SPECS §7: the first try and five retries. */
export const MAX_DELIVERY_ATTEMPTS = 6;
const LEASE_MS = 300_000;

export interface DeliveryOptions {
  readonly now?: () => Date;
  /** The link to the case in the message. Relative until the web host is configured. */
  readonly linkOf?: (incidentId: string) => string;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  /** Jitter source in [0, 1) for the next-attempt estimate. */
  readonly random?: () => number;
}
export interface DeliverySummary {
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  /** Recipients that still need an attempt: the job must run again. */
  readonly pending: number;
}

/** A mail failed or is in flight elsewhere: the outbox retries the event on the SPECS §7 schedule. */
export class DeliveryPendingError extends Error {
  public constructor() {
    super('incident alert delivery pending');
    this.name = 'DeliveryPendingError';
  }
}

const actorOf = (
  id: string,
  profile: { permissions: readonly string[]; mechanicLinked: boolean },
) =>
  ({
    id,
    subject: id.replace(/^user-/, ''),
    permissions: profile.permissions,
    mechanicLinked: profile.mechanicLinked,
  }) satisfies IncidentActor;

/**
 * Sends the e-mail of a notice (ADR-0014): one per recipient, resolved and revalidated now. The row
 * of (notice, recipient, channel) makes it idempotent across retries and workers, keeps no address
 * and no content, and a failure of the port never touches the notice or the case.
 */
export class IncidentAlertDelivery {
  private readonly now: () => Date;
  private readonly linkOf: (incidentId: string) => string;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly random: () => number;
  public constructor(
    private readonly incidents: IncidentStore,
    private readonly store: IncidentSlaStore,
    private readonly members: AlertMembers,
    private readonly addresses: AlertAddresses,
    private readonly mailer: IncidentAlertMailer,
    options: DeliveryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.linkOf = options.linkOf ?? ((id) => `/incidents/${id}`);
    this.maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.random = options.random ?? Math.random;
  }

  /** Handles one `incident.sla_alert`. Throws `DeliveryPendingError` while any recipient awaits a retry, except on the last outbox try (`final`), which settles those rows as failed. */
  public async deliver(
    tenantId: string,
    payload: unknown,
    options: { readonly final?: boolean } = {},
  ): Promise<DeliverySummary> {
    const event = parseSlaAlertPayload(payload);
    const alert = await this.store.alert(tenantId, event.alertId);
    const summary = { sent: 0, skipped: 0, failed: 0, pending: 0 };
    // A payload that does not match its notice names nothing we may send for.
    if (!alert || alert.incidentId !== event.incidentId) return summary;
    const incident = await this.incidents.get(tenantId, alert.incidentId);
    const open = incident !== null && !TERMINAL_STATUSES.includes(incident.status);
    const waiting: DeliveryKey[] = [];
    const candidates = await recipientsOf(alert, incident?.responsibleId ?? null, this.members);
    for (const recipientId of candidates) {
      const key: DeliveryKey = {
        tenantId,
        alertId: alert.id,
        recipientId,
        channel: DELIVERY_CHANNEL,
      };
      let outcome = open ? await this.deliverTo(key, alert, incident) : 'skipped';
      // A row another worker is still sending stays pending: the outbox tries again.
      if (outcome === 'skipped' && !(await this.store.skipDelivery(key, this.now().toISOString())))
        outcome = 'pending';
      if (outcome === 'pending') waiting.push(key);
      if (outcome !== 'done') summary[outcome] += 1;
    }
    if (summary.pending > 0 && options.final) {
      // The outbox event dead-letters after this try: no row may stay pending for good.
      for (const key of waiting) await this.store.abandonDelivery(key);
      return { ...summary, failed: summary.failed + summary.pending, pending: 0 };
    }
    if (summary.pending > 0) throw new DeliveryPendingError();
    return summary;
  }

  private async deliverTo(
    key: DeliveryKey,
    alert: SlaAlert,
    incident: Incident,
  ): Promise<'sent' | 'failed' | 'pending' | 'skipped' | 'done'> {
    // Rights, membership and address are read now, not when the notice was written.
    const profile = await this.members.profile(key.tenantId, key.recipientId);
    if (!profile || !canView(actorOf(key.recipientId, profile))) return 'skipped';
    const to = await this.addresses.addressOf(key.tenantId, key.recipientId);
    if (to === null) return 'skipped';
    const claim = await this.store.claimDelivery(key, this.now().toISOString(), this.leaseMs);
    if (claim.result === 'done') return 'done';
    if (claim.result === 'busy') return 'pending';
    const { subject, body } = composeMessage(alert, this.linkOf(incident.id));
    try {
      await this.mailer.send({
        tenantId: key.tenantId,
        alertId: alert.id,
        recipientId: key.recipientId,
        to,
        subject,
        body,
      });
    } catch {
      // The notice stays; only this recipient's row records the failed attempt.
      if (claim.attempt >= this.maxAttempts) {
        await this.store.settleDelivery(key, claim.attempt, { status: 'failed' });
        return 'failed';
      }
      const nextAttemptAt = new Date(
        this.now().getTime() + backoffMs(claim.attempt, this.random),
      ).toISOString();
      await this.store.settleDelivery(key, claim.attempt, { status: 'retry', nextAttemptAt });
      return 'pending';
    }
    await this.store.settleDelivery(key, claim.attempt, { status: 'sent' });
    return 'sent';
  }
}
