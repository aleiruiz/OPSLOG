import { describe, expect, it } from 'vitest';
import { SearchIndexer } from './indexer.js';
import { InMemorySearchStore } from './memory-store.js';
import { employee, FakeSources, incident, policy, vehicle } from './test-support.js';

function setup() {
  const store = new InMemorySearchStore();
  const sources = new FakeSources();
  return { store, sources, indexer: new SearchIndexer(store, sources) };
}

const keys = async (store: InMemorySearchStore, tenant: string) => [
  ...(await store.fingerprints(tenant)).entries(),
];

describe('SearchIndexer', () => {
  it('writes every searchable entity of the company and none of another', async () => {
    const { store, sources, indexer } = setup();
    sources.world('t1').vehicles.push(vehicle('v1'), vehicle('v2', { archivedAt: 'x' }));
    sources.world('t1').employees.push(employee('e1'), employee('e2', { kind: 'other' }));
    sources.world('t1').incidents.push(incident('i1'));
    sources.world('t1').policies.push(policy('p1'));
    sources.world('t2').vehicles.push(vehicle('v9'));
    expect(await indexer.reconcile('t1')).toEqual({ written: 4, removed: 0, unchanged: 0 });
    expect((await keys(store, 't1')).map(([key]) => key).sort()).toEqual([
      'driver:e1',
      'incident:i1',
      'policy:p1',
      'vehicle:v1',
    ]);
    expect(await keys(store, 't2')).toEqual([]);
  });

  it('is idempotent and writes only what changed', async () => {
    const { sources, indexer } = setup();
    sources.world('t1').vehicles.push(vehicle('v1'), vehicle('v2'));
    await indexer.reconcile('t1');
    expect(await indexer.reconcile('t1')).toEqual({ written: 0, removed: 0, unchanged: 2 });
    sources.world('t1').vehicles[0] = vehicle('v1', { plate: 'NEW-1' });
    expect(await indexer.reconcile('t1')).toEqual({ written: 1, removed: 0, unchanged: 1 });
  });

  it('forgets what disappeared or became archived', async () => {
    const { store, sources, indexer } = setup();
    sources.world('t1').vehicles.push(vehicle('v1'), vehicle('v2'));
    await indexer.reconcile('t1');
    sources.world('t1').vehicles[0] = vehicle('v1', { archivedAt: '2026-10-02T00:00:00.000Z' });
    sources.world('t1').vehicles.pop();
    expect(await indexer.reconcile('t1')).toEqual({ written: 0, removed: 2, unchanged: 0 });
    expect(await keys(store, 't1')).toEqual([]);
  });

  it('rebuilds to the same rows an incremental run leaves', async () => {
    const a = setup();
    const b = setup();
    for (const { sources } of [a, b]) {
      sources.world('t1').vehicles.push(vehicle('v1'), vehicle('v2'));
      sources.world('t1').employees.push(employee('e1', { licenseIndex: 'c'.repeat(64) }));
    }
    await a.indexer.reconcile('t1');
    a.sources.world('t1').vehicles[0] = vehicle('v1', { plate: 'ZZZ-1' });
    await a.indexer.reconcile('t1');
    b.sources.world('t1').vehicles[0] = vehicle('v1', { plate: 'ZZZ-1' });
    expect(await b.indexer.rebuild('t1')).toEqual({ written: 3, removed: 0, unchanged: 0 });
    expect(await keys(b.store, 't1')).toEqual(await keys(a.store, 't1'));
  });

  it('reads every page of a large company', async () => {
    const { store, sources, indexer } = setup();
    for (let n = 0; n < 250; n += 1) sources.world('t1').vehicles.push(vehicle(`v${n}`));
    expect((await indexer.reconcile('t1')).written).toBe(250);
    expect((await keys(store, 't1')).length).toBe(250);
  });

  it('applies large changes in chunks', async () => {
    const { sources, indexer } = setup();
    for (let n = 0; n < 450; n += 1) sources.world('t1').vehicles.push(vehicle(`v${n}`));
    await indexer.reconcile('t1');
    sources.world('t1').vehicles.length = 0;
    expect((await indexer.reconcile('t1')).removed).toBe(450);
  });
});
