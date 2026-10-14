import type { TenantDirectory } from '../../base/src/index.js';

/** The local periodic trigger of a per-tenant job (the cloud scheduler stays deferred, ADR-0002). */
export interface PeriodicTenantJob {
  /** Stable name, used only to tell the job apart (never a tenant value). */
  readonly name: string;
  readonly intervalMs: number;
  /** Queues the job for one tenant; it must be safe to repeat (the handler deduplicates). */
  readonly enqueue: (tenantId: string) => Promise<void>;
}

export interface PeriodicTick {
  readonly enqueued: number;
  /** Tenants whose enqueue failed; the others were not stopped by it. */
  readonly failed: number;
}

export interface PeriodicTimers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const nodeTimers: PeriodicTimers = {
  set: (run, ms) => {
    const handle = setInterval(run, ms);
    // A scheduler never keeps the process alive on its own.
    handle.unref();
    return handle;
  },
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export const MIN_PERIODIC_INTERVAL_MS = 1000;
/** Default cadence of the incident SLA scan: the thresholds are expressed in days, minutes are plenty. */
export const DEFAULT_SLA_SCAN_INTERVAL_MS = 15 * 60_000;

/**
 * Runs per-tenant jobs on a timer: every tick queues one job per ACTIVE tenant through the same
 * outbox the worker drains. A suspended or missing tenant is skipped, a failing tenant does not stop
 * the others, and a tick that finds the previous one still running is skipped, never stacked.
 */
export class PeriodicScheduler {
  private handles: unknown[] = [];
  private readonly running = new Set<string>();

  public constructor(
    private readonly tenants: TenantDirectory & { ids(): readonly string[] },
    private readonly jobs: readonly PeriodicTenantJob[],
    private readonly timers: PeriodicTimers = nodeTimers,
  ) {
    for (const job of jobs)
      if (!Number.isInteger(job.intervalMs) || job.intervalMs < MIN_PERIODIC_INTERVAL_MS)
        throw new Error('periodic job interval must be an integer of at least one second');
  }

  /** One round of one job (all tenants). Exposed so a host, a test or a manual trigger can run it. */
  public async tick(name: string): Promise<PeriodicTick> {
    const job = this.jobs.find((candidate) => candidate.name === name);
    if (!job) throw new Error('unknown periodic job');
    if (this.running.has(name)) return { enqueued: 0, failed: 0 };
    this.running.add(name);
    let enqueued = 0;
    let failed = 0;
    try {
      for (const tenantId of this.tenants.ids()) {
        if (this.tenants.status(tenantId) !== 'active') continue;
        try {
          await job.enqueue(tenantId);
          enqueued += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      this.running.delete(name);
    }
    return { enqueued, failed };
  }

  /** Starts every job on its interval; calling it again restarts nothing. */
  public start(): void {
    if (this.handles.length > 0) return;
    this.handles = this.jobs.map((job) =>
      // A failed tick waits for the next one; it never becomes an unhandled rejection.
      this.timers.set(() => void this.tick(job.name).catch(() => undefined), job.intervalMs),
    );
  }

  public stop(): void {
    for (const handle of this.handles) this.timers.clear(handle);
    this.handles = [];
  }

  public get started(): boolean {
    return this.handles.length > 0;
  }
}
