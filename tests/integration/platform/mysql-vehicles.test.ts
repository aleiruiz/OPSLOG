import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TypeOrmVehicleStore } from '../../../packages/persistence/vehicles/src/index.js';
import { createMySqlAuditRuntime } from '../../../packages/persistence/audit/src/index.js';
import {
  adminUrl,
  startVehiclesDatabase,
  type VehiclesDatabase,
} from '../../../packages/persistence/vehicles/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL vehicles store (CI: mysql service,
 * OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset, a hard failure in CI). One process and one pool: two signed-in sessions race over the same database. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

/** Real, active areas of each company (set up once; the in-memory area store is not reset). */
const areas = { a: '', b: '' };

const input = (over: Record<string, unknown> = {}) => ({
  economicNumber: 'U-001',
  plate: 'ABC123',
  vin: null,
  make: 'Toyota',
  model: 'Hilux',
  year: 2022,
  areaId: areas.a,
  odometerKm: 1000,
  ...over,
});

suite('BFF on a real MySQL vehicles store', () => {
  let database: VehiclesDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let editorA: Browser;
  let adminA2: Browser;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    database = await startVehiclesDatabase('plat');
    const source = await database.openRuntime();
    const store = new TypeOrmVehicleStore(source);
    // One process, one pool; the concurrency tests use two sessions of it.
    const tenants = new InMemoryTenantStore();
    const auditRuntime = createMySqlAuditRuntime({
      listTenantIds: () => tenants.all().map((tenant) => tenant.id),
      resolveRuntime: () => source,
      resolveRelay: () => source,
      resolveReader: () => source,
    });
    world = createBffWorld({
      adapters: {
        tenants,
        vehicles: store,
        audit: auditRuntime.audit,
        auditRelay: auditRuntime.auditRelay,
        outbox: auditRuntime.outbox,
      },
    });
    tenantA = (await world.tenant('Empresa Alfa', 'subject-admin-a')).tenantId;
    tenantB = (await world.tenant('Empresa Beta', 'subject-admin-b')).tenantId;
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
    await world.member('subject-admin-a', 'editor', 'subject-editor-a');
    adminA = await world.loginAs('subject-admin-a');
    adminB = await world.loginAs('subject-admin-b');
    viewerA = await world.loginAs('subject-viewer-a');
    editorA = await world.loginAs('subject-editor-a');
    // A second session of the same administrator (same process, same pool).
    adminA2 = await world.loginAs('subject-admin-a');
    areas.a = (await adminA.post('/api/areas', { json: { name: 'Area 1' } })).json.id as string;
    areas.b = (await adminB.post('/api/areas', { json: { name: 'Area 1' } })).json.id as string;
  }, 120_000);

  afterEach(async () => {
    await database.admin.query('DELETE FROM opslog_vehicle_status_history');
    await database.admin.query('DELETE FROM opslog_vehicles');
  });

  afterAll(async () => {
    world?.dispose();
    await database?.close();
  }, 60_000);

  it('runs the whole lifecycle and stores the company on every row', async () => {
    const created = await adminA.post('/api/vehicles', { json: input() });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json).not.toHaveProperty('tenantId');
    expect(
      (await adminA.put(`/api/vehicles/${id}`, { json: { version: 1, make: 'Ford' } })).json,
    ).toMatchObject({ make: 'Ford', version: 2 });
    expect(
      (
        await adminA.post(`/api/vehicles/${id}/status`, {
          json: { version: 2, status: 'in_maintenance', reason: 'Servicio' },
        })
      ).json,
    ).toMatchObject({ status: 'in_maintenance', version: 3 });
    expect(
      (
        await adminA.post(`/api/vehicles/${id}/odometer`, {
          json: { version: 3, odometerKm: 1500 },
        })
      ).json.odometerKm,
    ).toBe(1500);
    expect((await adminA.get(`/api/vehicles/${id}/history`)).json.items).toHaveLength(2);
    expect(
      (await adminA.post(`/api/vehicles/${id}/archive`, { json: { version: 4 } })).status,
    ).toBe(200);
    const rows = await database.rows<{ company_id: string; archived_at: unknown }>(
      'SELECT company_id, archived_at FROM opslog_vehicles',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company_id).toBe(tenantA);
    expect(rows[0]?.archived_at).not.toBeNull();
    const history = await database.rows<{ company_id: string }>(
      'SELECT company_id FROM opslog_vehicle_status_history',
    );
    expect(history.every((row) => row.company_id === tenantA)).toBe(true);
  });

  it('keeps tenants apart: another company gets 404, own keys do not collide with foreign ones', async () => {
    const mine = await adminA.post('/api/vehicles', { json: input({ vin: '1HGCM82633A004352' }) });
    const id = mine.json.id as string;
    // The same economic number, plate and VIN are free in another company (no existence oracle).
    const theirs = await adminB.post('/api/vehicles', {
      json: input({ vin: '1HGCM82633A004352', areaId: areas.b }),
    });
    expect(theirs.status).toBe(201);
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const [method, path, json] of [
      ['GET', `/api/vehicles/${id}`],
      ['GET', `/api/vehicles/${id}/history`],
      ['PUT', `/api/vehicles/${id}`, { version: 1, make: 'Robado' }],
      ['POST', `/api/vehicles/${id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/vehicles/${id}/odometer`, { version: 1, odometerKm: 9999 }],
      ['POST', `/api/vehicles/${id}/archive`, { version: 1 }],
    ] as [string, string, unknown?][]) {
      const foreign = await adminB.send(method, path, { json });
      const absent = await adminB.send(method, path.replace(id, unknown), { json });
      expect(foreign.status, path).toBe(404);
      expect({ ...foreign.json, correlationId: '' }).toEqual({ ...absent.json, correlationId: '' });
    }
    expect((await adminA.get(`/api/vehicles/${id}`)).json).toMatchObject({
      make: 'Toyota',
      version: 1,
    });
    expect((await adminA.get('/api/vehicles')).json.total).toBe(1);
    expect((await adminB.get('/api/vehicles')).json.total).toBe(1);
    const counts = await database.rows<{ company_id: string; n: number }>(
      'SELECT company_id, COUNT(*) AS n FROM opslog_vehicles GROUP BY company_id',
    );
    expect(Object.fromEntries(counts.map((row) => [row.company_id, Number(row.n)]))).toEqual({
      [tenantA]: 1,
      [tenantB]: 1,
    });
  });

  it('denies roles without the permission and leaves the rows untouched', async () => {
    const id = (await adminA.post('/api/vehicles', { json: input() })).json.id as string;
    for (const [method, path, json] of [
      ['POST', '/api/vehicles', input({ economicNumber: 'V-9', plate: 'V9' })],
      ['PUT', `/api/vehicles/${id}`, { version: 1, make: 'x' }],
      ['POST', `/api/vehicles/${id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/vehicles/${id}/odometer`, { version: 1, odometerKm: 5000 }],
      ['POST', `/api/vehicles/${id}/archive`, { version: 1 }],
    ] as [string, string, unknown][])
      expect((await viewerA.send(method, path, { json })).status, `viewer ${path}`).toBe(403);
    expect(
      (await editorA.post(`/api/vehicles/${id}/archive`, { json: { version: 1 } })).status,
    ).toBe(403);
    expect((await viewerA.get(`/api/vehicles/${id}`)).json).toMatchObject({
      make: 'Toyota',
      version: 1,
    });
  });

  it('enforces the odometer rule and the duplicate keys against the database', async () => {
    const id = (await adminA.post('/api/vehicles', { json: input() })).json.id as string;
    const lower = await adminA.post(`/api/vehicles/${id}/odometer`, {
      json: { version: 1, odometerKm: 999 },
    });
    expect(lower.status).toBe(422);
    expect(lower.json.code).toBe('odometer_decrease');
    expect(
      (await database.rows<{ odometer_km: number }>('SELECT odometer_km FROM opslog_vehicles'))[0]
        ?.odometer_km,
    ).toBe(1000);
    const dup = await adminA.post('/api/vehicles', { json: input({ plate: 'zz9' }) });
    expect(dup).toMatchObject({
      status: 409,
      json: { code: 'duplicate', field: 'economic_number' },
    });
    const dupPlate = await adminA.post('/api/vehicles', {
      json: input({ economicNumber: 'U-2', plate: 'abc-123' }),
    });
    expect(dupPlate.json).toMatchObject({ code: 'duplicate', field: 'plate' });
  });

  it('lets exactly one of two concurrent writers win, from two sessions', async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = (
        await adminA.post('/api/vehicles', {
          json: input({ economicNumber: `R-${round}`, plate: `R${round}` }),
        })
      ).json.id as string;
      const replies = await Promise.all([
        adminA.put(`/api/vehicles/${id}`, { json: { version: 1, make: 'Uno' } }),
        adminA2.put(`/api/vehicles/${id}`, { json: { version: 1, make: 'Dos' } }),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.json.code).toBe('stale_version');
      expect((await adminA.get(`/api/vehicles/${id}`)).json.version).toBe(2);
    }
  });

  it('lets exactly one of two concurrent creates of the same economic number win', async () => {
    const replies = await Promise.all([
      adminA.post('/api/vehicles', { json: input() }),
      adminA2.post('/api/vehicles', { json: input({ plate: 'OTRA1' }) }),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect((await adminA.get('/api/vehicles')).json.total).toBe(1);
  });
});
