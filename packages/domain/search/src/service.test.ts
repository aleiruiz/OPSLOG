import { describe, expect, it } from 'vitest';
import { SearchIndexer } from './indexer.js';
import { InMemorySearchStore } from './memory-store.js';
import { SearchError } from './errors.js';
import { isOpaqueJobId, parseReconcilePayload } from './events.js';
import { SearchService, searchHref, typeAccess } from './service.js';
import { employee, FakeSources, incident, policy, vehicle } from './test-support.js';
import type { Searcher } from './types.js';

const LICENSE_A = 'a'.repeat(64);
const who = (permissions: string[], mechanicLinked = false): Searcher => ({
  permissions: new Set(permissions),
  mechanicLinked,
});
const ALL = who(['view', 'view_pii', 'incidents:view']);

async function world() {
  const store = new InMemorySearchStore();
  const sources = new FakeSources();
  const a = sources.world('A');
  a.vehicles.push(vehicle('v1'), vehicle('v2', { plate: 'KLM-900', economicNumber: 'U-2' }));
  a.employees.push(
    employee('e1', { licenseIndex: LICENSE_A, nationalIdIndex: 'd'.repeat(64) }),
    employee('e2', { kind: 'dispatcher', firstName: 'Luis', lastName: 'Gómez' }),
  );
  a.incidents.push(incident('i1', { claimNumber: 'CLM-55' }));
  a.policies.push(policy('p1'));
  // The same plate, folio and name in company B.
  const b = sources.world('B');
  b.vehicles.push(vehicle('b-v1'));
  b.employees.push(employee('b-e1'));
  b.incidents.push(incident('i1'));
  const indexer = new SearchIndexer(store, sources);
  await indexer.reconcile('A');
  await indexer.reconcile('B');
  const exact = new Map<string, string[]>([['LIC-0001', [LICENSE_A]]]);
  return new SearchService(store, async (_tenant, raw) => exact.get(raw) ?? []);
}

const ids = (result: Awaited<ReturnType<SearchService['search']>>, type: string) =>
  result.groups.find((g) => g.type === type)?.items.map((i) => i.id);

describe('SearchService', () => {
  it('finds with the tolerance of BRD 14.1', async () => {
    const search = await world();
    for (const q of ['ÁBC-123', 'abc123', 'abc 1', 'bc12', 'ABC.123'])
      expect(ids(await search.search('A', ALL, q), 'vehicle')).toContain('v1');
    expect(ids(await search.search('A', ALL, 'Pérez'), 'driver')).toEqual(['e1']);
    expect(ids(await search.search('A', ALL, 'perez'), 'driver')).toEqual(['e1']);
    expect(ids(await search.search('A', ALL, 'Gómez Luis'), 'dispatcher')).toEqual(['e2']);
  });

  it('keeps the companies apart', async () => {
    const search = await world();
    const a = await search.search('A', ALL, 'abc123');
    const b = await search.search('B', ALL, 'abc123');
    expect(ids(a, 'vehicle')).toEqual(['v1']);
    expect(ids(b, 'vehicle')).toEqual(['b-v1']);
    expect(ids(await search.search('C', ALL, 'abc123'), 'vehicle')).toEqual([]);
  });

  it('gives each hit the link of its detail and groups with totals', async () => {
    const search = await world();
    const result = await search.search('A', ALL, 'a');
    const links = Object.fromEntries(result.groups.map((g) => [g.type, g.items[0]?.href ?? null]));
    expect(links['vehicle']).toBe('/flota/vehiculos/v1');
    expect(links['driver']).toBe('/plantilla/empleados/e1');
    expect(links['policy']).toBeNull();
    expect(searchHref('policy', 'p 1')).toBe('/flota/seguros/p%201');
    expect(searchHref('incident', 'i1')).toBe('/incidents/i1');
    expect(searchHref('dispatcher', 'e2')).toBe('/plantilla/empleados/e2');
    expect(result.groups.find((g) => g.type === 'vehicle')?.total).toBe(1);
    const both = await search.search('A', ALL, 'u');
    expect(both.groups.find((g) => g.type === 'vehicle')?.total).toBe(1);
  });

  it('finds incidents by folio and claim number only for incident viewers', async () => {
    const search = await world();
    expect(ids(await search.search('A', ALL, 'SIN-2026-i1'), 'incident')).toEqual(['i1']);
    expect(ids(await search.search('A', ALL, 'clm55'), 'incident')).toEqual(['i1']);
    const noIncidents = await search.search('A', who(['view']), 'clm55');
    expect(noIncidents.groups.map((g) => g.type)).not.toContain('incident');
    const mechanic = await search.search('A', who(['view', 'incidents:view'], true), 'clm55');
    expect(mechanic.groups.map((g) => g.type)).not.toContain('incident');
  });

  it('shows no group at all to a reader without view', async () => {
    const search = await world();
    expect((await search.search('A', who([]), 'abc')).groups).toEqual([]);
    expect(
      (await search.search('A', who(['incidents:view']), 'abc')).groups.map((g) => g.type),
    ).toEqual(['incident']);
  });

  it('matches a license only exactly and only with view_pii', async () => {
    const search = await world();
    expect(ids(await search.search('A', ALL, 'LIC-0001'), 'driver')).toEqual(['e1']);
    expect(ids(await search.search('A', ALL, 'LIC-00'), 'driver')).toEqual([]);
    expect(ids(await search.search('A', ALL, LICENSE_A.slice(0, 20)), 'driver')).toEqual([]);
    const noPii = who(['view', 'incidents:view']);
    expect(ids(await search.search('A', noPii, 'LIC-0001'), 'driver')).toEqual([]);
    // Another company never matches the same value.
    expect(ids(await search.search('B', ALL, 'LIC-0001'), 'driver')).toEqual([]);
  });

  it('restricts the answer to the types asked for', async () => {
    const search = await world();
    const result = await search.search('A', ALL, 'a', ['vehicle']);
    expect(result.groups.map((g) => g.type)).toEqual(['vehicle']);
  });

  it('returns empty groups for a term with nothing to search', async () => {
    const search = await world();
    const result = await search.search('A', ALL, ' -- ');
    expect(result.groups.every((g) => g.total === 0 && g.items.length === 0)).toBe(true);
    expect(result.groups).toHaveLength(5);
  });

  it('finds by prefix when the term is shorter than three characters', async () => {
    const search = await world();
    expect(ids(await search.search('A', ALL, 'ab'), 'vehicle')).toEqual(['v1']);
    expect(ids(await search.search('A', ALL, 'bc'), 'vehicle')).toEqual([]);
  });

  it('ranks an exact key before a prefix and a prefix before a contains', async () => {
    const store = new InMemorySearchStore();
    const sources = new FakeSources();
    sources
      .world('A')
      .vehicles.push(
        vehicle('v1', { plate: 'XABC1', economicNumber: 'U1' }),
        vehicle('v2', { plate: 'ABC1X', economicNumber: 'U2' }),
        vehicle('v3', { plate: 'ABC1', economicNumber: 'U3' }),
      );
    await new SearchIndexer(store, sources).reconcile('A');
    const search = new SearchService(store, async () => []);
    expect(ids(await search.search('A', ALL, 'abc1'), 'vehicle')).toEqual(['v3', 'v2', 'v1']);
  });

  it('rejects input that is not a search', async () => {
    const search = await world();
    await expect(search.search('A', ALL, 12)).rejects.toBeInstanceOf(SearchError);
    await expect(search.search('A', ALL, 'abc', ['nope'])).rejects.toBeInstanceOf(SearchError);
  });
});

describe('typeAccess', () => {
  it('adds the exact PII rows to people only with view_pii', () => {
    expect(typeAccess('driver', who(['view']))?.permissions).toEqual(['view']);
    expect(typeAccess('driver', who(['view', 'view_pii']))?.permissions).toEqual([
      'view',
      'view_pii',
    ]);
    expect(typeAccess('vehicle', who(['view', 'view_pii']))?.permissions).toEqual(['view']);
    expect(typeAccess('vehicle', who([]))).toBeNull();
  });
});

describe('reconcile payload', () => {
  it('accepts an empty payload or the full flag and nothing else', () => {
    expect(parseReconcilePayload({})).toEqual({ full: false });
    expect(parseReconcilePayload({ full: true })).toEqual({ full: true });
    for (const bad of [null, [], 'x', { tenantId: 't' }, { full: 'yes' }])
      expect(() => parseReconcilePayload(bad)).toThrow(/invalid search reconcile job/);
    expect(isOpaqueJobId('abc-1')).toBe(true);
    expect(isOpaqueJobId('a b')).toBe(false);
    expect(isOpaqueJobId(5)).toBe(false);
  });
});
