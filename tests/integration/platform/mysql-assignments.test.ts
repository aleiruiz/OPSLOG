import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TypeOrmAssignmentStore } from '../../../packages/persistence/assignments/src/index.js';
import {
  adminUrl,
  startAssignmentsDatabase,
  type AssignmentsDatabase,
} from '../../../packages/persistence/assignments/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL assignment store (CI: mysql service,
 * OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset, a hard failure in CI). Vehicles and
 * employees stay in memory: they are only the subjects of the assignments here. Two signed-in
 * sessions race over the same database. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const P = '/api/vehicle-assignments';
const seen = (replies: { status: number; json: { code?: string } }[]) =>
  JSON.stringify(replies.map((r) => [r.status, r.json.code]));

suite('BFF on the real MySQL assignment store', () => {
  let db: AssignmentsDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminA2: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let editorA: Browser;
  let tenantA: string;
  let tenantB: string;
  let vehicles: string[] = [];
  let drivers: string[] = [];
  let vehicleB: string;
  let driverB: string;

  beforeAll(async () => {
    db = await startAssignmentsDatabase('asg');
    const store = new TypeOrmAssignmentStore(await db.openRuntime());
    world = createBffWorld({
      adapters: { tenants: new InMemoryTenantStore(), assignments: store },
    });
    tenantA = (await world.tenant('Empresa Alfa', 'subject-admin-a')).tenantId;
    tenantB = (await world.tenant('Empresa Beta', 'subject-admin-b')).tenantId;
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
    await world.member('subject-admin-a', 'editor', 'subject-editor-a');
    adminA = await world.loginAs('subject-admin-a');
    adminA2 = await world.loginAs('subject-admin-a');
    adminB = await world.loginAs('subject-admin-b');
    viewerA = await world.loginAs('subject-viewer-a');
    editorA = await world.loginAs('subject-editor-a');
    const area = async (browser: Browser, tag: string) =>
      (
        await browser.post('/api/areas', {
          json: { name: `Flota ${tag}`, code: null, parentId: null, responsibleIds: [] },
        })
      ).json.id as string;
    const vehicleOf = async (browser: Browser, areaId: string, tag: string) => {
      const vehicle = await browser.post('/api/vehicles', {
        json: {
          economicNumber: `U-${tag}`,
          plate: `ABC${tag}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId,
          odometerKm: 10,
        },
      });
      expect(vehicle.status).toBe(201);
      return vehicle.json.id as string;
    };
    const driverOf = async (browser: Browser, areaId: string, tag: string) => {
      const employee = await browser.post('/api/employees', {
        json: {
          kind: 'driver',
          firstName: 'Ana',
          lastName: 'Perez',
          areaId,
          employeeNumber: `E-${tag}`,
        },
      });
      expect(employee.status).toBe(201);
      return employee.json.id as string;
    };
    const areaA = await area(adminA, 'A');
    const areaB = await area(adminB, 'B');
    for (let n = 0; n < 16; n += 1) {
      drivers.push(await driverOf(adminA, areaA, `A${n}x`));
      drivers.push(await driverOf(adminA, areaA, `A${n}y`));
      vehicles.push(await vehicleOf(adminA, areaA, `A${n}`));
      drivers.push(await driverOf(adminA, areaA, `A${n}`));
    }
    vehicleB = await vehicleOf(adminB, areaB, 'B');
    driverB = await driverOf(adminB, areaB, 'B');
  }, 120_000);

  afterAll(async () => {
    world?.dispose();
    await db?.close();
  }, 60_000);

  let nextVehicle = 0;
  let nextDriver = 0;
  /** Never-used vehicles and drivers per test, so tests (and random race winners) never collide. */
  const vehicle = (): string => vehicles[nextVehicle++] as string;
  const driver = (): string => drivers[nextDriver++] as string;
  const fresh = () => ({ vehicle: vehicle(), d1: driver(), d2: driver() });

  const body = (vehicleId: string, employeeId: string, over: Record<string, unknown> = {}) => ({
    vehicleId,
    employeeId,
    type: 'secondary',
    reason: 'Alta de unidad',
    ...over,
  });
  const make = async (
    browser: Browser,
    vehicleId: string,
    employeeId: string,
    over: Record<string, unknown> = {},
  ) => {
    const reply = await browser.post(P, { json: body(vehicleId, employeeId, over) });
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);
    return reply.json.assignment as { id: string; version: number };
  };

  it('runs the whole lifecycle and keeps the history as separate append-only rows', async () => {
    const f = fresh();
    const created = await adminA.post(P, {
      json: body(f.vehicle, f.d1, { type: 'principal', reason: 'Alta lifecycle' }),
    });
    expect(created.status).toBe(201);
    const id = created.json.assignment.id as string;
    expect(created.json.assignment).toMatchObject({ current: true, version: 1, type: 'principal' });
    const before = await db.rows(
      'SELECT * FROM opslog_vehicle_assignment_events WHERE company_id = ? AND assignment_id = ?',
      [tenantA, id],
    );
    expect(before).toHaveLength(1);
    const swapped = await adminA.post(P, {
      json: body(f.vehicle, f.d2, { type: 'principal', replace: true, reason: 'Relevo lifecycle' }),
    });
    expect(swapped.status).toBe(201);
    expect(swapped.json.replaced).toMatchObject({
      id,
      endKind: 'replaced',
      current: false,
      version: 2,
    });
    const rows = await db.rows<{ seq: number; kind: string }>(
      'SELECT * FROM opslog_vehicle_assignment_events WHERE company_id = ? AND assignment_id = ? ORDER BY seq',
      [tenantA, id],
    );
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([
      [1, 'assigned'],
      [2, 'replaced'],
    ]);
    expect(rows[0]).toEqual(before[0]);
    const history = await adminA.get(`${P}/${id}/history`);
    expect(history.json.items.map((e: { kind: string }) => e.kind)).toEqual([
      'replaced',
      'assigned',
    ]);
    const ended = await adminA.post(`${P}/${swapped.json.assignment.id}/end`, {
      json: { version: 1, reason: 'Fin lifecycle' },
    });
    expect(ended.json).toMatchObject({ current: false, endKind: 'ended', version: 2 });
    expect(
      (await adminA.post(`${P}/${id}/end`, { json: { version: 2, reason: 'Otra vez' } })).json.code,
    ).toBe('immutable');
    const byVehicle = await adminA.get(`${P}?vehicleId=${f.vehicle}`);
    expect(byVehicle.json.total).toBe(2);
    const stored = await db.rows<{ current_flag: number | null; principal_flag: number | null }>(
      'SELECT current_flag, principal_flag FROM opslog_vehicle_assignments WHERE company_id = ? AND vehicle_id = ?',
      [tenantA, f.vehicle],
    );
    expect(stored).toEqual([
      { current_flag: null, principal_flag: null },
      { current_flag: null, principal_flag: null },
    ]);
  });

  it('refuses a second principal naming the field, as the database constraint decides', async () => {
    const f = fresh();
    const g = fresh();
    await make(adminA, f.vehicle, f.d1, { type: 'principal' });
    const vehicleTaken = await adminA.post(P, {
      json: body(f.vehicle, f.d2, { type: 'principal' }),
    });
    expect(vehicleTaken.status).toBe(409);
    expect(vehicleTaken.json).toMatchObject({ code: 'principal_taken', field: 'vehicle_id' });
    const driverTaken = await adminA.post(P, {
      json: body(g.vehicle, f.d1, { type: 'principal' }),
    });
    expect(driverTaken.json).toMatchObject({ code: 'principal_taken', field: 'employee_id' });
    const pair = await adminA.post(P, { json: body(f.vehicle, f.d1, { type: 'temporary' }) });
    expect(pair.json).toMatchObject({ code: 'already_assigned', field: 'employee_id' });
    expect((await adminA.get(`${P}?vehicleId=${f.vehicle}&status=current`)).json.total).toBe(1);
  });

  it('stores the company in every row and no row of one company is reachable from the other', async () => {
    const f = fresh();
    const mine = await make(adminA, f.vehicle, f.d1);
    const theirs = await make(adminB, vehicleB, driverB);
    const rows = await db.rows<{ company_id: string; id: string }>(
      'SELECT company_id, id FROM opslog_vehicle_assignments WHERE id IN (?, ?)',
      [mine.id, theirs.id],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.company_id]))).toEqual({
      [mine.id]: tenantA,
      [theirs.id]: tenantB,
    });
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const [method, suffix, json] of [
      ['GET', '', undefined],
      ['GET', '/history', undefined],
      ['POST', '/end', { version: 1, reason: 'Robada' }],
    ] as [string, string, unknown][]) {
      const foreign = await adminB.send(method, `${P}/${mine.id}${suffix}`, { json });
      const missing = await adminB.send(method, `${P}/${unknown}${suffix}`, { json });
      expect(foreign.status, suffix).toBe(404);
      expect({ ...foreign.json, correlationId: '' }).toEqual({
        ...missing.json,
        correlationId: '',
      });
    }
    expect((await adminA.get(`${P}/${mine.id}`)).json).toMatchObject({ current: true, version: 1 });
    const idsB = (await adminB.get(P)).json.items.map((a: { id: string }) => a.id);
    expect(idsB).toContain(theirs.id);
    expect(idsB).not.toContain(mine.id);
  });

  it('answers the same 422 for a foreign and an unknown vehicle or driver', async () => {
    const f = fresh();
    const vehicleReplies = [
      await adminA.post(P, { json: body(vehicleB, f.d1) }),
      await adminA.post(P, { json: body('00000000-0000-4000-8000-000000000000', f.d1) }),
    ];
    for (const reply of vehicleReplies)
      expect(reply.json).toMatchObject({ code: 'invalid_vehicle', field: 'vehicle_id' });
    const driverReplies = [
      await adminA.post(P, { json: body(f.vehicle, driverB) }),
      await adminA.post(P, { json: body(f.vehicle, '00000000-0000-4000-8000-000000000000') }),
    ];
    for (const reply of driverReplies)
      expect(reply.json).toMatchObject({ code: 'invalid_employee', field: 'employee_id' });
    for (const group of [vehicleReplies, driverReplies])
      expect(new Set(group.map((r) => JSON.stringify({ ...r.json, correlationId: '' }))).size).toBe(
        1,
      );
  });

  it('lets exactly one of several concurrent principals from two sessions win', async () => {
    const f = fresh();
    const racers = Array.from({ length: 8 }, driver);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? adminA : adminA2).post(P, {
          json: body(f.vehicle, racers[i] as string, { type: 'principal', reason: 'Carrera' }),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409 && r.json.code === 'principal_taken'),
    ).toHaveLength(7);
    expect((await adminA.get(`${P}?vehicleId=${f.vehicle}&status=current`)).json.total).toBe(1);
  });

  it('lets exactly one of several concurrent replacements and closings win', async () => {
    const f = fresh();
    const first = await make(adminA, f.vehicle, f.d1, { type: 'principal' });
    const racers = Array.from({ length: 6 }, driver);
    const swaps = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 === 0 ? adminA : adminA2).post(P, {
          json: body(f.vehicle, racers[i] as string, {
            type: 'principal',
            replace: true,
            reason: 'Relevo carrera',
          }),
        }),
      ),
    );
    const won = swaps.filter((r) => r.status === 201);
    expect(won.length, seen(swaps)).toBeGreaterThanOrEqual(1);
    expect((await adminA.get(`${P}?vehicleId=${f.vehicle}&status=current`)).json.total).toBe(1);
    expect((await adminA.get(`${P}/${first.id}`)).json.endKind).toBe('replaced');
    const target = await make(adminA, vehicle(), driver());
    const closings = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 === 0 ? adminA : adminA2).post(`${P}/${target.id}/end`, {
          json: { version: 1, reason: `Fin ${i}` },
        }),
      ),
    );
    expect(
      closings.filter((r) => r.status === 200),
      seen(closings),
    ).toHaveLength(1);
    expect(
      closings.filter(
        (r) => r.status === 409 && ['stale_version', 'immutable'].includes(r.json.code),
      ),
      seen(closings),
    ).toHaveLength(5);
  });

  it('enforces roles on the real store: viewers read, editors assign and close', async () => {
    const f = fresh();
    const made = await make(adminA, f.vehicle, f.d1);
    expect((await viewerA.get(`${P}/${made.id}`)).status).toBe(200);
    expect(
      (await viewerA.post(`${P}/${made.id}/end`, { json: { version: 1, reason: 'xx' } })).status,
    ).toBe(403);
    expect((await viewerA.post(P, { json: body(f.vehicle, f.d2) })).status).toBe(403);
    expect((await editorA.post(P, { json: body(f.vehicle, f.d2) })).status).toBe(201);
    expect(
      (await editorA.post(`${P}/${made.id}/end`, { json: { version: 1, reason: 'Editor' } }))
        .status,
    ).toBe(200);
    expect((await adminA.get(`${P}/${made.id}`)).json).toMatchObject({
      current: false,
      version: 2,
    });
  });

  it('keeps reasons out of the audit trail', async () => {
    const f = fresh();
    await adminA.post(P, {
      json: body(f.vehicle, f.d1, { reason: 'Motivo-auditoria-secreto-99' }),
    });
    const text = JSON.stringify(
      world.platform.audit
        .list(tenantA)
        .filter((event) => event.entityType === 'vehicle_assignment'),
    );
    expect(text).toContain('vehicle_assignment.created');
    expect(text).not.toContain('Motivo-auditoria-secreto-99');
    expect(tenantB).not.toBe(tenantA);
  });
});
