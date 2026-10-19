import { backoffMs } from '../../../platform/outbox/src/index.js';
import { MailError, type MailPort } from '../../../platform/mail/src/index.js';
import { meets } from './access.js';
import { isQuiet, notBefore } from './calendar.js';
import { KINDS } from './catalog.js';
import type { EntityVisibility, NotificationStore, RecipientDirectory } from './ports.js';
import { defaultRule } from './rules.js';
import { composeEmail } from './templates.js';
import { LEASE_MS, MAX_ATTEMPTS, type DeliveryOutcome, type DeliveryWork } from './types.js';

export interface DispatchDeps {
  readonly store: NotificationStore;
  readonly directory: RecipientDirectory;
  readonly visibility: EntityVisibility;
  readonly mail: MailPort;
  readonly now: () => Date;
  /** Base of the links in the e-mail (the web host). Relative paths until it is configured. */
  readonly baseUrl?: string | undefined;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
  readonly maxAttempts?: number;
  readonly batch?: number;
}

export interface DispatchSummary {
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly deferred: number;
}

const BATCH = 50;

/**
 * Sends the e-mail of the notices that are due. A send is asynchronous and never part of the
 * command that caused it: a failing provider only moves the delivery towards `failed`, which the
 * administrator can see, while the in-app notice stays. Before each send the person, their right
 * and the company's rule are read again, so a revoked recipient receives nothing.
 */
export class NotificationDispatcher {
  private readonly random: () => number;
  private readonly maxAttempts: number;
  public constructor(private readonly deps: DispatchDeps) {
    this.random = deps.random ?? Math.random;
    this.maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  }

  public async runDue(tenantId: string): Promise<DispatchSummary> {
    const { store } = this.deps;
    const summary = { sent: 0, retried: 0, failed: 0, suppressed: 0, deferred: 0 };
    const work = await store.claimDue(
      tenantId,
      this.deps.now(),
      LEASE_MS,
      this.deps.batch ?? BATCH,
    );
    for (const item of work) {
      const outcome = await this.decide(item);
      const settled = await store.settle(
        tenantId,
        item.notification.id,
        item.delivery.channel,
        outcome,
        this.deps.now().toISOString(),
      );
      if (!settled) continue;
      if (outcome.status === 'sent') summary.sent += 1;
      else if (outcome.status === 'retry') summary.retried += 1;
      else summary[outcome.status] += 1;
    }
    return summary;
  }

  private async decide({ delivery, notification }: DeliveryWork): Promise<DeliveryOutcome> {
    const { directory, visibility, store } = this.deps;
    const tenantId = notification.tenantId;
    const spec = KINDS[notification.eventKind];
    const access = await directory.access(tenantId, notification.recipientId);
    // Read again now: membership and right as they are, not as they were when the notice was written.
    if (!access || !meets(access, spec.requires))
      return { status: 'suppressed', reason: 'revoked' };
    if (
      (notification.entityType === 'vehicle' || notification.entityType === 'incident') &&
      !(await visibility.visible(tenantId, access, notification.entityType, notification.entityId))
    )
      return { status: 'suppressed', reason: 'revoked' };
    const rule = (await store.rule(tenantId)) ?? defaultRule();
    if (!spec.email || !rule.emailKinds.includes(notification.eventKind))
      return { status: 'suppressed', reason: 'not_allowed' };
    const company = await directory.company(tenantId);
    const now = this.deps.now();
    if (rule.quietHours && isQuiet(now, company.timeZone))
      return {
        status: 'deferred',
        nextAttemptAt: notBefore(now, company.timeZone, true).toISOString(),
      };
    const to = await directory.address(tenantId, notification.recipientId);
    if (to === null) return { status: 'suppressed', reason: 'no_address' };
    const email = composeEmail(notification, company.name, { baseUrl: this.deps.baseUrl });
    try {
      await this.deps.mail.send({
        companyId: tenantId,
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        template: email.template,
        idempotencyKey: `${notification.id}:email`,
      });
    } catch (error) {
      // Only a code is kept: a provider's message can hold an address.
      const code = error instanceof MailError ? error.code : 'unknown';
      const attempt = delivery.attempts + 1;
      if (attempt >= this.maxAttempts) return { status: 'failed', error: code };
      return {
        status: 'retry',
        error: code,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempt, this.random)).toISOString(),
      };
    }
    return { status: 'sent' };
  }
}
