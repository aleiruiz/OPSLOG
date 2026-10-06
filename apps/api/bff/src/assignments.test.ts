import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BFF_ASSIGNMENT_STATUSES,
  BFF_ASSIGNMENT_TYPES,
  BFF_ROUTES,
} from '../../../../packages/contracts/src/index.js';
import {
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_TYPES,
} from '../../../../packages/domain/assignments/src/index.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

interface Side {
  readonly area: string;
  readonly vehicle: string;
  readonly vehicle2: string;
  readonly driver: string;
  readonly driver2: string;
}

interface Fixture {
  readonly adminA: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly adminB: Browser;
  readonly a: Side;
  readonly b: Side;
}

let serial = 0;

async function side(browser: Browser): Promise<Side> {
  const area = await browser.post('/api/areas', { json: { name: 'Flota' } });
  const vehicle = async (): Promise<string> => {
    serial += 1;
    const reply = await browser.post('/api/vehicles', {
      json: {
        economicNumber: `U-${serial}`,
        plate: `ABC${serial}`,
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId: area.json.id,
        odometerKm: 10,
      },
    });
    if (reply.status !== 201) throw new Error('vehicle fixture failed');
    return reply.json.id as string;
  };
  const employee = async (kind = 'driver'): Promise<string> => {
    serial += 1;
    const reply = await browser.post('/api/employees', {
      json: {
        kind,
        firstName: 'Ana',
        lastName: 'Perez',
        areaId: area.json.id,
        employeeNumber: `E-${serial}`,
        idType: 'ine',
        nationalId: `SYNTH-ID-7788-Q${serial}`,
        phone: '+525590001234',
        email: `ana.perez${serial}@synthetic.example`,
        ...(kind === 'driver'
          ? {
              licenseNumber: `LIC-445566-${serial}`,
              licenseType: 'c',
              licenseExpiresOn: '2099-01-31',
            }
          : {}),
      },
    });
    if (reply.status !== 201) throw new Error(`employee fixture failed: ${reply.status}`);
    return reply.json.id as string;
  };
  return {
    area: area.json.id as string,
    vehicle: await vehicle(),
    vehicle2: await vehicle(),
    driver: await employee(),
    driver2: await employee(),
  };
}

async function fixture(): Promise<Fixture> {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  return {
    adminA,
    adminB,
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    a: await side(adminA),
    b: await side(adminB),
  };
}

const P = '/api/vehicle-assignments';

const body = (vehicleId: string, employeeId: string, over: Record<string, unknown> = {}) => ({
  vehicleId,
  employeeId,
  type: 'principal',
  reason: 'Alta de unidad',
  ...over,
});

const assign = async (
  browser: Browser,
  vehicleId: string,
  employeeId: string,
  over: Record<string, unknown> = {},
) => {
  const reply = await browser.post(P, { json: body(vehicleId, employeeId, over) });
  if (reply.status !== 201) throw new Error(`assign fixture failed: ${reply.status}`);
  return reply.json.assignment as { id: string; version: number };
};

const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

describe('contract', () => {
  it('declares the same types and statuses as the domain', () => {
    expect([...BFF_ASSIGNMENT_TYPES]).toEqual([...ASSIGNMENT_TYPES]);
    expect([...BFF_ASSIGNMENT_STATUSES]).toEqual([...ASSIGNMENT_STATUSES]);
  });
  it('protects every assignment route: reads need a session, writes also the CSRF token', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('assignments.'));
    expect(routes).toHaveLength(5);
    for (const [id, definition] of routes)
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('assignments over HTTP', () => {
  it('assigns, reads, lists, ends and shows the history', async () => {
    const { adminA, a } = await fixture();
    const created = await adminA.post(P, { json: body(a.vehicle, a.driver) });
    expect(created.status).toBe(201);
    expect(created.json.replaced).toBeNull();
    expect(created.json.assignment).toMatchObject({
      vehicleId: a.vehicle,
      employeeId: a.driver,
      type: 'principal',
      reason: 'Alta de unidad',
      assignedBy: expect.stringMatching(/^user-/),
      endedAt: null,
      endKind: null,
      current: true,
      version: 1,
    });
    expect(created.json.assignment).not.toHaveProperty('tenantId');
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.headers['x-correlation-id']).toBeTruthy();
    const id = created.json.assignment.id as string;

    expect((await adminA.get(`${P}/${id}`)).json).toMatchObject({ id, current: true });
    const ended = await adminA.post(`${P}/${id}/end`, {
      json: { version: 1, reason: 'Fin de turno' },
    });
    expect(ended.status).toBe(200);
    expect(ended.json).toMatchObject({
      current: false,
      endKind: 'ended',
      endReason: 'Fin de turno',
      version: 2,
    });
    expect(ended.json.endedAt).toEqual(expect.any(String));
    const history = await adminA.get(`${P}/${id}/history`);
    expect(history.status).toBe(200);
    expect(history.json.sort).toEqual({ field: 'seq', direction: 'desc' });
    expect(history.json.items.map((e: { kind: string }) => e.kind)).toEqual(['ended', 'assigned']);
    expect(history.json.items[0]).toMatchObject({ reason: 'Fin de turno', seq: 2 });
    expect((await adminA.get(`${P}?vehicleId=${a.vehicle}`)).json).toMatchObject({
      total: 1,
      sort: { field: 'startedAt', direction: 'desc' },
    });
    expect((await adminA.get(`${P}?status=current`)).json.total).toBe(0);
    expect((await adminA.get(`${P}?status=ended`)).json.total).toBe(1);
  });

  it('US-013: refuses a second principal naming the field, and replaces on request', async () => {
    const { adminA, a } = await fixture();
    const first = await assign(adminA, a.vehicle, a.driver);
    const vehicleTaken = await adminA.post(P, { json: body(a.vehicle, a.driver2) });
    expect(vehicleTaken.status).toBe(409);
    expect(vehicleTaken.json).toMatchObject({ code: 'principal_taken', field: 'vehicle_id' });
    const driverTaken = await adminA.post(P, { json: body(a.vehicle2, a.driver) });
    expect(driverTaken.status).toBe(409);
    expect(driverTaken.json).toMatchObject({ code: 'principal_taken', field: 'employee_id' });
    const pair = await adminA.post(P, { json: body(a.vehicle, a.driver, { type: 'secondary' }) });
    expect(pair.json).toMatchObject({ code: 'already_assigned', field: 'employee_id' });
    // Other types are not limited.
    expect(
      (await adminA.post(P, { json: body(a.vehicle, a.driver2, { type: 'secondary' }) })).status,
    ).toBe(201);
    const replaced = await adminA.post(P, {
      json: body(a.vehicle, a.driver2, { replace: true, reason: 'Relevo' }),
    });
    expect(replaced.status).toBe(409);
    // driver2 already holds a secondary on this vehicle: one current assignment per pair.
    expect(replaced.json.code).toBe('already_assigned');
    const swap = await adminA.post(P, {
      json: body(a.vehicle2, a.driver2, { replace: true, reason: 'Sin titular previo' }),
    });
    expect(swap.status).toBe(201);
    expect(swap.json.replaced).toBeNull();
    await adminA.post(`${P}/${first.id}/end`, { json: { version: 1, reason: 'Libera' } });
    const reassigned = await adminA.post(P, {
      json: body(a.vehicle, a.driver, { replace: true, reason: 'Vuelve' }),
    });
    expect(reassigned.status).toBe(201);
    expect(reassigned.json.replaced).toBeNull();
  });

  it('replaces the current principal in one request, closing the old assignment', async () => {
    const { adminA, a } = await fixture();
    const first = await assign(adminA, a.vehicle, a.driver);
    const swapped = await adminA.post(P, {
      json: body(a.vehicle, a.driver2, { replace: true, reason: 'Relevo de turno' }),
    });
    expect(swapped.status).toBe(201);
    expect(swapped.json.replaced).toMatchObject({
      id: first.id,
      current: false,
      endKind: 'replaced',
      endReason: 'Relevo de turno',
      version: 2,
    });
    expect(swapped.json.assignment).toMatchObject({ employeeId: a.driver2, current: true });
    const current = await adminA.get(`${P}?vehicleId=${a.vehicle}&status=current`);
    expect(current.json.items.map((x: { employeeId: string }) => x.employeeId)).toEqual([
      a.driver2,
    ]);
    const old = await adminA.get(`${P}/${first.id}/history`);
    expect(old.json.items.map((e: { kind: string }) => e.kind)).toEqual(['replaced', 'assigned']);
    // Both ficha views: the driver's and the vehicle's lists show the closed assignment as history.
    expect((await adminA.get(`${P}?employeeId=${a.driver}`)).json.items[0]).toMatchObject({
      id: first.id,
      current: false,
    });
  });

  it('pages with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB, a, b } = await fixture();
    for (let n = 0; n < 27; n += 1) {
      const created = await assign(adminA, a.vehicle, a.driver, { type: 'temporary' });
      await adminA.post(`${P}/${created.id}/end`, { json: { version: 1, reason: `Fin ${n}` } });
    }
    await assign(adminB, b.vehicle, b.driver);
    const page1 = await adminA.get(P);
    expect(page1.json.items).toHaveLength(25);
    expect(page1.json.total).toBe(27);
    const cursor = page1.json.nextCursor as string;
    const page2 = await adminA.get(`${P}?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.items, ...page2.json.items].map((v: { id: string }) => v.id);
    expect(new Set(ids).size).toBe(27);
    for (const path of [
      `${P}?cursor=${encodeURIComponent(cursor)}&status=ended`,
      `${P}?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `${P}?cursor=${encodeURIComponent(cursor)}&type=temporary`,
      `${P}?cursor=${encodeURIComponent(`${cursor}x`)}`,
      `${P}?cursor=garbage`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`${P}?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });

  it('pages the history with a cursor bound to the assignment and the page size', async () => {
    const { adminA, a } = await fixture();
    const one = await assign(adminA, a.vehicle, a.driver);
    const two = await assign(adminA, a.vehicle2, a.driver2);
    const first = await adminA.get(`${P}/${one.id}/history?limit=25`);
    expect(first.json.nextCursor).toBeNull();
    // A short page that still has a next one: two events, a page of one needs the 25 minimum.
    await adminA.post(`${P}/${one.id}/end`, { json: { version: 1, reason: 'Fin' } });
    for (const path of [
      `${P}/${two.id}/history?cursor=garbage`,
      `${P}/${one.id}/history?cursor=garbage`,
      `${P}/${one.id}/history?limit=7`,
      `${P}/${one.id}/history?status=current`,
      `${P}/${one.id}/history?limit=25&limit=50`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
  });

  it('filters by vehicle, driver, type and status, and rejects bad queries', async () => {
    const { adminA, a } = await fixture();
    await assign(adminA, a.vehicle, a.driver);
    await assign(adminA, a.vehicle, a.driver2, { type: 'secondary' });
    const drivers = async (query: string) =>
      (await adminA.get(`${P}${query}`)).json.items.map(
        (x: { employeeId: string }) => x.employeeId,
      );
    expect(await drivers(`?vehicleId=${a.vehicle}&type=secondary`)).toEqual([a.driver2]);
    expect(await drivers(`?employeeId=${a.driver}`)).toEqual([a.driver]);
    expect(await drivers('?type=principal&status=current')).toEqual([a.driver]);
    for (const query of [
      '?type=owner',
      '?status=open',
      '?vehicleId=bad id',
      '?employeeId=bad%20id',
      '?limit=7',
      '?unknown=1',
      '?type=principal&type=secondary',
    ])
      expect((await adminA.get(`${P}${query}`)).status, query).toBe(400);
  });

  it('rejects malformed bodies and unknown ids', async () => {
    const { adminA, a } = await fixture();
    const made = await assign(adminA, a.vehicle, a.driver);
    for (const json of [
      {},
      { ...body(a.vehicle, a.driver), tenantId: 'other' },
      { ...body(a.vehicle, a.driver), type: 'owner' },
      { ...body(a.vehicle, a.driver), reason: '' },
      { ...body(a.vehicle, a.driver), replace: 'yes' },
      body(a.vehicle, a.driver2, { type: 'secondary', replace: true }),
      { vehicleId: a.vehicle, employeeId: a.driver2, type: 'principal' },
    ])
      expect((await adminA.post(P, { json })).status, JSON.stringify(json)).toBe(400);
    for (const json of [{}, { version: 1 }, { reason: 'x' }, { version: 'one', reason: 'x' }])
      expect((await adminA.post(`${P}/${made.id}/end`, { json })).status).toBe(400);
    expect(
      (await adminA.post(`${P}/${made.id}/end`, { json: { version: 5, reason: 'x' } })).status,
    ).toBe(409);
    expect((await adminA.send('PUT', `${P}/${made.id}`, { json: {} })).status).toBe(405);
    expect((await adminA.send('DELETE', `${P}/${made.id}`)).status).toBe(405);
    expect((await adminA.get(`${P}/bad%20id`)).status).toBe(404);
  });

  it('turns a closed assignment into 409 immutable and a stale version into 409 stale_version', async () => {
    const { adminA, a } = await fixture();
    const made = await assign(adminA, a.vehicle, a.driver);
    const stale = await adminA.post(`${P}/${made.id}/end`, { json: { version: 9, reason: 'x' } });
    expect(stale.json.code).toBe('stale_version');
    expect(
      (await adminA.post(`${P}/${made.id}/end`, { json: { version: 1, reason: 'Fin' } })).status,
    ).toBe(200);
    const again = await adminA.post(`${P}/${made.id}/end`, {
      json: { version: 2, reason: 'Otra' },
    });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('immutable');
  });
});

describe('who may do what', () => {
  it('answers 401 without a session and 403 for a missing permission, changing nothing', async () => {
    const { adminA, editorA, viewerA, a } = await fixture();
    const made = await assign(adminA, a.vehicle, a.driver);
    const anonymous = world.browser();
    await world.prepare(anonymous);
    const calls = (): [string, string, unknown?][] => [
      ['GET', P],
      ['GET', `${P}/${made.id}`],
      ['GET', `${P}/${made.id}/history`],
      ['POST', P, body(a.vehicle2, a.driver2)],
      ['POST', `${P}/${made.id}/end`, { version: 1, reason: 'Fin' }],
    ];
    for (const [method, path, json] of calls())
      expect((await anonymous.send(method, path, { json })).status, `${method} ${path}`).toBe(401);
    for (const [method, path, json] of calls().slice(3)) {
      const denied = await viewerA.send(method, path, { json });
      expect(denied.status, `viewer ${method} ${path}`).toBe(403);
      expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    }
    expect((await viewerA.get(`${P}/${made.id}`)).json).toMatchObject({
      version: 1,
      current: true,
    });
    // An editor assigns and ends (create + edit), including a replacement.
    expect((await editorA.post(P, { json: body(a.vehicle2, a.driver2) })).status).toBe(201);
    expect(
      (await editorA.post(P, { json: body(a.vehicle, a.driver2, { type: 'secondary' }) })).status,
    ).toBe(201);
    expect(
      (await editorA.post(`${P}/${made.id}/end`, { json: { version: 1, reason: 'Fin' } })).status,
    ).toBe(200);
  });

  it('requires the CSRF token on every assignment write', async () => {
    const { adminA, a } = await fixture();
    const made = await assign(adminA, a.vehicle, a.driver);
    for (const [method, path, json] of [
      ['POST', P, body(a.vehicle2, a.driver2)],
      ['POST', `${P}/${made.id}/end`, { version: 1, reason: 'Fin' }],
    ] as [string, string, unknown][])
      for (const csrf of [null, '', 'forged']) {
        const reply = await adminA.send(method, path, { json, csrf });
        expect(reply.status, `${method} ${path} ${csrf}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect((await adminA.get(`${P}/${made.id}`)).json).toMatchObject({ version: 1, current: true });
  });
});

describe('tenant isolation over HTTP', () => {
  it('answers 404 to another tenant exactly as for an unknown id, and changes nothing', async () => {
    const { adminA, adminB, a } = await fixture();
    const made = await assign(adminA, a.vehicle, a.driver);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const calls = (id: string): [string, string, unknown?][] => [
      ['GET', `${P}/${id}`],
      ['GET', `${P}/${id}/history`],
      ['POST', `${P}/${id}/end`, { version: 1, reason: 'Robada' }],
    ];
    const foreign = calls(made.id);
    const missing = calls(unknown);
    for (const [index, [method, path, json]] of foreign.entries()) {
      const one = await adminB.send(method, path, { json });
      const two = await adminB.send(method, (missing[index] as [string, string])[1], { json });
      expect(one.status, path).toBe(404);
      expect(withoutId(one)).toEqual(withoutId(two));
    }
    expect((await adminA.get(`${P}/${made.id}`)).json).toMatchObject({ version: 1, current: true });
    expect((await adminB.get(P)).json.total).toBe(0);
  });

  it('answers the same 422 for a foreign, unknown, archived or inactive vehicle', async () => {
    const { adminA, adminB, a, b } = await fixture();
    const archived = await adminA.post(`/api/vehicles/${a.vehicle2}/archive`, {
      json: { version: 1 },
    });
    expect(archived.status).toBe(200);
    const spare = await adminA.post('/api/vehicles', {
      json: {
        economicNumber: 'INA-1',
        plate: 'INA111',
        vin: null,
        make: 'X',
        model: 'Y',
        year: 2020,
        odometerKm: 1,
        areaId: a.area,
      },
    });
    expect(
      (
        await adminA.post(`/api/vehicles/${spare.json.id}/status`, {
          json: { version: 1, status: 'inactive', reason: 'Parada' },
        })
      ).status,
    ).toBe(200);
    const attempts = [
      await adminA.post(P, { json: body(b.vehicle, a.driver) }),
      await adminA.post(P, { json: body('00000000-0000-4000-8000-000000000000', a.driver) }),
      await adminA.post(P, { json: body(a.vehicle2, a.driver) }),
      await adminA.post(P, { json: body(spare.json.id, a.driver) }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(422);
      expect(attempt.json).toMatchObject({ code: 'invalid_vehicle', field: 'vehicle_id' });
    }
    expect(new Set(attempts.map((reply) => JSON.stringify(withoutId(reply)))).size).toBe(1);
    expect((await adminB.post(P, { json: body(a.vehicle, b.driver) })).json.code).toBe(
      'invalid_vehicle',
    );
  });

  it('BR-014: answers the same 422 for a foreign, unknown, non-driver, suspended or archived employee', async () => {
    const { adminA, a, b } = await fixture();
    const dispatcher = await adminA.post('/api/employees', {
      json: {
        kind: 'dispatcher',
        firstName: 'Luis',
        lastName: 'Gomez',
        areaId: a.area,
        employeeNumber: 'D-1',
        idType: 'ine',
        nationalId: 'SYNTH-ID-9911-D1',
        phone: '+525590009999',
        email: 'luis.gomez@synthetic.example',
      },
    });
    expect(dispatcher.status).toBe(201);
    const suspended = await adminA.post(`/api/employees/${a.driver2}/status`, {
      json: { version: 1, status: 'suspended', reason: 'Revision' },
    });
    expect(suspended.status).toBe(200);
    const attempts = [
      await adminA.post(P, { json: body(a.vehicle, b.driver) }),
      await adminA.post(P, { json: body(a.vehicle, '00000000-0000-4000-8000-000000000000') }),
      await adminA.post(P, { json: body(a.vehicle, dispatcher.json.id) }),
      await adminA.post(P, { json: body(a.vehicle, a.driver2) }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(422);
      expect(attempt.json).toMatchObject({ code: 'invalid_employee', field: 'employee_id' });
    }
    expect(new Set(attempts.map((reply) => JSON.stringify(withoutId(reply)))).size).toBe(1);
    expect(
      (await adminA.post(`/api/employees/${a.driver}/archive`, { json: { version: 1 } })).status,
    ).toBe(200);
    expect((await adminA.post(P, { json: body(a.vehicle, a.driver) })).json.code).toBe(
      'invalid_employee',
    );
    expect((await adminA.get(P)).json.total).toBe(0);
  });
});
