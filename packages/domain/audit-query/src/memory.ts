import { isDeniedAction } from './catalog.js';
import {
  type AuditEventReader,
  type AuditEventRow,
  type AuditFilter,
  type AuditPageRequest,
  type AuditReconciler,
  type AuditReconciliation,
  type AuditSlice,
} from './types.js';

/** Rows of one company, from any in-memory audit store. */
export type AuditSnapshot = (tenantId: string) => readonly AuditEventRow[];

function matches(row: AuditEventRow, filter: AuditFilter): boolean {
  const at = Date.parse(row.occurredAt);
  return (
    at >= Date.parse(filter.from) &&
    at < Date.parse(filter.to) &&
    (filter.actorId === undefined || row.actor.id === filter.actorId) &&
    (filter.entityType === undefined || row.entityType === filter.entityType) &&
    (filter.entityId === undefined || row.entityId === filter.entityId) &&
    (filter.actionPrefix === undefined || row.action.startsWith(filter.actionPrefix)) &&
    (filter.result === undefined || isDeniedAction(row.action) === (filter.result === 'denied'))
  );
}

/** Newest first; ties break on the event id, descending, so a page boundary is never ambiguous. */
export const byNewest = (a: AuditEventRow, b: AuditEventRow): number =>
  Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
  (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0);

/** The reader over an in-memory snapshot (tests, local development). */
export class InMemoryAuditReader implements AuditEventReader {
  public constructor(private readonly snapshot: AuditSnapshot) {}

  public async query(
    tenantId: string,
    filter: AuditFilter,
    page: AuditPageRequest,
  ): Promise<AuditSlice> {
    const all = this.snapshot(tenantId)
      .filter((row) => matches(row, filter))
      .sort(byNewest);
    const after = page.after;
    const rest = after
      ? all.filter(
          (row) =>
            byNewest(row, { ...row, occurredAt: after.occurredAt, eventId: after.eventId }) > 0,
        )
      : all;
    return {
      rows: rest.slice(0, page.limit),
      total: all.length,
      hasMore: rest.length > page.limit,
    };
  }
}

/** An in-memory audit has no relay: every row is already in the only store, so nothing is pending. */
export class InMemoryAuditReconciler implements AuditReconciler {
  public constructor(private readonly snapshot: AuditSnapshot) {}

  public async reconcile(
    tenantId: string,
    from: string,
    to: string,
    now: Date,
  ): Promise<AuditReconciliation> {
    const local = this.snapshot(tenantId).filter(
      (row) =>
        Date.parse(row.occurredAt) >= Date.parse(from) &&
        Date.parse(row.occurredAt) < Date.parse(to),
    ).length;
    return {
      from,
      to,
      generatedAt: now.toISOString(),
      local,
      relayed: local,
      pending: [],
      pendingTotal: 0,
      oldestPendingAgeSeconds: null,
    };
  }
}
