import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import type { EntityProjection, SearchStoreQuery } from '../../../domain/search/src/index.js';
import { hitsSql, matchesSql, totalSql } from './query.js';
import { TypeOrmSearchStore } from './store.js';

const query = (over: Partial<SearchStoreQuery> = {}): SearchStoreQuery => ({
  tenantId: 'tenant-1',
  term: 'abc123',
  exactKeys: [],
  types: [{ entityType: 'vehicle', permissions: ['view'] }],
  limit: 10,
  ...over,
});
const type = { entityType: 'driver', permissions: ['view', 'view_pii'] } as const;

describe('search SQL', () => {
  it('scopes every branch to the company, the type and the permissions, with bound values', () => {
    const { sql, params } = matchesSql(query(), type);
    expect(sql.match(/company_id = \?/g)).toHaveLength(2);
    expect(sql.match(/required_permission IN \(\?,\?\)/g)).toHaveLength(2);
    expect(sql).toContain('MATCH(normalized) AGAINST (? IN BOOLEAN MODE)');
    expect(sql).toContain('normalized LIKE ?');
    expect(params).toContain('tenant-1');
    expect(params).toContain('"abc123"');
    expect(params).toContain('%abc123%');
    expect(params).toContain('abc123%');
    // Nothing typed is ever part of the statement text.
    expect(sql).not.toContain('abc123');
  });

  it('adds the exact-key branch only with blind indexes and contains only from three characters', () => {
    const plain = matchesSql(query({ term: 'ab' }), type);
    expect(plain.sql).not.toContain('MATCH');
    expect(plain.sql).not.toContain('normalized IN');
    const exact = matchesSql(query({ exactKeys: ['f'.repeat(64), 'e'.repeat(64)] }), type);
    expect(exact.sql).toContain('normalized IN (?,?)');
    expect(exact.sql).toContain('key_kind IN (?,?)');
    expect(exact.params).toContain('f'.repeat(64));
  });

  it('groups by entity, ranks and limits the hits, and counts distinct entities', () => {
    const hits = hitsSql(query({ limit: 7 }), type);
    expect(hits.sql).toContain('GROUP BY entity_id ORDER BY rnk, display, entity_id LIMIT ?');
    expect(hits.params.at(-1)).toBe(7);
    expect(totalSql(query(), type).sql).toContain('COUNT(DISTINCT entity_id)');
  });
});

interface Call {
  sql: string;
  params: unknown[];
}
function fakeSource(username = 'opslog_search_t1') {
  const calls: Call[] = [];
  const deletes: unknown[] = [];
  const inserts: unknown[][] = [];
  const manager = {
    delete: async (_entity: unknown, where: unknown) => void deletes.push(where),
    insert: async (_entity: unknown, rows: unknown[]) => void inserts.push(rows),
  };
  const source = {
    options: { username },
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT entity_type'))
        return [{ entity_type: 'vehicle', entity_id: 'v1', fingerprint: 'fp' }];
      if (sql.includes('COUNT(DISTINCT')) return [{ n: '12' }];
      return [{ entity_id: 'v1', area_id: null, display: 'U-1' }];
    },
    transaction: async (work: (m: typeof manager) => Promise<void>) => work(manager),
  } as unknown as DataSource;
  return { source, calls, deletes, inserts };
}
const projection = (tenantId: string, id = 'v1'): EntityProjection => ({
  entityType: 'vehicle',
  entityId: id,
  fingerprint: 'fp',
  entries: [
    {
      tenantId,
      entityType: 'vehicle',
      entityId: id,
      areaId: 'a1',
      keyKind: 'plate',
      normalized: 'abc123',
      display: 'x'.repeat(300),
      requiredPermission: 'view',
      updatedAt: '2026-10-19T12:00:00.000Z',
    },
  ],
});

describe('TypeOrmSearchStore', () => {
  it('requires the restricted runtime account', () => {
    expect(() => new TypeOrmSearchStore(fakeSource('root').source)).toThrow(/restricted/);
  });

  it('reads fingerprints of the company only', async () => {
    const { source, calls } = fakeSource();
    const found = await new TypeOrmSearchStore(source).fingerprints('tenant-1');
    expect(found.get('vehicle:v1')).toBe('fp');
    expect(calls[0]?.params).toEqual(['tenant-1']);
    expect(calls[0]?.sql).toContain('WHERE company_id = ?');
  });

  it('deletes then inserts the rows of the changed entities in one transaction', async () => {
    const { source, deletes, inserts } = fakeSource();
    await new TypeOrmSearchStore(source).apply('tenant-1', {
      upserts: [projection('tenant-1')],
      removals: [{ entityType: 'driver', entityId: 'd9' }],
    });
    expect(deletes).toHaveLength(2);
    expect(inserts).toHaveLength(1);
    const row = inserts[0]?.[0] as { tenantId: string; display: string; fingerprint: string };
    expect(row.tenantId).toBe('tenant-1');
    expect(row.display).toHaveLength(200);
    expect(row.fingerprint).toBe('fp');
  });

  it('inserts in chunks and writes nothing for an empty change', async () => {
    const { source, inserts, deletes } = fakeSource();
    const store = new TypeOrmSearchStore(source);
    await store.apply('tenant-1', { upserts: [], removals: [] });
    expect(inserts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    const many = Array.from({ length: 501 }, (_, n) => projection('tenant-1', `v${n}`));
    await store.apply('tenant-1', { upserts: many, removals: [] });
    expect(inserts.map((chunk) => chunk.length)).toEqual([500, 1]);
  });

  it('refuses a row of another company', async () => {
    const { source, deletes } = fakeSource();
    await expect(
      new TypeOrmSearchStore(source).apply('tenant-1', {
        upserts: [projection('tenant-2')],
        removals: [],
      }),
    ).rejects.toThrow(/another company/);
    expect(deletes).toHaveLength(0);
  });

  it('answers hits and the total of each type', async () => {
    const { source } = fakeSource();
    const groups = await new TypeOrmSearchStore(source).search(query());
    expect(groups).toEqual([
      {
        entityType: 'vehicle',
        total: 12,
        hits: [{ entityId: 'v1', areaId: null, display: 'U-1' }],
      },
    ]);
  });
});
