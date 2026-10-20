import { SafeWebhookClient } from '../../../platform/webhooks/src/index.js';
import { BATCH, DELIVERIES_PER_MINUTE, LEASE_MS, TICK_BUDGET_MS } from './catalog.js';
import type { EndpointNotifier, WebhookStore } from './ports.js';
import { outcomeOf } from './retry.js';
import type { SecretVault } from './secrets.js';

export interface DispatchDeps {
  readonly store: WebhookStore;
  readonly vault: SecretVault;
  readonly client: Pick<SafeWebhookClient, 'send'>;
  readonly notifier: EndpointNotifier;
  readonly now: () => Date;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
  readonly batch?: number;
  readonly perMinute?: number;
  /** Wall-clock budget of one company's tick, in milliseconds. */
  readonly tickBudgetMs?: number;
  /** Monotonic milliseconds, for the tick budget (not the business clock). */
  readonly clock?: () => number;
}

export interface DispatchSummary {
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

/**
 * Sends the deliveries that are due. At most `perMinute` per company start in any minute (the rest
 * waits, nothing is lost). Before each send the lease is renewed, and the outcome is written only
 * under that same lease: a worker that lost its delivery to another one writes nothing.
 */
export class WebhookDispatcher {
  private readonly random: () => number;
  private readonly clock: () => number;
  public constructor(private readonly deps: DispatchDeps) {
    this.random = deps.random ?? Math.random;
    this.clock = deps.clock ?? Date.now;
  }

  public async runDue(tenantId: string): Promise<DispatchSummary> {
    const { store, vault, client, notifier } = this.deps;
    const summary = { delivered: 0, retried: 0, deadLettered: 0 };
    const now = this.deps.now();
    const used = await store.attemptsSince(tenantId, new Date(now.getTime() - 60_000));
    const room = (this.deps.perMinute ?? DELIVERIES_PER_MINUTE) - used;
    if (room <= 0) return summary;
    const work = await store.claimDue(
      tenantId,
      now,
      LEASE_MS,
      Math.min(this.deps.batch ?? BATCH, room),
    );
    const started0 = this.clock();
    for (const { delivery, endpoint } of work) {
      // A tenant's tick is bounded in wall-clock time so it cannot hold the shared tick; what is
      // left keeps its lease and is taken again once that lapses.
      if (this.clock() - started0 >= (this.deps.tickBudgetMs ?? TICK_BUDGET_MS)) break;
      const lease = await store.renew(
        tenantId,
        delivery.id,
        delivery.leaseUntil,
        this.deps.now(),
        LEASE_MS,
      );
      if (lease === null) continue;
      const started = this.deps.now();
      const result = await client.send({
        url: endpoint.url,
        eventId: delivery.eventId,
        body: Buffer.from(delivery.body),
        secrets: await vault.signing(endpoint, started),
        timestamp: Math.floor(started.getTime() / 1000),
      });
      const at = this.deps.now();
      const outcome = outcomeOf(delivery, result, at, this.random);
      if (!(await store.settle(tenantId, delivery.id, outcome, at.toISOString(), lease))) continue;
      if (outcome.kind === 'delivered') summary.delivered += 1;
      else if (outcome.kind === 'retry') summary.retried += 1;
      else summary.deadLettered += 1;
      const noted = await store.noteResult(
        tenantId,
        endpoint.id,
        outcome.kind === 'delivered',
        at.toISOString(),
      );
      if (noted.disabled) await notifier.disabled(tenantId, endpoint.id);
    }
    return summary;
  }
}
