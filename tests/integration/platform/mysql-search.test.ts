import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformResponse } from '../../../apps/api/composition/src/index.js';
import type { SearchApiResponse } from '../../../apps/api/search/src/index.js';
import { TypeOrmSearchStore } from '../../../packages/persistence/search/src/index.js';
import {
  adminUrl,
  startSearchDatabase,
  type SearchDatabase,
} from '../../../packages/persistence/search/src/test-support/mysql.js';
import { corr, createWorld, type Session, type World } from './world.js';

/**
 * The platform on the real MySQL search projection (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL;
 * locally skipped when unset, a hard failure in CI). The other modules stay in memory: they are the
 * source of what is indexed. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const LICENSE = 'LIC-SEARCH-0001';
const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

suite('Platform on the real MySQL search projection', () => {
  let database: SearchDatabase;
  let world: World;
  let store: TypeOrmSearchStore;

  beforeAll(async () => {
    database = await startSearchDatabase('srch');
    store = new TypeOrmSearchStore(await database.openRuntime());
  });
  afterEach(() => world?.dispose());
  afterAll(async () => database?.close());

  async function company(name: string, tag: string) {
    const handle = await world.tenant(name, `subject-admin-${tag}`);
    const admin = handle.admin;
    const pii = await world.member(admin, 'pii_reader', `subject-pii-${tag}`);
    const viewer = await world.member(admin, 'viewer', `subject-viewer-${tag}`);
    const areaId = ok(await world.platform.areas.create(admin.token, corr(), { name: 'Flota' })).id;
    const vehicleId = ok(
      await world.platform.vehicles.create(admin.token, corr(), {
        economicNumber: 'U-100',
        plate: 'ABC-123',
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId,
        odometerKm: 10,
      }),
    ).id;
    const driverId = ok(
      await world.platform.employees.create(admin.token, corr(), {
        kind: 'driver',
        firstName: 'Ana',
        lastName: 'Pérez',
        areaId,
        employeeNumber: 'EMP-1',
        position: 'Conductor',
        hireDate: '2024-03-01',
        idType: 'ine',
        nationalId: 'INE-0000-1111',
        licenseType: 'c',
        licenseNumber: LICENSE,
        licenseExpiresOn: '2027-10-05',
      }),
    ).id;
    return { tenantId: handle.tenantId, admin, pii, viewer, vehicleId, driverId };
  }

  async function project(tenantId: string): Promise<void> {
    // The durable queue of MySQL is covered by the persistence suite; here the reconcile runs directly.
    await world.platform.search.indexer.reconcile(tenantId);
  }

  const idsOf = async (session: Session, q: string, type: string) => {
    const result = (await world.platform.search.api.search(session.token, corr(), {
      q,
    })) as Extract<SearchApiResponse, { ok: true }>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.value.groups.find((g) => g.type === type)?.items.map((i) => i.id);
  };

  it('finds, isolates tenants and matches PII only exactly through MySQL', async () => {
    world = createWorld({ adapters: { search: store } } as never);
    const a = await company('Empresa Alfa', 'a');
    const b = await company('Empresa Beta', 'b');
    await project(a.tenantId);
    await project(b.tenantId);
    for (const q of ['ÁBC-123', 'abc123', 'bc12'])
      expect(await idsOf(a.admin, q, 'vehicle'), q).toEqual([a.vehicleId]);
    expect(await idsOf(b.admin, 'abc123', 'vehicle')).toEqual([b.vehicleId]);
    expect(await idsOf(a.admin, 'perez', 'driver')).toEqual([a.driverId]);
    expect(await idsOf(a.pii, LICENSE, 'driver')).toEqual([a.driverId]);
    expect(await idsOf(a.pii, LICENSE.slice(0, 8), 'driver')).toEqual([]);
    expect(await idsOf(a.viewer, LICENSE, 'driver')).toEqual([]);
    const stored = JSON.stringify(
      await database.rows('SELECT * FROM opslog_search_entries WHERE company_id = ?', [a.tenantId]),
    );
    expect(stored).not.toContain(LICENSE);
    expect(stored).not.toContain('INE-0000');
  });

  it('keeps the same rows when the reconcile runs again and follows a change', async () => {
    world = createWorld({ adapters: { search: store } } as never);
    const a = await company('Empresa Gamma', 'g');
    await project(a.tenantId);
    const before = await store.fingerprints(a.tenantId);
    await project(a.tenantId);
    expect(await store.fingerprints(a.tenantId)).toEqual(before);
    const version = ok(
      await world.platform.vehicles.get(a.admin.token, corr(), a.vehicleId),
    ).version;
    ok(
      await world.platform.vehicles.update(a.admin.token, corr(), a.vehicleId, version, {
        plate: 'XYZ-987',
      }),
    );
    await project(a.tenantId);
    expect(await idsOf(a.admin, 'abc123', 'vehicle')).toEqual([]);
    expect(await idsOf(a.admin, 'xyz987', 'vehicle')).toEqual([a.vehicleId]);
  });
});
