import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BFF_COVERAGE_TYPES,
  BFF_POLICY_STATUSES,
  BFF_ROUTES,
} from '../../../../packages/contracts/src/index.js';
import {
  COVERAGE_TYPES,
  POLICY_STATUSES,
} from '../../../../packages/domain/insurance/src/index.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

interface Fixture {
  readonly adminA: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly adminB: Browser;
  readonly vehicleA: string;
  readonly vehicleB: string;
}

let serial = 0;
async function fixture(): Promise<Fixture> {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  const owners = async (browser: Browser) => {
    const area = await browser.post('/api/areas', { json: { name: 'Flota' } });
    serial += 1;
    const vehicle = await browser.post('/api/vehicles', {
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
    if (vehicle.status !== 201) throw new Error('owner fixture failed');
    return { vehicle: vehicle.json.id as string };
  };
  const a = await owners(adminA);
  const b = await owners(adminB);
  return {
    adminA,
    adminB,
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    vehicleA: a.vehicle,
    vehicleB: b.vehicle,
  };
}

const P = '/api/insurance-policies';

const body = (vehicleId: string, over: Record<string, unknown> = {}) => ({
  vehicleId,
  insurer: 'Aseguradora Ficticia',
  policyNumber: 'pol-001',
  coverageType: 'comprehensive',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  ...over,
});

const AMOUNT = { kind: 'amount', amountMinor: 500000, currency: 'MXN' };

const create = async (browser: Browser, vehicleId: string, over: Record<string, unknown> = {}) => {
  const reply = await browser.post(P, { json: body(vehicleId, over) });
  if (reply.status !== 201) throw new Error(`create fixture failed: ${reply.status}`);
  return reply.json as { id: string; version: number };
};

const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

describe('contract', () => {
  it('declares the same coverage types and statuses as the domain', () => {
    expect([...BFF_COVERAGE_TYPES]).toEqual([...COVERAGE_TYPES]);
    expect([...BFF_POLICY_STATUSES]).toEqual([...POLICY_STATUSES]);
  });
  it('protects every insurance route: reads need a session, writes also the CSRF token', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('insurance.'));
    expect(routes).toHaveLength(7);
    for (const [id, definition] of routes)
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('policies over HTTP', () => {
  it('creates, reads, lists, edits, renews, archives and shows the revisions', async () => {
    const { adminA, vehicleA } = await fixture();
    const created = await adminA.post(P, {
      json: body(vehicleA, { coverageNotes: 'RC y robo', deductible: AMOUNT }),
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      vehicleId: vehicleA,
      insurer: 'Aseguradora Ficticia',
      coverageNotes: 'RC y robo',
      revision: 1,
      policyNumber: 'POL-001',
      coverageType: 'comprehensive',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
      status: 'valid',
      daysToExpiry: 86,
      covering: true,
      hasDeductible: true,
      deductible: AMOUNT,
      version: 1,
      archivedAt: null,
    });
    expect(created.json).not.toHaveProperty('tenantId');
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.headers['x-correlation-id']).toBeTruthy();
    const id = created.json.id as string;

    expect((await adminA.get(`${P}/${id}`)).json).toMatchObject({ id, version: 1 });
    const edited = await adminA.put(`${P}/${id}`, {
      json: { version: 1, insurer: 'Otra Ficticia', coverageNotes: null },
    });
    expect(edited.json).toMatchObject({
      insurer: 'Otra Ficticia',
      coverageNotes: null,
      version: 2,
      revision: 1,
    });
    const renewed = await adminA.post(`${P}/${id}/renew`, {
      json: { version: 2, startsOn: '2026-10-07', endsOn: '2026-10-20', deductible: null },
    });
    expect(renewed.status).toBe(200);
    expect(renewed.json).toMatchObject({
      revision: 2,
      version: 3,
      status: 'expiring',
      daysToExpiry: 14,
      covering: false,
      hasDeductible: false,
      deductible: null,
      policyNumber: 'POL-001',
    });
    const history = await adminA.get(`${P}/${id}/history`);
    expect(history.status).toBe(200);
    expect(
      history.json.items.map((r: { revision: number; status: string }) => [r.revision, r.status]),
    ).toEqual([
      [2, 'expiring'],
      [1, 'replaced'],
    ]);
    expect(history.json.items[1]).toMatchObject({ deductible: AMOUNT, hasDeductible: true });
    expect(history.json.items[0]).toMatchObject({ actorId: expect.stringMatching(/^user-/) });
    const archived = await adminA.post(`${P}/${id}/archive`, { json: { version: 3 } });
    expect(archived.json.archivedAt).not.toBeNull();
    expect((await adminA.get(P)).json).toMatchObject({ items: [], total: 0 });
    expect((await adminA.get(`${P}?includeArchived=true`)).json.items).toHaveLength(1);
  });

  it('carries the deductible over a renewal that does not mention it', async () => {
    const { adminA, vehicleA } = await fixture();
    const p = await create(adminA, vehicleA, {
      deductible: { kind: 'percent', basisPoints: 1500 },
    });
    const renewed = await adminA.post(`${P}/${p.id}/renew`, {
      json: { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31', policyNumber: 'pol-002' },
    });
    expect(renewed.json).toMatchObject({
      policyNumber: 'POL-002',
      deductible: { kind: 'percent', basisPoints: 1500 },
    });
  });

  it('pages with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB, vehicleA, vehicleB } = await fixture();
    for (let n = 1; n <= 27; n += 1)
      await create(adminA, vehicleA, { endsOn: `2027-01-${String(n).padStart(2, '0')}` });
    await create(adminB, vehicleB);
    const page1 = await adminA.get(P);
    expect(page1.json.items).toHaveLength(25);
    expect(page1.json.total).toBe(27);
    expect(page1.json.sort).toEqual({ field: 'endsOn', direction: 'asc' });
    const cursor = page1.json.nextCursor as string;
    const page2 = await adminA.get(`${P}?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.items, ...page2.json.items].map((v: { id: string }) => v.id);
    expect(new Set(ids).size).toBe(27);
    for (const path of [
      `${P}?cursor=${encodeURIComponent(cursor)}&status=expired`,
      `${P}?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `${P}?cursor=${encodeURIComponent(cursor)}&coversOn=2026-10-06`,
      `${P}?cursor=${encodeURIComponent(`${cursor}x`)}`,
      `${P}?cursor=garbage`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`${P}?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });

  it('pages the revisions with a cursor bound to the policy and the page size', async () => {
    const { adminA, vehicleA } = await fixture();
    const one = await create(adminA, vehicleA);
    const two = await create(adminA, vehicleA);
    for (let n = 0; n < 26; n += 1) {
      const reply = await adminA.post(`${P}/${one.id}/renew`, {
        json: {
          version: n + 1,
          startsOn: '2027-01-01',
          endsOn: `2028-01-${String(n + 1).padStart(2, '0')}`,
        },
      });
      expect(reply.status).toBe(200);
    }
    const first = await adminA.get(`${P}/${one.id}/history`);
    expect(first.json.items).toHaveLength(25);
    expect(first.json.total).toBe(27);
    expect(first.json.sort).toEqual({ field: 'revision', direction: 'desc' });
    const cursor = encodeURIComponent(first.json.nextCursor as string);
    const second = await adminA.get(`${P}/${one.id}/history?cursor=${cursor}`);
    expect(second.json.items).toHaveLength(2);
    expect(second.json.nextCursor).toBeNull();
    for (const path of [
      `${P}/${two.id}/history?cursor=${cursor}`,
      `${P}/${one.id}/history?cursor=${cursor}&limit=50`,
      `${P}/${one.id}/history?cursor=garbage`,
      `${P}/${one.id}/history?status=valid`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
  });

  it('filters by vehicle, coverage, derived status, covered day and archived flag', async () => {
    const { adminA, vehicleA } = await fixture();
    const second = await adminA.post('/api/vehicles', {
      json: {
        economicNumber: 'U-X',
        plate: 'XYZ999',
        vin: null,
        make: 'T',
        model: 'H',
        year: 2022,
        areaId: (await adminA.get('/api/areas')).json.items[0].id,
        odometerKm: 1,
      },
    });
    const other = second.json.id as string;
    const expired = await create(adminA, vehicleA, {
      insurer: 'Vencida Ficticia',
      endsOn: '2026-10-01',
    });
    await create(adminA, vehicleA, { insurer: 'Por vencer Ficticia', endsOn: '2026-10-20' });
    await create(adminA, other, {
      insurer: 'Futura Ficticia',
      coverageType: 'mandatory_liability',
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
    });
    const names = async (query: string) =>
      (await adminA.get(`${P}${query}`)).json.items.map((v: { insurer: string }) => v.insurer);
    expect(await names('?status=expired')).toEqual(['Vencida Ficticia']);
    expect(await names('?status=expiring')).toEqual(['Por vencer Ficticia']);
    expect(await names('?status=valid')).toEqual(['Futura Ficticia']);
    expect(await names(`?vehicleId=${other}`)).toEqual(['Futura Ficticia']);
    expect(await names('?coverageType=mandatory_liability')).toEqual(['Futura Ficticia']);
    expect(await names('?coversOn=2026-10-06')).toEqual(['Por vencer Ficticia']);
    expect(await names('?coversOn=2027-01-01')).toEqual(['Futura Ficticia']);
    await adminA.post(`${P}/${expired.id}/archive`, { json: { version: 1 } });
    expect(await names('?status=expired')).toEqual([]);
    expect(await names('?status=expired&includeArchived=true')).toEqual(['Vencida Ficticia']);
  });
});

describe('who may do what', () => {
  it('answers 401 without a session and 403 for a missing permission, changing nothing', async () => {
    const { adminA, editorA, viewerA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const anonymous = world.browser();
    await world.prepare(anonymous);
    const renewal = { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31' };
    const calls = (): [string, string, unknown?][] => [
      ['GET', P],
      ['GET', `${P}/${v.id}`],
      ['GET', `${P}/${v.id}/history`],
      ['POST', P, body(vehicleA)],
      ['PUT', `${P}/${v.id}`, { version: 1, insurer: 'Otra Ficticia' }],
      ['POST', `${P}/${v.id}/renew`, renewal],
      ['POST', `${P}/${v.id}/archive`, { version: 1 }],
    ];
    for (const [method, path, json] of calls())
      expect((await anonymous.send(method, path, { json })).status, `${method} ${path}`).toBe(401);
    for (const [method, path, json] of calls().slice(3)) {
      const denied = await viewerA.send(method, path, { json });
      expect(denied.status, `viewer ${method} ${path}`).toBe(403);
      expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    }
    expect((await editorA.post(`${P}/${v.id}/archive`, { json: { version: 1 } })).status).toBe(403);
    expect((await viewerA.get(`${P}/${v.id}`)).json).toMatchObject({
      version: 1,
      archivedAt: null,
    });
    expect(
      (await editorA.put(`${P}/${v.id}`, { json: { version: 1, insurer: 'Editor Ficticio' } }))
        .status,
    ).toBe(200);
    expect(
      (await editorA.post(`${P}/${v.id}/renew`, { json: { ...renewal, version: 2 } })).status,
    ).toBe(200);
  });

  it('gates the deductible by view_costs: hidden on reads, refused on writes, never erased silently', async () => {
    const { adminA, editorA, viewerA, vehicleA } = await fixture();
    const p = await create(adminA, vehicleA, { deductible: AMOUNT });
    const hidden = { hasDeductible: true, deductible: null };
    for (const browser of [editorA, viewerA]) {
      expect((await browser.get(`${P}/${p.id}`)).json).toMatchObject(hidden);
      expect((await browser.get(P)).json.items[0]).toMatchObject(hidden);
      expect((await browser.get(`${P}/${p.id}/history`)).json.items[0]).toMatchObject(hidden);
    }
    expect((await editorA.get(`${P}/${p.id}`)).text).not.toContain('500000');
    // writing a deductible needs view_costs, also for an editor who may create and renew
    for (const deductible of [AMOUNT, { kind: 'percent', basisPoints: 100 }]) {
      const create = await editorA.post(P, { json: body(vehicleA, { deductible }) });
      expect(create.status).toBe(403);
      const renew = await editorA.post(`${P}/${p.id}/renew`, {
        json: { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31', deductible },
      });
      expect(renew.status).toBe(403);
    }
    // without view_costs a policy is created without deductible and renewed carrying it over
    expect((await editorA.post(P, { json: body(vehicleA, { deductible: null }) })).status).toBe(
      201,
    );
    const renewed = await editorA.post(`${P}/${p.id}/renew`, {
      json: { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31' },
    });
    expect(renewed.status).toBe(200);
    expect(renewed.json).toMatchObject(hidden);
    expect((await adminA.get(`${P}/${p.id}`)).json.deductible).toEqual(AMOUNT);
  });

  it('requires the CSRF token on every policy write', async () => {
    const { adminA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    for (const [method, path, json] of [
      ['POST', P, body(vehicleA)],
      ['PUT', `${P}/${v.id}`, { version: 1, insurer: 'Otra Ficticia' }],
      ['POST', `${P}/${v.id}/renew`, { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31' }],
      ['POST', `${P}/${v.id}/archive`, { version: 1 }],
    ] as [string, string, unknown][])
      for (const csrf of [null, '', 'forged']) {
        const reply = await adminA.send(method, path, { json, csrf });
        expect(reply.status, `${method} ${path} ${csrf}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect((await adminA.get(`${P}/${v.id}`)).json).toMatchObject({
      version: 1,
      insurer: 'Aseguradora Ficticia',
    });
  });
});

describe('tenant isolation over HTTP', () => {
  it('answers 404 to another tenant exactly as for an unknown id, and changes nothing', async () => {
    const { adminA, adminB, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const renewal = { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31' };
    const calls = (id: string): [string, string, unknown?][] => [
      ['GET', `${P}/${id}`],
      ['GET', `${P}/${id}/history`],
      ['PUT', `${P}/${id}`, { version: 1, insurer: 'Robada Ficticia' }],
      ['POST', `${P}/${id}/renew`, renewal],
      ['POST', `${P}/${id}/archive`, { version: 1 }],
    ];
    const foreign = calls(v.id);
    const missing = calls(unknown);
    for (const [index, [method, path, json]] of foreign.entries()) {
      const a = await adminB.send(method, path, { json });
      const b = await adminB.send(method, (missing[index] as [string, string])[1], { json });
      expect(a.status, path).toBe(404);
      expect(withoutId(a)).toEqual(withoutId(b));
    }
    expect((await adminA.get(`${P}/${v.id}`)).json).toMatchObject({
      version: 1,
      insurer: 'Aseguradora Ficticia',
    });
    expect((await adminB.get(P)).json.total).toBe(0);
  });

  it('answers the same 422 for a vehicle of another tenant, an unknown vehicle and an archived one', async () => {
    const { adminA, adminB, vehicleB } = await fixture();
    const archived = await adminA.post('/api/vehicles', {
      json: {
        economicNumber: 'ARC-1',
        plate: 'ARC111',
        vin: null,
        make: 'X',
        model: 'Y',
        year: 2020,
        odometerKm: 1,
        areaId: (await adminA.get('/api/areas')).json.items[0].id,
      },
    });
    expect(
      (await adminA.post(`/api/vehicles/${archived.json.id}/archive`, { json: { version: 1 } }))
        .status,
    ).toBe(200);
    const attempts = [
      await adminA.post(P, { json: body(vehicleB) }),
      await adminA.post(P, { json: body('00000000-0000-4000-8000-000000000000') }),
      await adminA.post(P, { json: body(archived.json.id as string) }),
    ];
    for (const reply of attempts) {
      expect(reply.status).toBe(422);
      expect(reply.json).toMatchObject({ code: 'invalid_vehicle', field: 'vehicle_id' });
    }
    expect(new Set(attempts.map((reply) => JSON.stringify(withoutId(reply)))).size).toBe(1);
    expect((await adminB.get(P)).json.total).toBe(0);
    expect((await adminA.get(P)).json.total).toBe(0);
  });

  it('refuses tenant hints in headers, query strings and bodies', async () => {
    const { adminA, adminB, vehicleA, vehicleB } = await fixture();
    await create(adminB, vehicleB);
    expect((await adminA.get(P, { headers: { 'x-tenant-id': 'someone-else' } })).json.total).toBe(
      0,
    );
    expect((await adminA.get(`${P}?tenant=x`)).status).toBe(400);
    expect((await adminA.get(`${P}?tenantId=x`)).status).toBe(400);
    for (const extra of [{ tenantId: 'x' }, { companyId: 'x' }, { status: 'expired' }, { id: 'x' }])
      expect((await adminA.post(P, { json: body(vehicleA, extra) })).status).toBe(400);
  });
});

describe('errors', () => {
  it('uses uniform bodies with the documented status for each business conflict', async () => {
    const { adminA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const renewal = { startsOn: '2027-01-01', endsOn: '2027-12-31' };
    const stale = await adminA.put(`${P}/${v.id}`, {
      json: { version: 7, insurer: 'Otra Ficticia' },
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'stale_version', message: 'Conflict' });
    expect(stale.json).not.toHaveProperty('field');
    const staleRenew = await adminA.post(`${P}/${v.id}/renew`, {
      json: { version: 7, ...renewal },
    });
    expect(staleRenew.json.code).toBe('stale_version');
    const archived = await adminA.post(`${P}/${v.id}/archive`, { json: { version: 1 } });
    expect(archived.status).toBe(200);
    for (const reply of [
      await adminA.put(`${P}/${v.id}`, { json: { version: 2, insurer: 'Otra Ficticia' } }),
      await adminA.post(`${P}/${v.id}/renew`, { json: { version: 2, ...renewal } }),
      await adminA.post(`${P}/${v.id}/archive`, { json: { version: 2 } }),
    ]) {
      expect(reply.status).toBe(409);
      expect(reply.json.code).toBe('immutable');
    }
  });

  it('rejects malformed bodies and unknown properties with a uniform 400 that echoes nothing', async () => {
    const { adminA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const fake = 'FAKE-<script>-TEXT';
    const renewal = { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31' };
    const attempts: [string, string, unknown][] = [
      ['POST', P, { ...body(vehicleA), extra: fake }],
      ['POST', P, { insurer: 'only' }],
      ['POST', P, body(vehicleA, { insurer: `${fake}\u0007` })],
      ['POST', P, body(vehicleA, { coverageType: fake })],
      ['POST', P, body(vehicleA, { policyNumber: fake })],
      ['POST', P, body(vehicleA, { startsOn: '2027-02-30' })],
      ['POST', P, body(vehicleA, { startsOn: '2027-01-01', endsOn: '2026-01-01' })],
      ['POST', P, body(vehicleA, { endsOn: null })],
      [
        'POST',
        P,
        body(vehicleA, { deductible: { kind: 'amount', amountMinor: 1.5, currency: 'MXN' } }),
      ],
      ['POST', P, body(vehicleA, { deductible: { kind: 'percent', basisPoints: 20000 } })],
      ['POST', P, body(vehicleA, { deductible: { kind: 'amount', amountMinor: 5 } })],
      ['POST', P, body(vehicleA, { deductible: 'a lot' })],
      ['POST', P, []],
      ['PUT', `${P}/${v.id}`, { insurer: 'no version' }],
      ['PUT', `${P}/${v.id}`, { version: 1 }],
      ['PUT', `${P}/${v.id}`, { version: 1, endsOn: '2030-01-01' }],
      ['PUT', `${P}/${v.id}`, { version: 'one', insurer: 'Otra Ficticia' }],
      ['POST', `${P}/${v.id}/renew`, { startsOn: '2027-01-01', endsOn: '2027-12-31' }],
      ['POST', `${P}/${v.id}/renew`, { version: 1, endsOn: '2027-12-31' }],
      ['POST', `${P}/${v.id}/renew`, { ...renewal, insurer: 'x' }],
      ['POST', `${P}/${v.id}/renew`, { ...renewal, coverageType: fake }],
      ['POST', `${P}/${v.id}/archive`, {}],
      ['POST', `${P}/${v.id}/archive`, { version: 1, force: true }],
    ];
    for (const [method, path, json] of attempts) {
      const reply = await adminA.send(method, path, { json });
      expect(reply.status, `${method} ${path} ${JSON.stringify(json)}`).toBe(400);
      expect(reply.json).toMatchObject({ code: 'bad_request', message: 'Invalid request' });
      expect(reply.text).not.toContain(fake);
    }
    expect((await adminA.send('POST', P, { raw: 'not json' })).status).toBe(400);
    expect((await adminA.get(`${P}/${v.id}`)).json.version).toBe(1);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { adminA } = await fixture();
    for (const query of [
      '?limit=10',
      '?limit=25&limit=50',
      '?status=Vencido',
      '?status=',
      '?coverageType=gold',
      '?vehicleId=a/b',
      '?coversOn=06/10/2026',
      '?coversOn=2026-02-30',
      '?includeArchived=yes',
      '?sort=endsOn',
      '?q=POL-1',
    ])
      expect((await adminA.get(`${P}${query}`)).status, query).toBe(400);
  });

  it('answers 404 for malformed ids and 405 for the wrong method', async () => {
    const { adminA } = await fixture();
    expect((await adminA.get(`${P}/has%20space`)).status).toBe(404);
    expect((await adminA.get(`${P}/${'a'.repeat(65)}`)).status).toBe(404);
    const wrong = await adminA.send('DELETE', `${P}/abc`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers['allow']).toBe('GET, PUT');
    expect((await adminA.send('PUT', `${P}/abc/renew`, { json: {} })).status).toBe(405);
    expect((await adminA.send('GET', `${P}/abc/archive`)).status).toBe(405);
  });

  it('never leaks internals when the store fails', async () => {
    world = createBffWorld({
      adapters: {
        insurance: {
          insert: async () => {
            throw new Error('connection to db-prod.internal refused');
          },
          find: async () => null,
          list: async () => {
            throw new Error('db-prod.internal exploded');
          },
          replace: async () => false,
          revisions: async () => {
            throw new Error('db-prod.internal exploded');
          },
        },
      },
    });
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const admin = await world.loginAs('subject-admin-a');
    const area = await admin.post('/api/areas', { json: { name: 'Area 1' } });
    const vehicle = await admin.post('/api/vehicles', {
      json: {
        economicNumber: 'U-1',
        plate: 'ABC1',
        vin: null,
        make: 'T',
        model: 'H',
        year: 2022,
        odometerKm: 1,
        areaId: area.json.id,
      },
    });
    for (const reply of [
      await admin.post(P, { json: body(vehicle.json.id as string) }),
      await admin.get(P),
    ]) {
      expect(reply.status).toBe(500);
      expect(reply.json).toMatchObject({ code: 'internal_error', message: 'Request failed' });
      expect(reply.text).not.toContain('db-prod');
    }
  });
});
