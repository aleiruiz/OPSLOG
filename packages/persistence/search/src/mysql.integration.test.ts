import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  InMemorySearchStore,
  SearchIndexer,
  SearchService,
  employeeProjection,
  vehicleProjection,
  type SearchStore,
  type Searcher,
} from '../../../domain/search/src/index.js';
import {
  FakeSources,
  employee,
  incident,
  policy,
  vehicle,
} from '../../../domain/search/src/test-support.js';
import { AUDIT_TABLES } from '../../audit/src/index.js';
import { SEARCH_TABLES } from './entities.js';
import { searchSql } from './query.js';
import { TypeOrmSearchStore } from './store.js';
import { adminUrl, startSearchDatabase, type SearchDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const A = 'tenant-a';
const B = 'tenant-b';
const LICENSE = 'c'.repeat(64);
const who = (...permissions: string[]): Searcher => ({
  permissions: new Set(permissions),
  mechanicLinked: false,
});
const ALL = who('view', 'view_pii', 'incidents:view');

function seed(sources: FakeSources) {
  const a = sources.world(A);
  a.vehicles.push(
    vehicle('v1'),
    vehicle('v2', { plate: 'KLM-900', economicNumber: 'U-2', vin: '3N6AD33C9XK000123' }),
    vehicle('v3', { plate: 'XABC1', economicNumber: 'U-3' }),
  );
  // More matches than the per-type limit: covers the `rn <= ?` cut-off and a total above it.
  for (let i = 1; i <= 13; i++)
    a.vehicles.push(
      vehicle(`m${i}`, { plate: `ZMANY-${String(i).padStart(2, '0')}`, economicNumber: `M-${i}` }),
    );
  a.employees.push(
    employee('e1', { licenseIndex: LICENSE, firstName: 'Washington', lastName: 'Pérez' }),
    employee('e2', { kind: 'dispatcher', firstName: 'Theodore', lastName: 'Gómez' }),
  );
  a.incidents.push(incident('i1', { claimNumber: 'CLM-55' }));
  a.policies.push(policy('p1'));
  const b = sources.world(B);
  b.vehicles.push(vehicle('bv1'));
  b.employees.push(employee('be1', { firstName: 'Washington', lastName: 'Pérez' }));
  b.incidents.push(incident('i1'));
}

suite('persistent search projection on MySQL', () => {
  let db: SearchDatabase;
  let source: DataSource;
  let store: TypeOrmSearchStore;
  let memory: InMemorySearchStore;
  const sources = new FakeSources();

  beforeAll(async () => {
    db = await startSearchDatabase('search');
    source = await db.openRuntime();
    store = new TypeOrmSearchStore(source);
    memory = new InMemorySearchStore();
    seed(sources);
    for (const target of [store, memory] as SearchStore[]) {
      const indexer = new SearchIndexer(target, sources);
      await indexer.reconcile(A);
      await indexer.reconcile(B);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  const exact = async (_tenant: string, raw: string) => (raw === 'LIC-1' ? [LICENSE] : []);
  const terms = [
    'ÁBC-123',
    'abc123',
    'abc 1',
    'bc12',
    'abc',
    'ab',
    'xabc',
    'perez',
    'Pérez',
    'was',
    'the',
    'odor',
    'gomez theodore',
    'clm55',
    'sin2026i1',
    'polp1',
    '3n6ad33',
    'LIC-1',
    'LIC',
    'zzz',
    'zmany',
    'many',
    'u',
  ];

  it('answers exactly like the in-memory reference for every kind of query', async () => {
    for (const searcher of [ALL, who('view'), who('view', 'incidents:view')])
      for (const tenant of [A, B])
        for (const term of terms) {
          const real = await new SearchService(store, exact).search(tenant, searcher, term);
          const reference = await new SearchService(memory, exact).search(tenant, searcher, term);
          expect(real, `${tenant} ${term}`).toEqual(reference);
        }
  });

  it('cuts each type at the limit and still reports the full total', async () => {
    const service = new SearchService(store, exact);
    for (const term of ['zmany', 'many']) {
      const vehicles = (await service.search(A, ALL, term)).groups.find(
        (g) => g.type === 'vehicle',
      );
      expect(vehicles?.items).toHaveLength(10);
      expect(vehicles?.total).toBe(13);
    }
  });

  it('finds fragments that the default stopword list would hide', async () => {
    const service = new SearchService(store, exact);
    const people = async (term: string) =>
      (await service.search(A, ALL, term)).groups.find((g) => g.type === 'driver')?.items;
    expect((await people('was'))?.map((i) => i.id)).toEqual(['e1']);
    const dispatchers = (await service.search(A, ALL, 'the')).groups.find(
      (g) => g.type === 'dispatcher',
    );
    expect(dispatchers?.items.map((i) => i.id)).toEqual(['e2']);
  });

  it('keeps the companies apart even for the same names, plates and folios', async () => {
    const service = new SearchService(store, exact);
    const idsOf = async (tenant: string, term: string, type: string) =>
      (await service.search(tenant, ALL, term)).groups
        .find((g) => g.type === type)
        ?.items.map((i) => i.id);
    expect(await idsOf(A, 'abc123', 'vehicle')).toEqual(['v1']);
    expect(await idsOf(B, 'abc123', 'vehicle')).toEqual(['bv1']);
    expect(await idsOf(B, 'clm55', 'incident')).toEqual([]);
    expect(await idsOf('tenant-c', 'abc123', 'vehicle')).toEqual([]);
  });

  it('matches a license only exactly and only for view_pii, and stores no plain value', async () => {
    const service = new SearchService(store, exact);
    const drivers = async (searcher: Searcher, term: string) =>
      (await service.search(A, searcher, term)).groups.find((g) => g.type === 'driver')?.items;
    expect((await drivers(ALL, 'LIC-1'))?.map((i) => i.id)).toEqual(['e1']);
    expect(await drivers(ALL, 'LIC')).toEqual([]);
    expect(await drivers(ALL, LICENSE.slice(0, 12))).toEqual([]);
    expect(await drivers(who('view', 'incidents:view'), 'LIC-1')).toEqual([]);
    const stored = await db.rows<{ normalized: string; display: string }>(
      `SELECT normalized, display FROM \`${SEARCH_TABLES.entries}\` WHERE key_kind = 'license'`,
    );
    expect(stored).toEqual([{ normalized: LICENSE, display: 'Washington Pérez' }]);
  });

  it('is idempotent and a rebuild after deleting the rows leaves the same projection', async () => {
    const snapshot = () =>
      db.rows(
        `SELECT company_id, entity_type, entity_id, key_kind, normalized, display, fingerprint FROM \`${SEARCH_TABLES.entries}\` ORDER BY 1,2,3,4,5`,
      );
    const before = await snapshot();
    const indexer = new SearchIndexer(store, sources);
    expect(await indexer.reconcile(A)).toMatchObject({ written: 0, removed: 0 });
    await db.rows(`DELETE FROM \`${SEARCH_TABLES.entries}\``);
    expect(await indexer.rebuild(A)).toMatchObject({ removed: 0 });
    await indexer.rebuild(B);
    expect(await snapshot()).toEqual(before);
  });

  it('drops the old key when a plate changes, and does not duplicate on a repeat', async () => {
    const changing = new FakeSources();
    const fresh = changing.world('tenant-fresh');
    fresh.vehicles.push(vehicle('v1', { plate: 'OLD-111', economicNumber: 'U-9' }));
    const indexer = new SearchIndexer(store, changing);
    const service = new SearchService(store, exact);
    const find = async (term: string) =>
      (await service.search('tenant-fresh', ALL, term)).groups.find((g) => g.type === 'vehicle');
    expect((await find('old111'))?.total).toBe(0);
    await indexer.reconcile('tenant-fresh');
    expect((await find('old111'))?.total).toBe(1);
    fresh.vehicles[0] = vehicle('v1', { plate: 'NEW-222', economicNumber: 'U-9' });
    await indexer.reconcile('tenant-fresh');
    await indexer.reconcile('tenant-fresh');
    expect((await find('old111'))?.total).toBe(0);
    expect((await find('new222'))?.total).toBe(1);
    const rows = await db.rows(
      `SELECT 1 FROM \`${SEARCH_TABLES.entries}\` WHERE company_id = 'tenant-fresh' AND key_kind = 'plate'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('rolls back a whole change that carries a row of another company', async () => {
    const own = employeeProjection('tenant-tx', employee('e1'));
    const bad = vehicleProjection('tenant-other', vehicle('v1'));
    await expect(
      store.apply('tenant-tx', {
        upserts: [own!, { ...bad!, entries: bad!.entries.map((e) => ({ ...e })) }],
        removals: [],
      }),
    ).rejects.toThrow(/another company/);
    expect(
      await db.rows(`SELECT 1 FROM \`${SEARCH_TABLES.entries}\` WHERE company_id = 'tenant-tx'`),
    ).toHaveLength(0);
  });

  it('gives the runtime account only read, insert and delete on the projection', async () => {
    await expect(
      source.query(`UPDATE \`${SEARCH_TABLES.entries}\` SET display = 'x' WHERE company_id = ?`, [
        A,
      ]),
    ).rejects.toMatchObject({ driverError: { errno: 1142 } });
    await expect(source.query(`DROP TABLE \`${SEARCH_TABLES.entries}\``)).rejects.toMatchObject({
      driverError: { errno: 1142 },
    });
  });

  it('uses the prefix index and the FULLTEXT index in the plans of the real statement', async () => {
    const plan = async (term: string) => {
      const built = searchSql({
        tenantId: A,
        term,
        exactKeys: [],
        types: [
          { entityType: 'vehicle', permissions: ['view'] },
          { entityType: 'driver', permissions: ['view', 'view_pii'] },
        ],
        limit: 10,
      });
      return JSON.stringify(await db.rows(`EXPLAIN ${built.sql}`, built.params));
    };
    // On the tiny seed the optimizer may scan the primary key, so the plans prove the indexes are reachable.
    const prefix = await plan('ab');
    expect(prefix).toContain('ix_search_prefix');
    expect(await plan('abc')).toContain('ft_search_normalized');
  });

  it('queues one reconcile event per job id in the durable outbox of the company', async () => {
    const job = { tenantId: A, jobId: 'job-1', at: '2026-10-19T12:00:00.000Z' };
    await store.enqueueReconcile(job);
    await store.enqueueReconcile(job);
    await store.enqueueReconcile({ ...job, jobId: 'job-2', full: true });
    await expect(store.enqueueReconcile({ ...job, jobId: 'bad id' })).rejects.toThrow(/invalid/);
    const rows = await db.rows<{ event_id: string; type: string; payload: unknown }>(
      `SELECT event_id, type, payload FROM \`${AUDIT_TABLES.outbox}\` WHERE tenant_id = ? ORDER BY event_id`,
      [A],
    );
    expect(rows.map((r) => [r.event_id, r.type])).toEqual([
      ['search-job-1', 'search.reconcile'],
      ['search-job-2', 'search.reconcile'],
    ]);
    expect(JSON.parse(JSON.stringify(rows[1]?.payload))).toEqual({ full: true });
  });
});
