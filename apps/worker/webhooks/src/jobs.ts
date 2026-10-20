import {
  RETENTION_MS,
  type EligibilityTracker,
  type WebhookDispatcher,
  type WebhookStore,
} from '../../../../packages/domain/webhooks/src/index.js';

/** The shape the worker loop runs (`apps/worker/composition` `WorkerJob`). */
export interface WorkerJob {
  readonly name: string;
  run(): Promise<unknown>;
}

export const WEBHOOKS_DISPATCH_JOB = 'webhooks.dispatch';
export const WEBHOOKS_ELIGIBILITY_JOB = 'webhooks.eligibility';
export const WEBHOOKS_PURGE_JOB = 'webhooks.purge';
/** The eligibility scan and the purge are daily matters: they run at most this often. */
export const WEBHOOKS_DAILY_INTERVAL_MS = 60 * 60_000;

export interface WebhookJobDeps {
  readonly dispatcher: Pick<WebhookDispatcher, 'runDue'>;
  readonly tracker: Pick<EligibilityTracker, 'scan'>;
  readonly store: Pick<WebhookStore, 'purge'>;
  /** Ids of the companies whose jobs may run: active ones only. */
  readonly activeTenantIds: () => readonly string[];
  readonly clock: () => number;
}

/**
 * Registered on the worker loop. A company that fails does not stop the others; its failure is
 * rethrown once every company has been tried, so the loop reports the job by name.
 */
export function webhookJobs(deps: WebhookJobDeps): readonly WorkerJob[] {
  const everyTenant = async (work: (tenantId: string) => Promise<number>): Promise<number> => {
    let total = 0;
    let failure: unknown;
    let failed = false;
    for (const tenantId of deps.activeTenantIds()) {
      try {
        total += await work(tenantId);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
    return total;
  };
  const throttled = (job: (tenantId: string) => Promise<number>) => {
    let last = Number.NEGATIVE_INFINITY;
    return async (): Promise<number> => {
      const now = deps.clock();
      if (now - last < WEBHOOKS_DAILY_INTERVAL_MS) return 0;
      last = now;
      return everyTenant(job);
    };
  };
  return [
    {
      name: WEBHOOKS_DISPATCH_JOB,
      run: () =>
        everyTenant(async (tenantId) => {
          const summary = await deps.dispatcher.runDue(tenantId);
          return summary.delivered + summary.retried + summary.deadLettered;
        }),
    },
    {
      name: WEBHOOKS_ELIGIBILITY_JOB,
      run: throttled((tenantId) => deps.tracker.scan(tenantId)),
    },
    {
      name: WEBHOOKS_PURGE_JOB,
      run: throttled((tenantId) =>
        deps.store.purge(tenantId, new Date(deps.clock() - RETENTION_MS)),
      ),
    },
  ];
}
