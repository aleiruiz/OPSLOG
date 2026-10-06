import { Worker, drain, type TenantDirectory } from '../../base/src/index.js';
import type { AuditStore } from '../../../../packages/platform/audit/src/index.js';
import type { OutboxStore } from '../../../../packages/platform/outbox/src/index.js';
import type {
  FilePipeline,
  ScanJob,
  ScanQueue,
  ScanRunSummary,
} from '../../../../packages/platform/files/src/index.js';

export type { TenantDirectory };

/**
 * Scan queue decorator that never hands a job of a missing or non-active tenant to the pipeline.
 * Such jobs are deferred (not completed, not dropped), so the file stays `pending_scan` and
 * undownloadable until the tenant is active again.
 */
export class TenantAwareScanQueue implements ScanQueue {
  /** Jobs held back because their tenant was not active (operational metric). */
  public heldBack = 0;
  public constructor(
    private readonly inner: ScanQueue,
    private readonly tenants: TenantDirectory,
    private readonly holdMs = 5 * 60_000,
  ) {
    if (!Number.isInteger(holdMs) || holdMs <= 0)
      throw new Error('holdMs must be a positive integer');
  }
  public enqueue(tenantId: string, fileId: string, at: number): Promise<void> {
    return this.inner.enqueue(tenantId, fileId, at);
  }
  public async claimDue(now: number, leaseMs: number, limit: number): Promise<readonly ScanJob[]> {
    const claimed = await this.inner.claimDue(now, leaseMs, limit);
    const runnable: ScanJob[] = [];
    for (const job of claimed) {
      if (this.tenants.status(job.tenantId) === 'active') runnable.push(job);
      else {
        this.heldBack += 1;
        await this.inner.defer(job.tenantId, job.fileId, now + this.holdMs);
      }
    }
    return runnable;
  }
  public complete(tenantId: string, fileId: string): Promise<void> {
    return this.inner.complete(tenantId, fileId);
  }
  public defer(tenantId: string, fileId: string, nextAttemptAt: number): Promise<void> {
    return this.inner.defer(tenantId, fileId, nextAttemptAt);
  }
}

export interface WorkerRuntimeDeps {
  readonly outbox: OutboxStore;
  readonly tenants: TenantDirectory;
  readonly audit: AuditStore;
  readonly pipeline: FilePipeline;
  readonly clock: () => number;
  /** Opaque system actor reference, `worker-<slug>`. */
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
}

export interface WorkerRuntime {
  readonly worker: Worker;
  /** Processes due outbox events (tenant-checked, audited). */
  drainOutbox(max?: number): Promise<number>;
  /** Processes due scan jobs of active tenants. */
  runScans(): Promise<ScanRunSummary>;
}

/**
 * Worker composition root: one outbox worker plus the scan runner, sharing the same tenant
 * directory. Handlers are registered by the caller (`runtime.worker.register`).
 */
export function createWorkerRuntime(deps: WorkerRuntimeDeps): WorkerRuntime {
  const worker = new Worker(
    deps.outbox,
    deps.tenants,
    deps.audit,
    deps.workerId ?? 'worker-platform',
    deps.leaseMs,
    deps.maxAttempts,
    deps.clock,
  );
  return {
    worker,
    drainOutbox: (max) => drain(worker, max),
    runScans: () => deps.pipeline.processScans(),
  };
}
