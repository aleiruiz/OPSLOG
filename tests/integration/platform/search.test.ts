import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformResponse } from '../../../apps/api/composition/src/index.js';
import type { SearchApiResponse } from '../../../apps/api/search/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const LICENSE = 'LIC-SEARCH-0001';
const INCIDENT = {
  type: 'other',
  severity: 'low',
  occurredAt: '2026-10-06T10:00:00.000Z',
  location: { text: 'Calle Sintética' },
  description: 'Descripción sintética',
  vehicleOperable: true,
  noDriverReason: 'Vehículo estacionado',
  noPhotoJustification: 'Sin foto disponible',
};

interface Company {
  readonly tenantId: string;
  readonly admin: Session;
  readonly viewer: Session;
  readonly pii: Session;
  readonly manager: Session;
  readonly areaId: string;
  readonly vehicleId: string;
  readonly driverId: string;
  readonly policyId: string;
  readonly incidentId: string;
}

/** The same plate, folio-bearing incident and person name in every company: only the ids differ. */
async function company(w: World, name: string, tag: string): Promise<Company> {
  const handle = await w.tenant(name, `subject-admin-${tag}`);
  const admin = handle.admin;
  const viewer = await w.member(admin, 'viewer', `subject-viewer-${tag}`);
  const pii = await w.member(admin, 'pii_reader', `subject-pii-${tag}`);
  const manager = await w.member(admin, 'incident_manager', `subject-manager-${tag}`);
  const areaId = ok(await w.platform.areas.create(admin.token, corr(), { name: 'Flota' })).id;
  const vehicleId = ok(
    await w.platform.vehicles.create(admin.token, corr(), {
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
    await w.platform.employees.create(admin.token, corr(), {
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
  const policyId = ok(
    await w.platform.insurance.create(admin.token, corr(), {
      vehicleId,
      insurer: 'Aseguradora Ficticia',
      policyNumber: 'POL-001',
      coverageType: 'third_party',
      startsOn: '2026-01-01',
      endsOn: '2027-01-01',
    }),
  ).id;
  const incidentId = ok(
    await w.platform.incidents.create(manager.token, corr(), { ...INCIDENT, vehicleId }),
  ).id;
  return {
    tenantId: handle.tenantId,
    admin,
    viewer,
    pii,
    manager,
    areaId,
    vehicleId,
    driverId,
    policyId,
    incidentId,
  };
}

/**
 * Queues a reconcile of the company and lets the worker consume it, as the periodic job does. A
 * job is one per company and minute, so the clock moves past the window first.
 */
async function project(w: World, tenantId: string, full = false): Promise<void> {
  w.advance(61_000);
  await w.platform.search.enqueueReconcile(tenantId, full);
  await w.platform.runtime.drainOutbox();
}

const find = async (session: Session, q: string, types?: readonly string[]) => {
  const result = await world.platform.search.api.search(session.token, corr(), {
    q,
    ...(types ? { types } : {}),
  });
  return result;
};
const groupsOf = async (session: Session, q: string) => {
  const result = (await find(session, q)) as Extract<SearchApiResponse, { ok: true }>;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.value.groups;
};
const idsOf = async (session: Session, q: string, type: string) =>
  (await groupsOf(session, q)).find((g) => g.type === type)?.items.map((i) => i.id);

async function twoCompanies() {
  world = createWorld();
  const a = await company(world, 'Empresa Alfa', 'a');
  const b = await company(world, 'Empresa Beta', 'b');
  await project(world, a.tenantId);
  await project(world, b.tenantId);
  return { a, b };
}

describe('global search through the platform', () => {
  it('finds with the tolerance of BRD 14.1 and links each hit to its detail (acceptance 4, 7)', async () => {
    const { a } = await twoCompanies();
    for (const q of ['ÁBC-123', 'abc123', 'abc 1', 'bc12'])
      expect(await idsOf(a.admin, q, 'vehicle'), q).toEqual([a.vehicleId]);
    expect(await idsOf(a.admin, 'Pérez', 'driver')).toEqual([a.driverId]);
    expect(await idsOf(a.admin, 'perez', 'driver')).toEqual([a.driverId]);
    const groups = await groupsOf(a.admin, 'a');
    const link = (type: string) => groups.find((g) => g.type === type)?.items[0]?.href;
    expect(link('vehicle')).toBe(`/flota/vehiculos/${a.vehicleId}`);
    expect(link('driver')).toBe(`/plantilla/empleados/${a.driverId}`);
    expect(
      (await groupsOf(a.admin, 'pol001')).find((g) => g.type === 'policy')?.items[0]?.href,
    ).toBe(`/flota/seguros/${a.policyId}`);
    const incident = (await groupsOf(a.admin, 'sin')).find((g) => g.type === 'incident');
    expect(incident?.items[0]?.href).toBe(`/incidents/${a.incidentId}`);
    expect(incident?.total).toBe(1);
  });

  it('shows a company only its own results for equal plates and names (acceptance 1)', async () => {
    const { a, b } = await twoCompanies();
    expect(await idsOf(a.admin, 'abc123', 'vehicle')).toEqual([a.vehicleId]);
    expect(await idsOf(b.admin, 'abc123', 'vehicle')).toEqual([b.vehicleId]);
    expect(await idsOf(b.admin, 'perez', 'driver')).toEqual([b.driverId]);
    expect(a.vehicleId).not.toBe(b.vehicleId);
    // A foreign id is never reachable by searching for it.
    expect(await idsOf(a.admin, b.vehicleId, 'vehicle')).toEqual([]);
  });

  it('hides the groups and counts the reader may not see (acceptance 2)', async () => {
    const { a } = await twoCompanies();
    const types = async (session: Session) => (await groupsOf(session, 'a')).map((g) => g.type);
    expect(await types(a.admin)).toEqual(['vehicle', 'driver', 'dispatcher', 'incident', 'policy']);
    expect(await types(a.viewer)).toContain('incident');
    // `pii_reader` has no `incidents:view`: no incident group and no count.
    expect(await types(a.pii)).toEqual(['vehicle', 'driver', 'dispatcher', 'policy']);
    expect(JSON.stringify(await groupsOf(a.pii, 'sin'))).not.toContain('incident');
  });

  it('fails closed for a member linked to a mechanic (SPECS D9)', async () => {
    const { a } = await twoCompanies();
    const workshop = await world.platform.maintenance.createWorkshop(a.admin.token, corr(), {
      name: 'Taller Sintético',
      specialties: ['frenos'],
    });
    const mechanic = await world.platform.maintenance.createMechanic(a.admin.token, corr(), {
      name: 'Mecánico Sintético',
      specialties: ['frenos'],
      kind: 'internal',
      workshopId: ok(workshop).id,
      memberId: a.viewer.identityId,
    });
    expect(mechanic.ok, JSON.stringify(mechanic)).toBe(true);
    const types = (await groupsOf(a.viewer, 'a')).map((g) => g.type);
    expect(types).not.toContain('incident');
    expect(types).toContain('vehicle');
    // Another member with the same role and no mechanic record still sees incidents.
    expect((await groupsOf(a.manager, 'a')).map((g) => g.type)).toContain('incident');
  });

  it('matches a license only exactly and only with view_pii, and never returns it (acceptance 3)', async () => {
    const { a, b } = await twoCompanies();
    expect(await idsOf(a.pii, LICENSE, 'driver')).toEqual([a.driverId]);
    expect(await idsOf(a.pii, 'lic-search', 'driver')).toEqual([]);
    expect(await idsOf(a.pii, LICENSE.slice(0, 8), 'driver')).toEqual([]);
    expect(await idsOf(a.admin, 'INE-0000-1111', 'driver')).toEqual([a.driverId]);
    expect(await idsOf(a.viewer, LICENSE, 'driver')).toEqual([]);
    expect(await idsOf(a.manager, LICENSE, 'driver')).toEqual([]);
    expect(await idsOf(b.admin, LICENSE, 'driver')).toEqual([b.driverId]);
    // The company's own blind index differs: A's reader never matches B's person by it.
    const raw = JSON.stringify(await groupsOf(a.pii, LICENSE));
    expect(raw).not.toContain(LICENSE);
    expect(raw).not.toContain('INE-0000');
    const stored = JSON.stringify([
      ...(await world.platform.search.store.fingerprints(a.tenantId)),
    ]);
    expect(stored).not.toContain(LICENSE);
  });

  it('forgets an old plate once the change is reconciled, without duplicating rows (acceptance 5)', async () => {
    const { a } = await twoCompanies();
    const version = ok(
      await world.platform.vehicles.get(a.admin.token, corr(), a.vehicleId),
    ).version;
    ok(
      await world.platform.vehicles.update(a.admin.token, corr(), a.vehicleId, version, {
        plate: 'XYZ-987',
      }),
    );
    // Not yet: the projection follows the next reconcile.
    expect(await idsOf(a.admin, 'abc123', 'vehicle')).toEqual([a.vehicleId]);
    await project(world, a.tenantId);
    expect(await idsOf(a.admin, 'abc123', 'vehicle')).toEqual([]);
    expect(await idsOf(a.admin, 'xyz987', 'vehicle')).toEqual([a.vehicleId]);
    const before = await world.platform.search.store.fingerprints(a.tenantId);
    // The same reconcile again leaves the same rows.
    await project(world, a.tenantId);
    expect(await world.platform.search.store.fingerprints(a.tenantId)).toEqual(before);
  });

  it('rebuilds to the same projection as the incremental runs (acceptance 6)', async () => {
    const { a } = await twoCompanies();
    const version = ok(
      await world.platform.vehicles.get(a.admin.token, corr(), a.vehicleId),
    ).version;
    ok(
      await world.platform.vehicles.update(a.admin.token, corr(), a.vehicleId, version, {
        plate: 'NEW-555',
      }),
    );
    await project(world, a.tenantId);
    const incremental = await world.platform.search.store.fingerprints(a.tenantId);
    // A restore emptied the projection: the full rebuild brings it back.
    await world.platform.search.store.apply(a.tenantId, {
      upserts: [],
      removals: [...incremental.keys()].map((key) => ({
        entityType: key.split(':')[0] as 'vehicle',
        entityId: key.slice(key.indexOf(':') + 1),
      })),
    });
    expect((await world.platform.search.store.fingerprints(a.tenantId)).size).toBe(0);
    await world.platform.search.indexer.rebuild(a.tenantId);
    expect(await world.platform.search.store.fingerprints(a.tenantId)).toEqual(incremental);
  });

  it('refuses a request without a session and a malformed one', async () => {
    const { a } = await twoCompanies();
    const anonymous = await world.platform.search.api.search('not-a-token', corr(), { q: 'abc' });
    expect(anonymous).toMatchObject({ ok: false, error: { status: 401 } });
    const bad = await find(a.admin, 'abc', ['nope']);
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input', status: 400 } });
    const empty = await groupsOf(a.admin, ' -- ');
    expect(empty.every((g) => g.total === 0)).toBe(true);
  });

  it('stops serving a suspended company', async () => {
    const { a } = await twoCompanies();
    await world.platform.suspendTenant(a.tenantId);
    expect(await find(a.admin, 'abc')).toMatchObject({ ok: false });
  });
});
