import {
  Worker,
  drain,
  type ActorPermissionCheck,
  type TenantDirectory,
} from '../../base/src/index.js';
import type { AuditStore } from '../../../../packages/platform/audit/src/index.js';
import type { OutboxStore } from '../../../../packages/platform/outbox/src/index.js';
import type {
  FilePipeline,
  ScanJob,
  ScanQueue,
  ScanRunSummary,
} from '../../../../packages/platform/files/src/index.js';

export type { ActorPermissionCheck, TenantDirectory };
export * from './periodic.js';
export * from './jobs.js';
export * from './exports-jobs.js';
import { JobRegistry, type WorkerJob } from './jobs.js';
import { PeriodicScheduler, type PeriodicTenantJob, type PeriodicTimers } from './periodic.js';

const MAX_REFILL_ROUNDS = 1000;

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
    const runnable: ScanJob[] = [];
    const held = new Set<string>();
    // Keep refilling after deferring inactive-tenant jobs, so a backlog of them cannot starve
    // active tenants. Termination: each round either fills the batch, finds no due job, repeats
    // an already deferred job, or hits the round cap.
    for (let round = 0; runnable.length < limit && round < MAX_REFILL_ROUNDS; round += 1) {
      const claimed = await this.inner.claimDue(now, leaseMs, limit - runnable.length);
      if (claimed.length === 0) break;
      let repeated = false;
      for (const job of claimed) {
        if (this.tenants.status(job.tenantId) === 'active') {
          runnable.push(job);
          continue;
        }
        const key = `${job.tenantId.length}:${job.tenantId}${job.fileId}`;
        if (held.has(key)) repeated = true;
        held.add(key);
        this.heldBack += 1;
        await this.inner.defer(job.tenantId, job.fileId, now + this.holdMs);
      }
      if (repeated) break;
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
  /** Current-permission check for the user that enqueued a job. */
  readonly actors: ActorPermissionCheck;
  readonly audit: AuditStore;
  /** Tenant-aware batch relay supplied by the persistence composition. */
  readonly auditRelay?: { runBatch(max?: number): Promise<number> };
  readonly pipeline: FilePipeline;
  readonly clock: () => number;
  /** Opaque system actor reference, `worker-<slug>`. */
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  /** Per-tenant jobs the host runs on a timer (`runtime.periodic`); needs `tenantIds`. */
  readonly periodic?: readonly PeriodicTenantJob[];
  readonly tenantIds?: () => readonly string[];
  readonly timers?: PeriodicTimers;
  /** Extra jobs the tick runs after the built-in ones (outbox, scans, audit relay). */
  readonly jobs?: readonly WorkerJob[];
}

export interface WorkerRuntime {
  readonly worker: Worker;
  /** Processes due outbox events (tenant-checked, audited). */
  drainOutbox(max?: number): Promise<number>;
  /** Processes due scan jobs of active tenants. */
  runScans(): Promise<ScanRunSummary>;
  /** Relays tenant-local audit rows to each tenant's date-partitioned projection. */
  runAuditRelay(max?: number): Promise<number>;
  /** The local periodic trigger of the registered per-tenant jobs; `start()` is the host's call. */
  readonly periodic: PeriodicScheduler;
  /** What a tick runs, in order: the built-ins first, then every registered job. */
  readonly jobs: JobRegistry;
  /** Adds a job to the tick (names are unique). */
  registerJob(job: WorkerJob): void;
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
    deps.actors,
  );
  const tenantIds = deps.tenantIds ?? (() => []);
  const jobs = new JobRegistry();
  const runtime: WorkerRuntime = {
    worker,
    jobs,
    registerJob: (job) => jobs.register(job),
    periodic: new PeriodicScheduler(
      { status: (id) => deps.tenants.status(id), ids: tenantIds },
      deps.periodic ?? [],
      deps.timers,
    ),
    drainOutbox: (max) => drain(worker, max),
    runScans: () => deps.pipeline.processScans(),
    runAuditRelay: (max) => {
      if (!deps.auditRelay) throw new Error('audit relay is not configured');
      return deps.auditRelay.runBatch(max);
    },
  };
  jobs.register({ name: 'outbox', run: () => runtime.drainOutbox() });
  jobs.register({ name: 'scans', run: () => runtime.runScans() });
  jobs.register({ name: 'audit-relay', run: () => runtime.runAuditRelay() });
  for (const job of deps.jobs ?? []) jobs.register(job);
  return runtime;
}
