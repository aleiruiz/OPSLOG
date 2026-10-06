import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TypeOrmAreaStore } from '../../../packages/persistence/areas/src/index.js';
import {
  adminUrl,
  startAreasDatabase,
  type AreasDatabase,
} from '../../../packages/persistence/areas/src/test-support/mysql.js';
import type { Vehicle, VehicleStatusEntry } from '../../../packages/domain/vehicles/src/index.js';
import { TypeOrmVehicleStore } from '../../../packages/persistence/vehicles/src/index.js';
import {
  startVehiclesDatabase,
  type VehiclesDatabase,
} from '../../../packages/persistence/vehicles/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL areas store, with the vehicles store also on MySQL so
 * the vehicle count port is exercised end to end (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL;
 * locally skipped when unset, a hard failure in CI). One process, one pool per store: two
 * signed-in sessions race over the same database. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const vehicle = (areaId: string, over: Record<string, unknown> = {}) => ({
  economicNumber: 'U-001',
  plate: 'ABC123',
  vin: null,
  make: 'Toyota',
  model: 'Hilux',
  year: 2022,
  areaId,
  odometerKm: 1000,
  ...over,
});

/** Hooks that hold a vehicle insert or an area resource count open, to interleave the two writers. */
const hooks: {
  insert: { entered: () => void; hold: Promise<void> } | null;
  count: { entered: () => void; hold: Promise<void> } | null;
} = { insert: null, count: null };

const latch = () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let entered: () => void = () => undefined;
  const wasEntered = new Promise<void>((resolve) => (entered = resolve));
  return { hold, release, entered, wasEntered };
};

const tick = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class HeldVehicleStore extends TypeOrmVehicleStore {
  public override async insert(next: Vehicle, entry: VehicleStatusEntry): Promise<void> {
    const held = hooks.insert;
    hooks.insert = null;
    if (held) {
      held.entered();
      await held.hold;
    }
    return super.insert(next, entry);
  }
}

const area = (name: string, parentId: string | null = null, code: string | null = null) => ({
  name,
  code,
  parentId,
  responsibleIds: [],
});

suite('BFF on real MySQL areas and vehicles stores', () => {
  let areasDb: AreasDatabase;
  let vehiclesDb: VehiclesDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminA2: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let editorA: Browser;
  let tenantA: string;
  let tenantB: string;

  const make = async (browser: Browser, name: string, parentId: string | null = null) => {
    const reply = await browser.post('/api/areas', { json: area(name, parentId) });
    expect(reply.status, name).toBe(201);
    return reply.json.id as string;
  };

  beforeAll(async () => {
    areasDb = await startAreasDatabase('plat');
    vehiclesDb = await startVehiclesDatabase('platv');
    const areas = new TypeOrmAreaStore(await areasDb.openRuntime());
    const vehicles = new HeldVehicleStore(await vehiclesDb.openRuntime());
    const tenants = new InMemoryTenantStore();
    const people = {
      countActive: async () => {
        const held = hooks.count;
        hooks.count = null;
        if (held) {
          held.entered();
          await held.hold;
        }
        return 0;
      },
    };
    world = createBffWorld({ adapters: { tenants, areas, vehicles, people } });
    tenantA = (await world.tenant('Empresa Alfa', 'subject-admin-a')).tenantId;
    tenantB = (await world.tenant('Empresa Beta', 'subject-admin-b')).tenantId;
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
    await world.member('subject-admin-a', 'editor', 'subject-editor-a');
    adminA = await world.loginAs('subject-admin-a');
    adminB = await world.loginAs('subject-admin-b');
    viewerA = await world.loginAs('subject-viewer-a');
    editorA = await world.loginAs('subject-editor-a');
    adminA2 = await world.loginAs('subject-admin-a');
  }, 120_000);

  afterEach(async () => {
    hooks.insert = null;
    hooks.count = null;
    for (const table of ['opslog_area_history', 'opslog_area_responsibles'])
      await areasDb.admin.query(`DELETE FROM ${table}`);
    // Children first: the parent key is a composite foreign key.
    for (const depth of [4, 3, 2, 1])
      await areasDb.admin.query('DELETE FROM opslog_areas WHERE depth = ?', [depth]);
    await vehiclesDb.admin.query('DELETE FROM opslog_vehicle_status_history');
    await vehiclesDb.admin.query('DELETE FROM opslog_vehicles');
  });

  afterAll(async () => {
    world?.dispose();
    await areasDb?.close();
    await vehiclesDb?.close();
  }, 60_000);

  it('runs the whole lifecycle and stores the company on every row', async () => {
    const root = await make(adminA, 'Operaciones');
    const child = await make(adminA, 'Norte', root);
    expect(
      (await adminA.put(`/api/areas/${child}`, { json: { version: 1, name: 'Norte 2' } })).json,
    ).toMatchObject({ name: 'Norte 2', version: 2 });
    const deactivated = await adminA.post(`/api/areas/${child}/deactivate`, {
      json: { version: 2 },
    });
    expect(deactivated.json).toMatchObject({ active: false, version: 3 });
    expect(
      (await adminA.post(`/api/areas/${child}/activate`, { json: { version: 3 } })).json,
    ).toMatchObject({ active: true, version: 4 });
    expect((await adminA.get(`/api/areas/${child}/history`)).json.total).toBe(4);
    expect((await adminA.get('/api/areas')).json.total).toBe(2);
    const rows = await areasDb.rows<{ company_id: string }>('SELECT company_id FROM opslog_areas');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.company_id === tenantA)).toBe(true);
    const history = await areasDb.rows<{ company_id: string }>(
      'SELECT company_id FROM opslog_area_history',
    );
    expect(history.every((row) => row.company_id === tenantA)).toBe(true);
  });

  it('reparents a subtree and rejects cycles and depth over four levels', async () => {
    const a = await make(adminA, 'A');
    const b = await make(adminA, 'B', a);
    const c = await make(adminA, 'C', b);
    const d = await make(adminA, 'D', c);
    const other = await make(adminA, 'Otra');
    const deep = await adminA.put(`/api/areas/${other}`, {
      json: { version: 1, parentId: d },
    });
    expect(deep).toMatchObject({ status: 422, json: { code: 'invalid_hierarchy' } });
    const cycle = await adminA.put(`/api/areas/${a}`, { json: { version: 1, parentId: d } });
    expect(cycle).toMatchObject({ status: 422, json: { code: 'invalid_hierarchy' } });
    const moved = await adminA.put(`/api/areas/${b}`, { json: { version: 1, parentId: other } });
    expect(moved.status).toBe(200);
    const depths = await areasDb.rows<{ id: string; depth: number }>(
      'SELECT id, depth FROM opslog_areas',
    );
    expect(Object.fromEntries(depths.map((row) => [row.id, Number(row.depth)]))).toEqual({
      [a]: 1,
      [other]: 1,
      [b]: 2,
      [c]: 3,
      [d]: 4,
    });
  });

  it('blocks deactivation with live vehicles on the vehicles store, then allows it', async () => {
    const id = await make(adminA, 'Flota');
    const v = await adminA.post('/api/vehicles', { json: vehicle(id) });
    expect(v.status).toBe(201);
    const blocked = await adminA.post(`/api/areas/${id}/deactivate`, { json: { version: 1 } });
    expect(blocked).toMatchObject({
      status: 409,
      json: { code: 'area_in_use', field: 'vehicles' },
    });
    expect((await adminA.get(`/api/areas/${id}`)).json.resourceCounts).toMatchObject({
      vehicles: 1,
    });
    await adminA.post(`/api/vehicles/${v.json.id}/status`, {
      json: { version: 1, status: 'decommissioned', reason: 'Baja' },
    });
    const ok = await adminA.post(`/api/areas/${id}/deactivate`, { json: { version: 1 } });
    expect(ok.status).toBe(200);
  });

  it('blocks deactivation with active sub-areas', async () => {
    const root = await make(adminA, 'Raiz');
    await make(adminA, 'Hija', root);
    const blocked = await adminA.post(`/api/areas/${root}/deactivate`, { json: { version: 1 } });
    expect(blocked).toMatchObject({
      status: 409,
      json: { code: 'area_in_use', field: 'sub_areas' },
    });
  });

  it('keeps tenants apart: another company gets 404, own keys do not collide', async () => {
    const id = (await adminA.post('/api/areas', { json: area('Norte', null, 'N1') })).json
      .id as string;
    const theirs = await adminB.post('/api/areas', { json: area('Norte', null, 'N1') });
    expect(theirs.status).toBe(201);
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const [method, path, json] of [
      ['GET', `/api/areas/${id}`],
      ['GET', `/api/areas/${id}/history`],
      ['PUT', `/api/areas/${id}`, { version: 1, name: 'Robada' }],
      ['POST', `/api/areas/${id}/deactivate`, { version: 1 }],
      ['POST', `/api/areas/${id}/activate`, { version: 1 }],
    ] as [string, string, unknown?][]) {
      const foreign = await adminB.send(method, path, { json });
      const absent = await adminB.send(method, path.replace(id, unknown), { json });
      expect(foreign.status, path).toBe(404);
      expect({ ...foreign.json, correlationId: '' }).toEqual({ ...absent.json, correlationId: '' });
    }
    const asParent = await adminB.post('/api/areas', { json: area('Intrusa', id) });
    expect(asParent).toMatchObject({ status: 422, json: { code: 'invalid_hierarchy' } });
    expect((await adminA.get(`/api/areas/${id}`)).json).toMatchObject({
      name: 'Norte',
      version: 1,
    });
    const counts = await areasDb.rows<{ company_id: string; n: number }>(
      'SELECT company_id, COUNT(*) AS n FROM opslog_areas GROUP BY company_id',
    );
    expect(Object.fromEntries(counts.map((row) => [row.company_id, Number(row.n)]))).toEqual({
      [tenantA]: 1,
      [tenantB]: 1,
    });
  });

  it('denies roles without the permission and leaves the rows untouched', async () => {
    const id = await make(adminA, 'Norte');
    for (const [method, path, json] of [
      ['POST', '/api/areas', area('Nueva')],
      ['PUT', `/api/areas/${id}`, { version: 1, name: 'x' }],
      ['POST', `/api/areas/${id}/deactivate`, { version: 1 }],
    ] as [string, string, unknown][])
      expect((await viewerA.send(method, path, { json })).status, `viewer ${path}`).toBe(403);
    expect(
      (await editorA.post(`/api/areas/${id}/deactivate`, { json: { version: 1 } })).status,
    ).toBe(403);
    expect((await viewerA.get(`/api/areas/${id}`)).json).toMatchObject({
      name: 'Norte',
      version: 1,
    });
  });

  it('enforces unique sibling names and codes against the database', async () => {
    await adminA.post('/api/areas', { json: area('Norte', null, 'N1') });
    const dupName = await adminA.post('/api/areas', { json: area('norte') });
    expect(dupName).toMatchObject({ status: 409, json: { code: 'duplicate', field: 'name' } });
    const dupCode = await adminA.post('/api/areas', { json: area('Sur', null, 'n1') });
    expect(dupCode).toMatchObject({ status: 409, json: { code: 'duplicate', field: 'code' } });
  });

  it('lets exactly one of two concurrent writers win, from two sessions', async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await make(adminA, `R${round}`);
      const replies = await Promise.all([
        adminA.put(`/api/areas/${id}`, { json: { version: 1, name: `Uno${round}` } }),
        adminA2.put(`/api/areas/${id}`, { json: { version: 1, name: `Dos${round}` } }),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.json.code).toBe('stale_version');
      expect((await adminA.get(`/api/areas/${id}`)).json.version).toBe(2);
    }
  });

  it('serializes a subtree move against an insert inside it: never exceeds four levels', async () => {
    for (let round = 0; round < 3; round += 1) {
      const x = await make(adminA, `X${round}`);
      const y = await make(adminA, `Y${round}`, x);
      const z = await make(adminA, `Z${round}`, y);
      const target = await make(adminA, `T${round}`);
      const t2 = await make(adminA, `T2${round}`, target);
      await Promise.all([
        adminA.put(`/api/areas/${x}`, { json: { version: 1, parentId: t2 } }),
        adminA2.post('/api/areas', { json: area(`W${round}`, z) }),
      ]);
      const rows = await areasDb.rows<{ depth: number }>('SELECT depth FROM opslog_areas');
      expect(Math.max(...rows.map((row) => Number(row.depth)))).toBeLessThanOrEqual(4);
    }
  });

  describe('vehicle area validation (BR-021)', () => {
    const vehicleRows = () =>
      vehiclesDb.rows<{ area_id: string }>('SELECT area_id FROM opslog_vehicles');
    const inactiveAreas = async () =>
      new Set(
        (await areasDb.rows<{ id: string }>('SELECT id FROM opslog_areas WHERE active = 0')).map(
          (row) => row.id,
        ),
      );
    const withoutCorrelation = (reply: { json: object }) => ({
      ...reply.json,
      correlationId: '',
    });

    it('answers the same field-level 422 for unknown, foreign and inactive areas, writing no row', async () => {
      const closed = await make(adminA, 'Cerrada');
      await adminA.post(`/api/areas/${closed}/deactivate`, { json: { version: 1 } });
      const foreign = await make(adminB, 'Ajena');
      const replies = [];
      for (const areaId of ['desconocida', foreign, closed])
        replies.push(await adminA.post('/api/vehicles', { json: vehicle(areaId) }));
      for (const reply of replies)
        expect(reply).toMatchObject({
          status: 422,
          json: { code: 'invalid_area', field: 'area_id' },
        });
      expect(new Set(replies.map((reply) => JSON.stringify(withoutCorrelation(reply)))).size).toBe(
        1,
      );
      expect(await vehicleRows()).toEqual([]);

      const home = await make(adminA, 'Base');
      const car = await adminA.post('/api/vehicles', { json: vehicle(home) });
      expect(car.status).toBe(201);
      for (const areaId of ['desconocida', foreign, closed]) {
        const moved = await adminA.put(`/api/vehicles/${car.json.id}`, {
          json: { version: 1, areaId },
        });
        expect(moved, areaId).toMatchObject({ status: 422, json: { code: 'invalid_area' } });
      }
      expect((await vehicleRows()).map((row) => row.area_id)).toEqual([home]);
      expect((await adminA.get(`/api/vehicles/${car.json.id}`)).json.version).toBe(1);
      // The foreign area was never touched.
      expect((await adminB.get(`/api/areas/${foreign}`)).json.resourceCounts.vehicles).toBe(0);
    });

    it('keeps a vehicle whose area is unchanged even when that area is inactive', async () => {
      const home = await make(adminA, 'Base');
      const other = await make(adminA, 'Otra');
      const car = await adminA.post('/api/vehicles', { json: vehicle(home) });
      // Legacy row: the area is inactive although a vehicle is still there (administration SQL).
      await areasDb.admin.query(
        'UPDATE opslog_areas SET active = 0, deactivated_at = NOW(3) WHERE id = ?',
        [home],
      );
      const kept = await adminA.put(`/api/vehicles/${car.json.id}`, {
        json: { version: 1, make: 'Ford', areaId: home },
      });
      expect(kept).toMatchObject({ status: 200, json: { make: 'Ford', areaId: home } });
      // It can leave for an active area, and cannot come back.
      expect(
        (await adminA.put(`/api/vehicles/${car.json.id}`, { json: { version: 2, areaId: other } }))
          .status,
      ).toBe(200);
      expect(
        (await adminA.put(`/api/vehicles/${car.json.id}`, { json: { version: 3, areaId: home } }))
          .status,
      ).toBe(422);
    });

    it('holds the deactivation until an in-flight vehicle assignment commits, then refuses it', async () => {
      const home = await make(adminA, 'Base');
      const insert = latch();
      hooks.insert = { entered: insert.entered, hold: insert.hold };
      const create = adminA.post('/api/vehicles', { json: vehicle(home) });
      await insert.wasEntered; // area checked, insert pending under the tenant area lock
      const deactivate = adminA2.post(`/api/areas/${home}/deactivate`, { json: { version: 1 } });
      let settled = false;
      void deactivate.then(() => (settled = true));
      await tick();
      expect(settled).toBe(false);
      insert.release();
      const [created, deactivated] = await Promise.all([create, deactivate]);
      expect(created.status).toBe(201);
      expect(deactivated).toMatchObject({
        status: 409,
        json: { code: 'area_in_use', field: 'vehicles' },
      });
      expect((await adminA.get(`/api/areas/${home}`)).json.active).toBe(true);
    });

    it('holds a vehicle assignment until an in-flight deactivation commits, then refuses it', async () => {
      const home = await make(adminA, 'Base');
      const counting = latch();
      hooks.count = { entered: counting.entered, hold: counting.hold };
      const deactivate = adminA.post(`/api/areas/${home}/deactivate`, { json: { version: 1 } });
      await counting.wasEntered; // under the tenant area lock, counting resources
      const create = adminA2.post('/api/vehicles', { json: vehicle(home) });
      let settled = false;
      void create.then(() => (settled = true));
      await tick();
      expect(settled).toBe(false);
      counting.release();
      const [deactivated, created] = await Promise.all([deactivate, create]);
      expect(deactivated.status).toBe(200);
      expect(created).toMatchObject({ status: 422, json: { code: 'invalid_area' } });
      expect(await vehicleRows()).toEqual([]);
    });

    it('exactly one of a concurrent assignment and deactivation wins; an inactive area never holds a vehicle', async () => {
      let assigned = 0;
      let closed = 0;
      for (let round = 0; round < 12; round += 1) {
        const home = await make(adminA, `Carrera ${round}`);
        const create = () =>
          adminA.post('/api/vehicles', {
            json: vehicle(home, { economicNumber: `R-${round}`, plate: `R${round}` }),
          });
        const deactivate = () =>
          adminA2.post(`/api/areas/${home}/deactivate`, { json: { version: 1 } });
        const results =
          round % 2 === 0
            ? await Promise.all([create(), deactivate()])
            : (await Promise.all([deactivate(), create()])).reverse();
        const created = results[0]!;
        const deactivated = results[1]!;
        const oneWon = (created.status === 201) !== (deactivated.status === 200);
        expect(oneWon, `round ${round}: ${created.status}/${deactivated.status}`).toBe(true);
        if (created.status === 201) {
          assigned += 1;
          expect(deactivated).toMatchObject({ status: 409, json: { code: 'area_in_use' } });
        } else {
          closed += 1;
          expect(created).toMatchObject({ status: 422, json: { code: 'invalid_area' } });
        }
      }
      expect(assigned + closed).toBe(12);
      const inactive = await inactiveAreas();
      for (const row of await vehicleRows()) expect(inactive.has(row.area_id)).toBe(false);
    });
  });
});
