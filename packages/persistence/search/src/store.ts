import 'reflect-metadata';
import { In, type DataSource } from 'typeorm';
import { MySqlTenantOutboxStore } from '../../audit/src/index.js';
import type { OutboxTransaction } from '../../../platform/outbox/src/index.js';
import {
  entityKey,
  isOpaqueJobId,
  SEARCH_EVENT_ACTOR,
  SEARCH_RECONCILE_EVENT,
  type EntityProjection,
  type EntityRef,
  type ReconcileJob,
  type ReconcileQueue,
  type SearchStore,
  type SearchStoreGroup,
  type SearchStoreQuery,
} from '../../../domain/search/src/index.js';
import { SEARCH_RUNTIME_ACCOUNT } from './data-source.js';
import { SEARCH_TABLES as T, SearchEntryEntity } from './entities.js';
import { hitsSql, totalSql } from './query.js';

const INSERT_CHUNK = 500;

interface HitRow {
  readonly entity_id: string;
  readonly area_id: string | null;
  readonly display: string;
}

/** Where the reconcile event is written; the tenant outbox, unless a test injects its own. */
export interface SearchOutbox {
  transaction<R>(manager: unknown, work: (tx: OutboxTransaction) => R | Promise<R>): Promise<R>;
}

/** TypeORM adapter of the projection. Every statement names the company; none crosses it. */
export class TypeOrmSearchStore implements SearchStore, ReconcileQueue {
  private readonly outbox: SearchOutbox;
  public constructor(
    private readonly dataSource: DataSource,
    outbox?: SearchOutbox,
  ) {
    const username = (dataSource.options as { username?: string }).username ?? '';
    if (!SEARCH_RUNTIME_ACCOUNT.test(username))
      throw new Error('Search store requires its restricted runtime account');
    this.outbox =
      outbox ??
      new MySqlTenantOutboxStore(
        () => [],
        () => this.dataSource,
        () => this.dataSource,
      );
  }

  /** Queues a reconcile of the company in its durable outbox; the same job id is queued once. */
  public async enqueueReconcile(job: ReconcileJob): Promise<void> {
    if (!isOpaqueJobId(job.jobId)) throw new Error('invalid search reconcile job');
    await this.dataSource.transaction('READ COMMITTED', (manager) =>
      this.outbox.transaction(manager, (tx) => {
        const eventId = `search-${job.jobId}`;
        tx.enqueue({
          eventId,
          tenantId: job.tenantId,
          type: SEARCH_RECONCILE_EVENT,
          payload: job.full === true ? { full: true } : {},
          occurredAt: job.at,
          idempotencyKey: eventId,
          correlationId: `${job.tenantId}.search-reconcile`,
          actorRef: { subject: SEARCH_EVENT_ACTOR, kind: 'system' },
          entityId: job.tenantId,
          schemaVersion: 1,
        });
      }),
    );
  }

  public async fingerprints(tenantId: string): Promise<ReadonlyMap<string, string>> {
    const rows = (await this.dataSource.query(
      `SELECT entity_type, entity_id, MIN(fingerprint) AS fingerprint FROM \`${T.entries}\` WHERE company_id = ? GROUP BY entity_type, entity_id`,
      [tenantId],
    )) as { entity_type: string; entity_id: string; fingerprint: string }[];
    return new Map(
      rows.map((row) => [
        entityKey(row.entity_type as EntityRef['entityType'], row.entity_id),
        row.fingerprint,
      ]),
    );
  }

  public async apply(
    tenantId: string,
    changes: {
      readonly upserts: readonly EntityProjection[];
      readonly removals: readonly EntityRef[];
    },
  ): Promise<void> {
    const rows: SearchEntryEntity[] = [];
    for (const upsert of changes.upserts)
      for (const entry of upsert.entries) {
        if (entry.tenantId !== tenantId) throw new Error('search entry of another company');
        rows.push({
          tenantId,
          entityType: entry.entityType,
          entityId: entry.entityId,
          keyKind: entry.keyKind,
          normalized: entry.normalized,
          areaId: entry.areaId,
          display: entry.display.slice(0, 200),
          requiredPermission: entry.requiredPermission,
          fingerprint: upsert.fingerprint,
          updatedAt: new Date(entry.updatedAt),
        });
      }
    const doomed = new Map<string, string[]>();
    for (const ref of [...changes.removals, ...changes.upserts])
      doomed.set(ref.entityType, [...(doomed.get(ref.entityType) ?? []), ref.entityId]);
    await this.dataSource.transaction(async (manager) => {
      for (const [entityType, ids] of doomed)
        await manager.delete(SearchEntryEntity, { tenantId, entityType, entityId: In(ids) });
      for (let at = 0; at < rows.length; at += INSERT_CHUNK)
        await manager.insert(SearchEntryEntity, rows.slice(at, at + INSERT_CHUNK));
    });
  }

  public async search(query: SearchStoreQuery): Promise<readonly SearchStoreGroup[]> {
    return Promise.all(
      query.types.map(async (type): Promise<SearchStoreGroup> => {
        const hits = hitsSql(query, type);
        const total = totalSql(query, type);
        const [rows, counted] = await Promise.all([
          this.dataSource.query(hits.sql, hits.params) as Promise<HitRow[]>,
          this.dataSource.query(total.sql, total.params) as Promise<{ n: string | number }[]>,
        ]);
        return {
          entityType: type.entityType,
          total: Number(counted[0]?.n ?? 0),
          hits: rows.map((row) => ({
            entityId: row.entity_id,
            areaId: row.area_id,
            display: row.display,
          })),
        };
      }),
    );
  }
}
