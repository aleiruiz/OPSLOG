import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SearchIndexer,
  normalizeKey,
  type SearchStoreQuery,
} from '../../../packages/domain/search/src/index.js';
import { TypeOrmSearchStore } from '../../../packages/persistence/search/src/index.js';
import {
  adminUrl,
  startSearchDatabase,
  type SearchDatabase,
} from '../../../packages/persistence/search/src/test-support/mysql.js';
import { FakeSources } from '../../../packages/domain/search/src/test-support.js';
import { plateOf, syntheticFacts, syntheticProjections } from './generate.js';

/**
 * Search latency over a synthetic dataset (SPECS §9.3: p95 <= 700 ms with 1 M). Opt-in: it needs
 * OPSLOG_PERF=1 and OPSLOG_TEST_MYSQL_ADMIN_URL. The size is OPSLOG_PERF_ENTITIES (default 100000
 * entities; each one has several key rows). The 1 M run is manual, see docs/operations/SEARCH_PERFORMANCE.md.
 */
const enabled = process.env.OPSLOG_PERF === '1' && Boolean(adminUrl);
const suite = enabled ? describe : describe.skip;
const ENTITIES = Number(process.env.OPSLOG_PERF_ENTITIES ?? 100_000);
const BATCH = 1_000;
const SAMPLES = 60;
const BUDGET_MS = 700;
const TENANT = 'tenant-perf';

const report = (line: string): void => {
  process.stdout.write(`[perf] ${line}\n`);
};

const p95 = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)
  ] as number;

suite(`search performance (${ENTITIES} entities)`, () => {
  let database: SearchDatabase;
  let store: TypeOrmSearchStore;

  beforeAll(async () => {
    database = await startSearchDatabase('perf');
    store = new TypeOrmSearchStore(await database.openRuntime(16));
    let batch = [];
    for (const projection of syntheticProjections(TENANT, ENTITIES)) {
      batch.push(projection);
      if (batch.length === BATCH) {
        await store.apply(TENANT, { upserts: batch, removals: [] });
        batch = [];
      }
    }
    if (batch.length > 0) await store.apply(TENANT, { upserts: batch, removals: [] });
    await database.rows('ANALYZE TABLE opslog_search_entries');
  }, 3_600_000);
  afterAll(async () => database?.close());

  const query = (term: string, exactKeys: string[] = []): SearchStoreQuery => ({
    tenantId: TENANT,
    term: normalizeKey(term),
    exactKeys,
    types: [
      { entityType: 'vehicle', permissions: ['view'] },
      { entityType: 'driver', permissions: ['view', 'view_pii'] },
      { entityType: 'dispatcher', permissions: ['view'] },
    ],
    limit: 10,
  });

  async function measure(label: string, terms: string[]): Promise<number> {
    const times: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      await store.search(query(terms[i % terms.length] as string));
      times.push(performance.now() - started);
    }
    const value = p95(times);
    report(`${label}: p95 ${value.toFixed(1)} ms over ${SAMPLES} (${ENTITIES} entities)`);
    return value;
  }

  const indexes = (n: number) => Array.from({ length: 25 }, (_, i) => (i * 7919) % n);

  it('answers a plate prefix within the budget', async () => {
    const terms = indexes(ENTITIES).map((i) => plateOf(i).slice(0, 6));
    expect(await measure('prefix', terms)).toBeLessThanOrEqual(BUDGET_MS);
  }, 600_000);

  it('answers a "contains" term within the budget', async () => {
    const terms = indexes(ENTITIES).map((i) => plateOf(i).slice(2, 7));
    expect(await measure('contains', terms)).toBeLessThanOrEqual(BUDGET_MS);
  }, 600_000);

  it('answers a term without hits within the budget', async () => {
    expect(await measure('miss', ['qqqqqq', 'zzzzz9', 'wwwwww'])).toBeLessThanOrEqual(BUDGET_MS);
  }, 600_000);

  it('uses the indexes of the projection (EXPLAIN is recorded)', async () => {
    const plan = await database.rows<Record<string, unknown>>(
      "EXPLAIN SELECT entity_id FROM opslog_search_entries WHERE company_id = ? AND entity_type = 'vehicle' AND normalized LIKE ?",
      [TENANT, 'abc%'],
    );
    report(`EXPLAIN prefix: ${JSON.stringify(plan)}`);
    expect(JSON.stringify(plan)).toMatch(/PRIMARY|ix_search_prefix/);
  });

  it('reconciles the whole company within a minute-scale budget (initial load, then steady state)', async () => {
    const tenant = 'tenant-reconcile';
    const sources = new FakeSources();
    const { vehicles, employees } = syntheticFacts(ENTITIES);
    sources.world(tenant).vehicles.push(...vehicles);
    sources.world(tenant).employees.push(...employees);
    const indexer = new SearchIndexer(store, sources);
    const time = async (label: string, work: () => Promise<unknown>): Promise<number> => {
      const started = performance.now();
      await work();
      const ms = performance.now() - started;
      report(`reconcile ${label}: ${(ms / 1000).toFixed(1)} s (${ENTITIES} entities)`);
      return ms;
    };
    await time('initial load', () => indexer.reconcile(tenant));
    // Nothing changed: the run reads the sources and the fingerprints, and writes nothing.
    const steady = await time('steady state', () => indexer.reconcile(tenant));
    expect(steady).toBeLessThan(60_000);
  }, 3_600_000);
});
