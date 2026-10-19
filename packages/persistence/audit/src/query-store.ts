import type { DataSource } from 'typeorm';
import { AUDIT_TABLES, AuditProjectionEntity } from './entities.js';
import { AuditPersistenceError } from './store.js';

/**
 * Read side of the durable audit for the audit screens (FR-171, S26). The shapes are structural mirrors of the
 * ports of `packages/domain/audit-query`, which this package does not import.
 */
export interface AuditQueryFilter {
  readonly from: string;
  readonly to: string;
  readonly actorId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actionPrefix?: string;
  readonly result?: 'success' | 'denied';
}
export interface AuditQueryPage {
  readonly limit: number;
  /** Continue strictly after this row in `occurredAt desc, eventId desc` order. */
  readonly after?: { readonly occurredAt: string; readonly eventId: string };
}
export interface AuditQueryRow {
  readonly eventId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: string;
  readonly actor: { readonly id: string; readonly kind: 'user' | 'api_key' | 'system' };
  readonly correlationId: string;
}
export interface AuditQuerySlice {
  readonly rows: readonly AuditQueryRow[];
  readonly total: number;
  readonly hasMore: boolean;
}

export interface PendingAuditRecord {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly entityType: string;
  readonly delivery: 'pending' | 'delivered' | 'missing';
  readonly ageSeconds: number;
}
export interface AuditReconciliationReport {
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly local: number;
  readonly relayed: number;
  readonly pending: readonly PendingAuditRecord[];
  readonly pendingTotal: number;
  readonly oldestPendingAgeSeconds: number | null;
}

/** Most pending events a reconciliation report lists; the total is always exact. */
export const RECONCILIATION_ITEM_LIMIT = 100;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ESCAPE = '!';

/** A LIKE pattern for a literal prefix: `_` and `%` of the prefix must not act as wildcards. */
const likePrefix = (prefix: string): string => `${prefix.replace(/[!%_]/g, '!$&')}%`;

function requireTenant(tenantId: string): void {
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId))
    throw new Error('invalid audit tenantId');
}

/**
 * One page of the tenant's audit, newest first, with the exact total. The order is the covering order of the
 * `(tenant_id, occurred_at)` index, so a page never sorts the range; entity and actor filters have their own
 * indexes. The tenant comes from the caller's session and is part of every predicate.
 */
export async function queryAuditProjection(
  source: DataSource,
  tenantId: string,
  filter: AuditQueryFilter,
  page: AuditQueryPage,
): Promise<AuditQuerySlice> {
  requireTenant(tenantId);
  try {
    const base = () => {
      const query = source
        .getRepository(AuditProjectionEntity)
        .createQueryBuilder('audit')
        .where('audit.tenantId = :tenantId', { tenantId })
        .andWhere('audit.occurredAt >= :from', { from: new Date(filter.from) })
        .andWhere('audit.occurredAt < :to', { to: new Date(filter.to) });
      if (filter.actorId !== undefined)
        query.andWhere('audit.actorId = :actorId', { actorId: filter.actorId });
      if (filter.entityType !== undefined)
        query.andWhere('audit.entityType = :entityType', { entityType: filter.entityType });
      if (filter.entityId !== undefined)
        query.andWhere('audit.entityId = :entityId', { entityId: filter.entityId });
      if (filter.actionPrefix !== undefined)
        query.andWhere(`audit.action LIKE :prefix ESCAPE '${ESCAPE}'`, {
          prefix: likePrefix(filter.actionPrefix),
        });
      if (filter.result !== undefined)
        query.andWhere(
          `audit.action ${filter.result === 'denied' ? '' : 'NOT '}LIKE '%.access${ESCAPE}_denied' ESCAPE '${ESCAPE}'`,
        );
      return query;
    };
    const total = await base().getCount();
    const keyset = base();
    if (page.after) {
      const at = new Date(page.after.occurredAt);
      keyset.andWhere(
        '(audit.occurredAt < :at OR (audit.occurredAt = :at AND audit.eventId < :id))',
        { at, id: page.after.eventId },
      );
    }
    const rows = await keyset
      .orderBy('audit.occurredAt', 'DESC')
      .addOrderBy('audit.eventId', 'DESC')
      .take(page.limit + 1)
      .getMany();
    return {
      total,
      hasMore: rows.length > page.limit,
      rows: rows.slice(0, page.limit).map(
        (row): AuditQueryRow => ({
          eventId: row.eventId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          occurredAt: row.occurredAt.toISOString(),
          actor: { id: row.actorId, kind: row.actorKind },
          correlationId: row.correlationId,
        }),
      ),
    };
  } catch {
    throw new AuditPersistenceError();
  }
}

interface PendingRow {
  event_id: string;
  occurred_at: Date;
  action: string;
  entity_type: string;
  delivery_status: 'pending' | 'delivered' | null;
  queued_at: Date | null;
}

/**
 * Compares the local audit with the durable store over a range, as the relay account sees both. An event is
 * pending until its projection and registry rows exist. Nothing is repaired or edited: the report only lists
 * what is missing and for how long (FR-170, SPECS §9.3).
 */
export async function reconcileAudit(
  source: DataSource,
  tenantId: string,
  from: string,
  to: string,
  now: Date,
): Promise<AuditReconciliationReport> {
  requireTenant(tenantId);
  const range = [tenantId, new Date(from), new Date(to)];
  const t = AUDIT_TABLES;
  try {
    const counts = (await source.query(
      `SELECT COUNT(*) AS local_count, COUNT(r.event_id) AS relayed_count
         FROM \`${t.local}\` l
         LEFT JOIN \`${t.registry}\` r ON r.tenant_id = l.tenant_id AND r.event_id = l.event_id
        WHERE l.tenant_id = ? AND l.occurred_at >= ? AND l.occurred_at < ?`,
      range,
    )) as { local_count: string | number; relayed_count: string | number }[];
    const rows = (await source.query(
      `SELECT l.event_id, l.occurred_at, l.action, l.entity_type,
              d.status AS delivery_status, d.created_at AS queued_at
         FROM \`${t.local}\` l
         LEFT JOIN \`${t.registry}\` r ON r.tenant_id = l.tenant_id AND r.event_id = l.event_id
         LEFT JOIN \`${t.delivery}\` d ON d.tenant_id = l.tenant_id AND d.event_id = l.event_id
        WHERE l.tenant_id = ? AND l.occurred_at >= ? AND l.occurred_at < ? AND r.event_id IS NULL
        ORDER BY COALESCE(d.created_at, l.occurred_at) ASC, l.event_id ASC
        LIMIT ${RECONCILIATION_ITEM_LIMIT}`,
      range,
    )) as PendingRow[];
    const local = Number(counts[0]?.local_count ?? 0);
    const relayed = Number(counts[0]?.relayed_count ?? 0);
    const pending = rows.map(
      (row): PendingAuditRecord => ({
        eventId: row.event_id,
        occurredAt: new Date(row.occurred_at).toISOString(),
        action: row.action,
        entityType: row.entity_type,
        delivery: row.delivery_status ?? 'missing',
        ageSeconds: Math.max(
          0,
          Math.floor((now.getTime() - new Date(row.queued_at ?? row.occurred_at).getTime()) / 1000),
        ),
      }),
    );
    return {
      from,
      to,
      generatedAt: now.toISOString(),
      local,
      relayed,
      pending,
      pendingTotal: local - relayed,
      oldestPendingAgeSeconds: pending[0]?.ageSeconds ?? null,
    };
  } catch {
    throw new AuditPersistenceError();
  }
}

/** The tenant of a read is the caller's session tenant; anything that is not an opaque id never reaches SQL. */
export function assertAuditTenant(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tenantId))
    throw new Error('invalid audit tenantId');
}
