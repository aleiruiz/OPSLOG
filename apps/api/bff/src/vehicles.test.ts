import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES, BFF_VEHICLE_STATUSES } from '../../../../packages/contracts/src/index.js';
import { VEHICLE_STATUSES } from '../../../../packages/domain/vehicles/src/index.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

/** Real areas of the fixture (a vehicle's area must be an active area of its tenant). */
const areaIds = { a1: '', a2: '', b1: '' };
const defaultArea = new Map<Browser, string>();

const body = (over: Record<string, unknown> = {}) => ({
  economicNumber: 'U-001',
  plate: 'ab-123 c',
  vin: '1HGCM82633A004352',
  make: 'Toyota',
  model: 'Hilux',
  year: 2022,
  areaId: areaIds.a1,
  odometerKm: 1000,
  ...over,
});

interface Fixture {
  readonly adminA: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly adminB: Browser;
}

async function fixture(): Promise<Fixture> {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const fx = {
    adminA: await world.loginAs('subject-admin-a'),
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    adminB: await world.loginAs('subject-admin-b'),
  };
  const area = async (browser: Browser, name: string): Promise<string> => {
    const reply = await browser.post('/api/areas', { json: { name } });
    if (reply.status !== 201) throw new Error(`area fixture failed: ${reply.status}`);
    return reply.json.id as string;
  };
  areaIds.a1 = await area(fx.adminA, 'Area 1');
  areaIds.a2 = await area(fx.adminA, 'Area 2');
  areaIds.b1 = await area(fx.adminB, 'Area 1');
  defaultArea.clear();
  for (const browser of [fx.adminA, fx.editorA, fx.viewerA]) defaultArea.set(browser, areaIds.a1);
  defaultArea.set(fx.adminB, areaIds.b1);
  return fx;
}

const create = async (browser: Browser, over: Record<string, unknown> = {}) => {
  const reply = await browser.post('/api/vehicles', {
    json: body({ areaId: defaultArea.get(browser), ...over }),
  });
  if (reply.status !== 201) throw new Error(`create fixture failed: ${reply.status}`);
  return reply.json as { id: string; version: number };
};

const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

describe('contract', () => {
  it('declares the same statuses as the domain', () => {
    expect([...BFF_VEHICLE_STATUSES]).toEqual([...VEHICLE_STATUSES]);
  });
  it('protects every vehicle route: reads need a session, writes also the CSRF token', () => {
    for (const [id, definition] of Object.entries(BFF_ROUTES).filter(([id]) =>
      id.startsWith('vehicles.'),
    ))
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('vehicles over HTTP', () => {
  it('creates, reads, lists, edits, moves, reads the odometer, archives and shows the history', async () => {
    const { adminA } = await fixture();
    const created = await adminA.post('/api/vehicles', { json: body() });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      economicNumber: 'U-001',
      plate: 'AB-123 C',
      status: 'active',
      version: 1,
      archivedAt: null,
    });
    expect(created.json).not.toHaveProperty('tenantId');
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.headers['x-correlation-id']).toBeTruthy();
    const id = created.json.id as string;

    expect((await adminA.get(`/api/vehicles/${id}`)).json).toEqual(created.json);
    const edited = await adminA.put(`/api/vehicles/${id}`, {
      json: { version: 1, make: 'Ford', vin: null },
    });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ make: 'Ford', vin: null, version: 2 });
    const moved = await adminA.post(`/api/vehicles/${id}/status`, {
      json: { version: 2, status: 'out_of_service', reason: 'Siniestro 12' },
    });
    expect(moved.json).toMatchObject({
      status: 'out_of_service',
      statusReason: 'Siniestro 12',
      version: 3,
    });
    const read = await adminA.post(`/api/vehicles/${id}/odometer`, {
      json: { version: 3, odometerKm: 1800 },
    });
    expect(read.json).toMatchObject({ odometerKm: 1800, version: 4 });
    const history = await adminA.get(`/api/vehicles/${id}/history`);
    expect(history.status).toBe(200);
    expect(history.json.items.map((e: { from: unknown; to: string }) => [e.from, e.to])).toEqual([
      [null, 'active'],
      ['active', 'out_of_service'],
    ]);
    const archived = await adminA.post(`/api/vehicles/${id}/archive`, { json: { version: 4 } });
    expect(archived.json.archivedAt).not.toBeNull();
    expect((await adminA.get('/api/vehicles')).json).toMatchObject({ items: [], total: 0 });
    expect((await adminA.get('/api/vehicles?includeArchived=true')).json.items).toHaveLength(1);
  });

  it('pages with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB } = await fixture();
    for (const n of [1, 2, 3, 4, 5])
      await create(adminA, { economicNumber: `E-${n}`, plate: `PL${n}`, vin: null });
    await create(adminB, { economicNumber: 'E-1', plate: 'PL1', vin: null });
    const first = await adminA.get('/api/vehicles?limit=25');
    expect(first.json).toMatchObject({
      total: 5,
      nextCursor: null,
      sort: { field: 'economicNumber', direction: 'asc' },
    });
    // The listing only offers sizes 25/50/100, so build a longer list to reach a second page.
    for (let n = 6; n <= 27; n += 1)
      await create(adminA, { economicNumber: `E-${n}`, plate: `PL${n}`, vin: null });
    const page1 = await adminA.get('/api/vehicles');
    expect(page1.json.items).toHaveLength(25);
    expect(page1.json.total).toBe(27);
    const cursor = page1.json.nextCursor as string;
    expect(cursor).toBeTruthy();
    const page2 = await adminA.get(`/api/vehicles?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.items, ...page2.json.items].map((v: { id: string }) => v.id);
    expect(new Set(ids).size).toBe(27);
    // The cursor is useless for another tenant, other filters, a tampered value or garbage.
    for (const path of [
      `/api/vehicles?cursor=${encodeURIComponent(cursor)}&status=inactive`,
      `/api/vehicles?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `/api/vehicles?cursor=${encodeURIComponent(`${cursor}x`)}`,
      '/api/vehicles?cursor=garbage',
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`/api/vehicles?cursor=${encodeURIComponent(cursor)}`)).status).toBe(
      400,
    );
  });

  it('filters by status, area and archived flag', async () => {
    const { adminA } = await fixture();
    const one = await create(adminA, { economicNumber: 'A-1', plate: 'F1', vin: null });
    await create(adminA, { economicNumber: 'A-2', plate: 'F2', vin: null, areaId: areaIds.a2 });
    await adminA.post(`/api/vehicles/${one.id}/status`, {
      json: { version: 1, status: 'inactive', reason: 'Temporada' },
    });
    const numbers = async (query: string) =>
      (await adminA.get(`/api/vehicles${query}`)).json.items.map(
        (v: { economicNumber: string }) => v.economicNumber,
      );
    expect(await numbers('?status=inactive')).toEqual(['A-1']);
    expect(await numbers(`?areaId=${areaIds.a2}`)).toEqual(['A-2']);
    expect(await numbers('?includeArchived=false&limit=50')).toEqual(['A-1', 'A-2']);
  });
});

describe('who may do what', () => {
  it('answers 401 without a session and 403 for a missing permission, changing nothing', async () => {
    const { adminA, editorA, viewerA } = await fixture();
    const v = await create(adminA);
    const anonymous = world.browser();
    await world.prepare(anonymous);
    for (const [method, path, json] of [
      ['GET', '/api/vehicles'],
      ['GET', `/api/vehicles/${v.id}`],
      ['GET', `/api/vehicles/${v.id}/history`],
      ['POST', '/api/vehicles', body()],
      ['PUT', `/api/vehicles/${v.id}`, { version: 1, make: 'x' }],
      ['POST', `/api/vehicles/${v.id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/vehicles/${v.id}/odometer`, { version: 1, odometerKm: 5000 }],
      ['POST', `/api/vehicles/${v.id}/archive`, { version: 1 }],
    ] as [string, string, unknown?][])
      expect((await anonymous.send(method, path, { json })).status, `${method} ${path}`).toBe(401);

    for (const [method, path, json] of [
      ['POST', '/api/vehicles', body({ economicNumber: 'V-1', plate: 'V1', vin: null })],
      ['PUT', `/api/vehicles/${v.id}`, { version: 1, make: 'x' }],
      ['POST', `/api/vehicles/${v.id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/vehicles/${v.id}/odometer`, { version: 1, odometerKm: 5000 }],
      ['POST', `/api/vehicles/${v.id}/archive`, { version: 1 }],
    ] as [string, string, unknown][]) {
      const denied = await viewerA.send(method, path, { json });
      expect(denied.status, `viewer ${method} ${path}`).toBe(403);
      expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    }
    // The editor may change but not archive (soft delete needs `delete`).
    const forbidden = await editorA.post(`/api/vehicles/${v.id}/archive`, { json: { version: 1 } });
    expect(forbidden.status).toBe(403);
    expect((await viewerA.get(`/api/vehicles/${v.id}`)).json).toMatchObject({
      version: 1,
      archivedAt: null,
    });
    expect((await viewerA.get('/api/vehicles')).json.total).toBe(1);
    expect(
      (await editorA.put(`/api/vehicles/${v.id}`, { json: { version: 1, make: 'Editor' } })).status,
    ).toBe(200);
  });

  it('requires the CSRF token on every vehicle write', async () => {
    const { adminA } = await fixture();
    const v = await create(adminA);
    for (const [method, path, json] of [
      ['POST', '/api/vehicles', body({ economicNumber: 'C-1', plate: 'C1', vin: null })],
      ['PUT', `/api/vehicles/${v.id}`, { version: 1, make: 'x' }],
      ['POST', `/api/vehicles/${v.id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/vehicles/${v.id}/odometer`, { version: 1, odometerKm: 5000 }],
      ['POST', `/api/vehicles/${v.id}/archive`, { version: 1 }],
    ] as [string, string, unknown][])
      for (const csrf of [null, '', 'forged']) {
        const reply = await adminA.send(method, path, { json, csrf });
        expect(reply.status, `${method} ${path} ${csrf}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect((await adminA.get(`/api/vehicles/${v.id}`)).json).toMatchObject({
      version: 1,
      make: 'Toyota',
    });
  });
});

describe('tenant isolation over HTTP', () => {
  it('answers 404 to another tenant exactly as for an unknown id, and changes nothing', async () => {
    const { adminA, adminB } = await fixture();
    const v = await create(adminA);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const calls = (id: string): [string, string, unknown?][] => [
      ['GET', `/api/vehicles/${id}`],
      ['GET', `/api/vehicles/${id}/history`],
      ['PUT', `/api/vehicles/${id}`, { version: 1, make: 'Robado' }],
      ['POST', `/api/vehicles/${id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/vehicles/${id}/odometer`, { version: 1, odometerKm: 9999 }],
      ['POST', `/api/vehicles/${id}/archive`, { version: 1 }],
    ];
    const foreign = calls(v.id);
    const missing = calls(unknown);
    for (const [index, [method, path, json]] of foreign.entries()) {
      const a = await adminB.send(method, path, { json });
      const b = await adminB.send(method, (missing[index] as [string, string])[1], { json });
      expect(a.status, path).toBe(404);
      expect(withoutId(a)).toEqual(withoutId(b));
    }
    expect((await adminA.get(`/api/vehicles/${v.id}`)).json).toMatchObject({
      version: 1,
      make: 'Toyota',
    });
    expect((await adminB.get('/api/vehicles')).json.total).toBe(0);
  });

  it('refuses tenant hints in headers, query strings and bodies', async () => {
    const { adminA, adminB } = await fixture();
    await create(adminB, { economicNumber: 'B-1', plate: 'B1', vin: null });
    expect(
      (await adminA.get('/api/vehicles', { headers: { 'x-tenant-id': 'someone-else' } })).json
        .total,
    ).toBe(0);
    expect((await adminA.get('/api/vehicles?tenant=x')).status).toBe(400);
    expect((await adminA.get('/api/vehicles?tenantId=x')).status).toBe(400);
    for (const extra of [
      { tenantId: 'x' },
      { companyId: 'x' },
      { status: 'decommissioned' },
      { id: 'x' },
    ])
      expect((await adminA.post('/api/vehicles', { json: body(extra) })).status).toBe(400);
  });
});

describe('errors', () => {
  it('uses uniform bodies with the documented status for each business conflict', async () => {
    const { adminA } = await fixture();
    const v = await create(adminA);
    const second = await create(adminA, { economicNumber: 'U-2', plate: 'ZZ2', vin: null });

    const dup = await adminA.post('/api/vehicles', { json: body({ plate: 'zz9', vin: null }) });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({
      code: 'duplicate',
      message: 'Conflict',
      field: 'economic_number',
    });
    const dupPlate = await adminA.post('/api/vehicles', {
      json: body({ economicNumber: 'U-3', plate: 'AB123C', vin: null }),
    });
    expect(dupPlate.json).toMatchObject({ code: 'duplicate', field: 'plate' });
    const dupVin = await adminA.put(`/api/vehicles/${second.id}`, {
      json: { version: 1, vin: '1HGCM82633A004352' },
    });
    expect(dupVin.json).toMatchObject({ code: 'duplicate', field: 'vin' });

    const stale = await adminA.put(`/api/vehicles/${v.id}`, { json: { version: 7, make: 'x' } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'stale_version', message: 'Conflict' });
    expect(stale.json).not.toHaveProperty('field');

    const transition = await adminA.post(`/api/vehicles/${v.id}/status`, {
      json: { version: 1, status: 'active', reason: 'x' },
    });
    expect(transition.status).toBe(409);
    expect(transition.json.code).toBe('invalid_transition');

    const decrease = await adminA.post(`/api/vehicles/${v.id}/odometer`, {
      json: { version: 1, odometerKm: 10 },
    });
    expect(decrease.status).toBe(422);
    expect(decrease.json).toMatchObject({
      code: 'odometer_decrease',
      message: 'Unprocessable request',
    });

    const gone = await adminA.post(`/api/vehicles/${v.id}/status`, {
      json: { version: 1, status: 'decommissioned', reason: 'Venta' },
    });
    expect(gone.status).toBe(200);
    const immutable = await adminA.put(`/api/vehicles/${v.id}`, {
      json: { version: 2, make: 'x' },
    });
    expect(immutable.status).toBe(409);
    expect(immutable.json.code).toBe('immutable');
  });

  it('rejects malformed bodies and unknown properties with a uniform 400 that echoes nothing', async () => {
    const { adminA } = await fixture();
    const v = await create(adminA);
    const secret = 'SECRET-<script>-VALUE';
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/vehicles', { ...body(), extra: secret }],
      ['POST', '/api/vehicles', { make: 'only' }],
      ['POST', '/api/vehicles', body({ plate: secret })],
      ['POST', '/api/vehicles', body({ year: '2022' })],
      ['POST', '/api/vehicles', []],
      ['PUT', `/api/vehicles/${v.id}`, { make: 'no version' }],
      ['PUT', `/api/vehicles/${v.id}`, { version: 1 }],
      ['PUT', `/api/vehicles/${v.id}`, { version: 1, status: 'inactive' }],
      ['PUT', `/api/vehicles/${v.id}`, { version: 1, odometerKm: 5 }],
      ['PUT', `/api/vehicles/${v.id}`, { version: 'one', make: 'x' }],
      ['POST', `/api/vehicles/${v.id}/status`, { version: 1, status: 'Activo', reason: 'x' }],
      ['POST', `/api/vehicles/${v.id}/status`, { version: 1, status: 'inactive' }],
      ['POST', `/api/vehicles/${v.id}/status`, { version: 1, status: 'inactive', reason: '' }],
      ['POST', `/api/vehicles/${v.id}/odometer`, { version: 1, odometerKm: -5 }],
      ['POST', `/api/vehicles/${v.id}/odometer`, { version: 1 }],
      ['POST', `/api/vehicles/${v.id}/archive`, {}],
      ['POST', `/api/vehicles/${v.id}/archive`, { version: 1, force: true }],
    ];
    for (const [method, path, json] of attempts) {
      const reply = await adminA.send(method, path, { json });
      expect(reply.status, `${method} ${path} ${JSON.stringify(json)}`).toBe(400);
      expect(reply.json).toMatchObject({ code: 'bad_request', message: 'Invalid request' });
      expect(reply.text).not.toContain(secret);
    }
    expect((await adminA.send('POST', '/api/vehicles', { raw: 'not json' })).status).toBe(400);
    expect((await adminA.get(`/api/vehicles/${v.id}`)).json.version).toBe(1);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { adminA } = await fixture();
    for (const query of [
      '?limit=10',
      '?limit=25&limit=50',
      '?status=Activo',
      '?status=',
      '?areaId=a/b',
      '?includeArchived=yes',
      '?sort=plate',
      '?q=x',
    ])
      expect((await adminA.get(`/api/vehicles${query}`)).status, query).toBe(400);
  });

  it('answers 404 for malformed ids and 405 for the wrong method', async () => {
    const { adminA } = await fixture();
    expect((await adminA.get('/api/vehicles/has%20space')).status).toBe(404);
    expect((await adminA.get(`/api/vehicles/${'a'.repeat(65)}`)).status).toBe(404);
    const wrong = await adminA.send('DELETE', '/api/vehicles/abc');
    expect(wrong.status).toBe(405);
    expect(wrong.headers['allow']).toBe('GET, PUT');
    expect((await adminA.send('PUT', '/api/vehicles/abc/status', { json: {} })).status).toBe(405);
    expect((await adminA.send('GET', '/api/vehicles/abc/archive')).status).toBe(405);
  });

  it('never leaks internals when the store fails', async () => {
    world = createBffWorld({
      adapters: {
        vehicles: {
          insert: async () => {
            throw new Error('connection to db-prod.internal refused');
          },
          find: async () => null,
          list: async () => {
            throw new Error('db-prod.internal exploded');
          },
          replace: async () => false,
          history: async () => [],
          countLiveInArea: async () => 0,
        },
      },
    });
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const admin = await world.loginAs('subject-admin-a');
    const area = await admin.post('/api/areas', { json: { name: 'Area 1' } });
    for (const reply of [
      await admin.post('/api/vehicles', { json: body({ areaId: area.json.id }) }),
      await admin.get('/api/vehicles'),
    ]) {
      expect(reply.status).toBe(500);
      expect(reply.json).toMatchObject({ code: 'internal_error', message: 'Request failed' });
      expect(reply.text).not.toContain('db-prod');
    }
  });
});
