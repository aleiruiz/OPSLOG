import type { ReportPlan, ReportResult } from './types.js';

/** Seconds a preview result is reused: the pages of one screen read the same cut of the data. */
export const PREVIEW_TTL_MS = 30_000;
/** Rows kept across all entries: the cache is bounded in memory, oldest entries leave first. */
export const PREVIEW_MAX_ROWS = 100_000;

interface Entry {
  readonly result: ReportResult;
  readonly expiresAt: number;
}

/**
 * Short-lived cache of the full, filtered and ordered result of a preview, so paging a report does
 * not load it again for every page. The key names the company, the reader's permissions and the whole
 * plan, so nobody reuses a result built for other rights; exports never read it.
 */
export class PreviewCache {
  private readonly entries = new Map<string, Entry>();
  private rows = 0;

  public constructor(
    private readonly clock: () => number,
    private readonly ttlMs: number = PREVIEW_TTL_MS,
    private readonly maxRows: number = PREVIEW_MAX_ROWS,
  ) {}

  public static key(
    tenantId: string,
    actorId: string | undefined,
    permissions: ReadonlySet<string>,
    plan: ReportPlan,
  ): string {
    return JSON.stringify([
      tenantId,
      actorId ?? null,
      [...permissions].sort(),
      plan.definition.id,
      plan.columns.map((c) => c.id),
      [...plan.filters].sort(([a], [b]) => a.localeCompare(b)),
      plan.sort,
    ]);
  }

  public get(key: string): ReportResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.drop(key);
      return undefined;
    }
    return entry.result;
  }

  public set(key: string, result: ReportResult): void {
    this.drop(key);
    // A result larger than the whole budget is not worth keeping.
    if (result.rows.length > this.maxRows) return;
    this.entries.set(key, { result, expiresAt: this.clock() + this.ttlMs });
    this.rows += result.rows.length;
    for (const oldest of this.entries.keys()) {
      if (this.rows <= this.maxRows) break;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.rows -= entry.result.rows.length;
    this.entries.delete(key);
  }
}
