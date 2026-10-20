import type { Handler } from '../../base/src/index.js';
import type { WorkerJob } from './jobs.js';

/** The two jobs of the exports module: producing queued files and removing expired ones. */
export const EXPORTS_RUN_JOB = 'exports.run';
export const EXPORTS_PURGE_JOB = 'exports.purge';
/** The purge looks for expired files at most this often: files live for days. */
export const EXPORTS_PURGE_INTERVAL_MS = 10 * 60_000;

export interface ExportsJobDeps {
  readonly service: {
    runDue(tenantId: string): Promise<number>;
    purge(tenantId: string): Promise<number>;
  };
  /** Ids of the companies whose jobs may run: active ones only. */
  readonly activeTenantIds: () => readonly string[];
  readonly clock: () => number;
}

/**
 * Registered on the worker loop. A company that fails does not stop the others; its failure is
 * rethrown once every company has been tried, so the loop reports the job by name.
 */
export function exportsJobs(deps: ExportsJobDeps): readonly WorkerJob[] {
  const everyTenant = async (work: (tenantId: string) => Promise<number>): Promise<number> => {
    let total = 0;
    let failure: unknown;
    for (const tenantId of deps.activeTenantIds()) {
      try {
        total += await work(tenantId);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return total;
  };
  let lastPurge = Number.NEGATIVE_INFINITY;
  return [
    { name: EXPORTS_RUN_JOB, run: () => everyTenant((tenantId) => deps.service.runDue(tenantId)) },
    {
      name: EXPORTS_PURGE_JOB,
      run: async () => {
        const now = deps.clock();
        if (now - lastPurge < EXPORTS_PURGE_INTERVAL_MS) return 0;
        lastPurge = now;
        return everyTenant((tenantId) => deps.service.purge(tenantId));
      },
    },
  ];
}

export const EXPORT_COMPLETED_EVENT = 'export.completed';
export const EXPORT_FAILED_EVENT = 'export.failed';

/**
 * `export.completed` and `export.failed` are published for the notification module (MVP-NOTIFY),
 * which replaces these handlers. Until then they acknowledge the event: an event without a handler
 * would be retried and dead-lettered.
 */
export function registerExportEventHandlers(worker: {
  register(type: string, handler: Handler): void;
}): void {
  const acknowledge: Handler = async () => undefined;
  worker.register(EXPORT_COMPLETED_EVENT, acknowledge);
  worker.register(EXPORT_FAILED_EVENT, acknowledge);
}
