import type {
  ImportEntity,
  ImportEvent,
  ImportJob,
  ImportRowResult,
  ImportStatus,
  RowOutcome,
} from './types.js';

export interface ImportJobFilter {
  readonly entity?: ImportEntity;
  readonly status?: ImportStatus;
}
export interface RowFilter {
  readonly outcome?: RowOutcome;
}
export interface ImportWindow {
  readonly limit: number;
  readonly offset: number;
}
export interface ImportJobSlice {
  readonly items: readonly ImportJob[];
  /** Number of jobs matching the filter, not only the window. */
  readonly total: number;
}
export interface ImportRowSlice {
  readonly items: readonly ImportRowResult[];
  readonly total: number;
}
export interface ImportEventSlice {
  readonly items: readonly ImportEvent[];
  readonly total: number;
}

/**
 * Persistence port. Every method is tenant-scoped: a job of another tenant is simply absent. Row
 * results and events are only ever appended; a job is only ever finished (never edited, never
 * deleted).
 */
export interface ImportStore {
  /** Inserts the job and its first event. False when the tenant already has a job with the same idempotency key. */
  insertJob(job: ImportJob, event: ImportEvent): Promise<boolean>;
  findJob(tenantId: string, id: string): Promise<ImportJob | null>;
  findByKey(tenantId: string, idempotencyKey: string): Promise<ImportJob | null>;
  /** Newest first, then id. */
  listJobs(
    tenantId: string,
    filter: ImportJobFilter,
    window: ImportWindow,
  ): Promise<ImportJobSlice>;
  /** Appends results; a row number that already has a result keeps it (a retry never rewrites history). */
  appendRows(tenantId: string, jobId: string, rows: readonly ImportRowResult[]): Promise<void>;
  /** By row number. */
  rows(
    tenantId: string,
    jobId: string,
    filter: RowFilter,
    window: ImportWindow,
  ): Promise<ImportRowSlice>;
  /** Atomic compare-and-set of the end of a job: writes `next` and `event` only while the stored version is `expectedVersion`; false otherwise. */
  finishJob(next: ImportJob, expectedVersion: number, event: ImportEvent): Promise<boolean>;
  /** Newest event first. */
  events(tenantId: string, jobId: string, window: ImportWindow): Promise<ImportEventSlice>;
  /**
   * Atomic claim (and lease renewal) of a running job: moves `updatedAt` from `expectedUpdatedAt`
   * to `nextUpdatedAt` only while the job is still `running` and still has that exact stamp; false
   * otherwise. Of any number of executors that read the same stamp, exactly one wins.
   */
  claimJob(
    tenantId: string,
    jobId: string,
    expectedUpdatedAt: string,
    nextUpdatedAt: string,
  ): Promise<boolean>;
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemoryImportStore implements ImportStore {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly results = new Map<string, ImportRowResult>();
  private readonly eventRows: ImportEvent[] = [];

  public async insertJob(job: ImportJob, event: ImportEvent): Promise<boolean> {
    const taken =
      job.idempotencyKey !== null &&
      [...this.jobs.values()].some(
        (other) => other.tenantId === job.tenantId && other.idempotencyKey === job.idempotencyKey,
      );
    if (taken || this.jobs.has(storeKey(job.tenantId, job.id))) return false;
    this.jobs.set(storeKey(job.tenantId, job.id), structuredClone(job));
    this.eventRows.push(structuredClone(event));
    return true;
  }

  public async findJob(tenantId: string, id: string): Promise<ImportJob | null> {
    const found = this.jobs.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async findByKey(tenantId: string, idempotencyKey: string): Promise<ImportJob | null> {
    const found = [...this.jobs.values()].find(
      (job) => job.tenantId === tenantId && job.idempotencyKey === idempotencyKey,
    );
    return found ? structuredClone(found) : null;
  }

  public async listJobs(
    tenantId: string,
    filter: ImportJobFilter,
    window: ImportWindow,
  ): Promise<ImportJobSlice> {
    const matching = [...this.jobs.values()]
      .filter(
        (job) =>
          job.tenantId === tenantId &&
          (filter.entity === undefined || job.entity === filter.entity) &&
          (filter.status === undefined || job.status === filter.status),
      )
      .sort((a, b) => compareKeys(b.createdAt, a.createdAt) || compareKeys(a.id, b.id));
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((job) => structuredClone(job)),
      total: matching.length,
    };
  }

  public async appendRows(
    tenantId: string,
    jobId: string,
    rows: readonly ImportRowResult[],
  ): Promise<void> {
    for (const row of rows) {
      const key = `${storeKey(tenantId, jobId)}#${row.rowNumber}`;
      if (!this.results.has(key)) this.results.set(key, structuredClone(row));
    }
  }

  public async rows(
    tenantId: string,
    jobId: string,
    filter: RowFilter,
    window: ImportWindow,
  ): Promise<ImportRowSlice> {
    const matching = [...this.results.values()]
      .filter(
        (row) =>
          row.tenantId === tenantId &&
          row.jobId === jobId &&
          (filter.outcome === undefined || row.outcome === filter.outcome),
      )
      .sort((a, b) => a.rowNumber - b.rowNumber);
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: matching.length,
    };
  }

  public async finishJob(
    next: ImportJob,
    expectedVersion: number,
    event: ImportEvent,
  ): Promise<boolean> {
    const key = storeKey(next.tenantId, next.id);
    if (this.jobs.get(key)?.version !== expectedVersion) return false;
    this.jobs.set(key, structuredClone(next));
    this.eventRows.push(structuredClone(event));
    return true;
  }

  public async claimJob(
    tenantId: string,
    jobId: string,
    expectedUpdatedAt: string,
    nextUpdatedAt: string,
  ): Promise<boolean> {
    const key = storeKey(tenantId, jobId);
    const job = this.jobs.get(key);
    if (job?.status !== 'running' || job.updatedAt !== expectedUpdatedAt) return false;
    this.jobs.set(key, { ...job, updatedAt: nextUpdatedAt });
    return true;
  }

  public async events(
    tenantId: string,
    jobId: string,
    window: ImportWindow,
  ): Promise<ImportEventSlice> {
    const all = this.eventRows
      .filter((row) => row.tenantId === tenantId && row.jobId === jobId)
      .sort((a, b) => b.seq - a.seq);
    return {
      items: all
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: all.length,
    };
  }
}
