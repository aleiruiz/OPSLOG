import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BFF_DOCUMENT_OWNER_TYPES,
  BFF_DOCUMENT_STATUSES,
  BFF_ROUTES,
} from '../../../../packages/contracts/src/index.js';
import {
  DOCUMENT_OWNER_TYPES,
  DOCUMENT_STATUSES,
} from '../../../../packages/domain/documents/src/index.js';
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
  readonly employeeA: string;
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
    const employee = await browser.post('/api/employees', {
      json: { kind: 'other', firstName: 'Luis', lastName: 'Gomez', areaId: area.json.id },
    });
    if (vehicle.status !== 201 || employee.status !== 201) throw new Error('owner fixture failed');
    return { vehicle: vehicle.json.id as string, employee: employee.json.id as string };
  };
  const a = await owners(adminA);
  const b = await owners(adminB);
  return {
    adminA,
    adminB,
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    vehicleA: a.vehicle,
    employeeA: a.employee,
    vehicleB: b.vehicle,
  };
}

const body = (ownerId: string, over: Record<string, unknown> = {}) => ({
  ownerType: 'vehicle',
  ownerId,
  typeCode: 'registration_card',
  title: 'Tarjeta de circulación',
  expiresOn: '2027-03-31',
  ...over,
});

const create = async (browser: Browser, ownerId: string, over: Record<string, unknown> = {}) => {
  const reply = await browser.post('/api/documents', { json: body(ownerId, over) });
  if (reply.status !== 201) throw new Error(`create fixture failed: ${reply.status}`);
  return reply.json as { id: string; version: number };
};

const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

describe('contract', () => {
  it('declares the same owner types and statuses as the domain', () => {
    expect([...BFF_DOCUMENT_OWNER_TYPES]).toEqual([...DOCUMENT_OWNER_TYPES]);
    expect([...BFF_DOCUMENT_STATUSES]).toEqual([...DOCUMENT_STATUSES]);
  });
  it('protects every document route: reads need a session, writes also the CSRF token', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('documents.'));
    expect(routes).toHaveLength(7);
    for (const [id, definition] of routes)
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('documents over HTTP', () => {
  it('creates, reads, lists, edits, renews, archives and shows the revisions', async () => {
    const { adminA, vehicleA } = await fixture();
    const created = await adminA.post('/api/documents', {
      json: body(vehicleA, { issuedOn: '2025-03-31', documentNumber: 'tc-001', notes: 'Original' }),
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      ownerType: 'vehicle',
      ownerId: vehicleA,
      typeCode: 'registration_card',
      title: 'Tarjeta de circulación',
      notes: 'Original',
      revision: 1,
      issuedOn: '2025-03-31',
      expiresOn: '2027-03-31',
      documentNumber: 'TC-001',
      status: 'valid',
      daysToExpiry: 176,
      version: 1,
      archivedAt: null,
    });
    expect(created.json).not.toHaveProperty('tenantId');
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.headers['x-correlation-id']).toBeTruthy();
    const id = created.json.id as string;

    expect((await adminA.get(`/api/documents/${id}`)).json).toMatchObject({ id, version: 1 });
    const edited = await adminA.put(`/api/documents/${id}`, {
      json: { version: 1, title: 'Nueva', notes: null },
    });
    expect(edited.json).toMatchObject({ title: 'Nueva', notes: null, version: 2, revision: 1 });
    const renewed = await adminA.post(`/api/documents/${id}/renew`, {
      json: { version: 2, issuedOn: '2026-10-01', expiresOn: '2026-10-20' },
    });
    expect(renewed.status).toBe(200);
    expect(renewed.json).toMatchObject({
      revision: 2,
      version: 3,
      status: 'expiring',
      daysToExpiry: 14,
      documentNumber: null,
    });
    const history = await adminA.get(`/api/documents/${id}/history`);
    expect(history.status).toBe(200);
    expect(
      history.json.items.map((r: { revision: number; status: string }) => [r.revision, r.status]),
    ).toEqual([
      [2, 'expiring'],
      [1, 'replaced'],
    ]);
    expect(history.json.items[0]).toMatchObject({ actorId: expect.stringMatching(/^user-/) });
    const archived = await adminA.post(`/api/documents/${id}/archive`, { json: { version: 3 } });
    expect(archived.json.archivedAt).not.toBeNull();
    expect((await adminA.get('/api/documents')).json).toMatchObject({ items: [], total: 0 });
    expect((await adminA.get('/api/documents?includeArchived=true')).json.items).toHaveLength(1);
  });

  it('pages with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB, vehicleA, vehicleB } = await fixture();
    for (let n = 1; n <= 27; n += 1)
      await create(adminA, vehicleA, { expiresOn: `2027-01-${String(n).padStart(2, '0')}` });
    await create(adminB, vehicleB);
    const page1 = await adminA.get('/api/documents');
    expect(page1.json.items).toHaveLength(25);
    expect(page1.json.total).toBe(27);
    expect(page1.json.sort).toEqual({ field: 'expiresOn', direction: 'asc' });
    const cursor = page1.json.nextCursor as string;
    const page2 = await adminA.get(`/api/documents?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.items, ...page2.json.items].map((v: { id: string }) => v.id);
    expect(new Set(ids).size).toBe(27);
    for (const path of [
      `/api/documents?cursor=${encodeURIComponent(cursor)}&status=expired`,
      `/api/documents?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `/api/documents?cursor=${encodeURIComponent(`${cursor}x`)}`,
      '/api/documents?cursor=garbage',
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`/api/documents?cursor=${encodeURIComponent(cursor)}`)).status).toBe(
      400,
    );
  });

  it('pages the revisions with a cursor bound to the document and the page size', async () => {
    const { adminA, vehicleA } = await fixture();
    const one = await create(adminA, vehicleA);
    const two = await create(adminA, vehicleA);
    for (let n = 0; n < 26; n += 1) {
      const reply = await adminA.post(`/api/documents/${one.id}/renew`, {
        json: { version: n + 1, expiresOn: `2028-01-${String(n + 1).padStart(2, '0')}` },
      });
      expect(reply.status).toBe(200);
    }
    const first = await adminA.get(`/api/documents/${one.id}/history`);
    expect(first.json.items).toHaveLength(25);
    expect(first.json.total).toBe(27);
    expect(first.json.sort).toEqual({ field: 'revision', direction: 'desc' });
    const cursor = encodeURIComponent(first.json.nextCursor as string);
    const second = await adminA.get(`/api/documents/${one.id}/history?cursor=${cursor}`);
    expect(second.json.items).toHaveLength(2);
    expect(second.json.nextCursor).toBeNull();
    for (const path of [
      `/api/documents/${two.id}/history?cursor=${cursor}`,
      `/api/documents/${one.id}/history?cursor=${cursor}&limit=50`,
      `/api/documents/${one.id}/history?cursor=garbage`,
      `/api/documents/${one.id}/history?status=valid`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
  });

  it('filters by owner, type, derived status and archived flag', async () => {
    const { adminA, vehicleA, employeeA } = await fixture();
    const expired = await create(adminA, vehicleA, { title: 'Vencida', expiresOn: '2026-10-01' });
    await create(adminA, vehicleA, { title: 'Por vencer', expiresOn: '2026-10-20' });
    await create(adminA, vehicleA, {
      title: 'Vigente',
      typeCode: 'ownership_title',
      expiresOn: null,
    });
    await create(adminA, employeeA, {
      ownerType: 'employee',
      typeCode: 'medical_exam',
      title: 'Examen',
      expiresOn: '2027-01-01',
    });
    const titles = async (query: string) =>
      (await adminA.get(`/api/documents${query}`)).json.items.map(
        (v: { title: string }) => v.title,
      );
    expect(await titles('?status=expired')).toEqual(['Vencida']);
    expect(await titles('?status=expiring')).toEqual(['Por vencer']);
    expect(await titles('?status=valid')).toEqual(['Examen', 'Vigente']);
    expect(await titles('?ownerType=employee')).toEqual(['Examen']);
    expect(await titles(`?ownerType=vehicle&ownerId=${vehicleA}&typeCode=ownership_title`)).toEqual(
      ['Vigente'],
    );
    await adminA.post(`/api/documents/${expired.id}/archive`, { json: { version: 1 } });
    expect(await titles('?status=expired')).toEqual([]);
    expect(await titles('?status=expired&includeArchived=true')).toEqual(['Vencida']);
  });
});

describe('who may do what', () => {
  it('answers 401 without a session and 403 for a missing permission, changing nothing', async () => {
    const { adminA, editorA, viewerA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const anonymous = world.browser();
    await world.prepare(anonymous);
    const calls = (): [string, string, unknown?][] => [
      ['GET', '/api/documents'],
      ['GET', `/api/documents/${v.id}`],
      ['GET', `/api/documents/${v.id}/history`],
      ['POST', '/api/documents', body(vehicleA)],
      ['PUT', `/api/documents/${v.id}`, { version: 1, title: 'x' }],
      ['POST', `/api/documents/${v.id}/renew`, { version: 1, expiresOn: '2030-01-01' }],
      ['POST', `/api/documents/${v.id}/archive`, { version: 1 }],
    ];
    for (const [method, path, json] of calls())
      expect((await anonymous.send(method, path, { json })).status, `${method} ${path}`).toBe(401);
    for (const [method, path, json] of calls().slice(3)) {
      const denied = await viewerA.send(method, path, { json });
      expect(denied.status, `viewer ${method} ${path}`).toBe(403);
      expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    }
    expect(
      (await editorA.post(`/api/documents/${v.id}/archive`, { json: { version: 1 } })).status,
    ).toBe(403);
    expect((await viewerA.get(`/api/documents/${v.id}`)).json).toMatchObject({
      version: 1,
      archivedAt: null,
    });
    expect(
      (await editorA.put(`/api/documents/${v.id}`, { json: { version: 1, title: 'Editor' } }))
        .status,
    ).toBe(200);
    expect(
      (
        await editorA.post(`/api/documents/${v.id}/renew`, {
          json: { version: 2, expiresOn: '2030-01-01' },
        })
      ).status,
    ).toBe(200);
  });

  it('requires the CSRF token on every document write', async () => {
    const { adminA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    for (const [method, path, json] of [
      ['POST', '/api/documents', body(vehicleA)],
      ['PUT', `/api/documents/${v.id}`, { version: 1, title: 'x' }],
      ['POST', `/api/documents/${v.id}/renew`, { version: 1, expiresOn: '2030-01-01' }],
      ['POST', `/api/documents/${v.id}/archive`, { version: 1 }],
    ] as [string, string, unknown][])
      for (const csrf of [null, '', 'forged']) {
        const reply = await adminA.send(method, path, { json, csrf });
        expect(reply.status, `${method} ${path} ${csrf}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect((await adminA.get(`/api/documents/${v.id}`)).json).toMatchObject({
      version: 1,
      title: 'Tarjeta de circulación',
    });
  });
});

describe('tenant isolation over HTTP', () => {
  it('answers 404 to another tenant exactly as for an unknown id, and changes nothing', async () => {
    const { adminA, adminB, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const calls = (id: string): [string, string, unknown?][] => [
      ['GET', `/api/documents/${id}`],
      ['GET', `/api/documents/${id}/history`],
      ['PUT', `/api/documents/${id}`, { version: 1, title: 'Robado' }],
      ['POST', `/api/documents/${id}/renew`, { version: 1, expiresOn: '2030-01-01' }],
      ['POST', `/api/documents/${id}/archive`, { version: 1 }],
    ];
    const foreign = calls(v.id);
    const missing = calls(unknown);
    for (const [index, [method, path, json]] of foreign.entries()) {
      const a = await adminB.send(method, path, { json });
      const b = await adminB.send(method, (missing[index] as [string, string])[1], { json });
      expect(a.status, path).toBe(404);
      expect(withoutId(a)).toEqual(withoutId(b));
    }
    expect((await adminA.get(`/api/documents/${v.id}`)).json).toMatchObject({
      version: 1,
      title: 'Tarjeta de circulación',
    });
    expect((await adminB.get('/api/documents')).json.total).toBe(0);
  });

  it('answers the same 422 for an owner of another tenant, an unknown owner and an archived one', async () => {
    const { adminA, adminB, vehicleA, vehicleB } = await fixture();
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
      await adminA.post('/api/documents', { json: body(vehicleB) }),
      await adminA.post('/api/documents', { json: body('00000000-0000-4000-8000-000000000000') }),
      await adminA.post('/api/documents', { json: body(archived.json.id as string) }),
      await adminA.post('/api/documents', {
        json: body(vehicleA, { ownerType: 'employee', typeCode: 'medical_exam' }),
      }),
    ];
    for (const reply of attempts) {
      expect(reply.status).toBe(422);
      expect(reply.json).toMatchObject({ code: 'invalid_owner', field: 'owner_id' });
    }
    expect(new Set(attempts.map((reply) => JSON.stringify(withoutId(reply)))).size).toBe(1);
    expect((await adminB.get('/api/documents')).json.total).toBe(0);
    expect((await adminA.get('/api/documents')).json.total).toBe(0);
  });

  it('refuses tenant hints in headers, query strings and bodies', async () => {
    const { adminA, adminB, vehicleA, vehicleB } = await fixture();
    await create(adminB, vehicleB);
    expect(
      (await adminA.get('/api/documents', { headers: { 'x-tenant-id': 'someone-else' } })).json
        .total,
    ).toBe(0);
    expect((await adminA.get('/api/documents?tenant=x')).status).toBe(400);
    expect((await adminA.get('/api/documents?tenantId=x')).status).toBe(400);
    for (const extra of [{ tenantId: 'x' }, { companyId: 'x' }, { status: 'expired' }, { id: 'x' }])
      expect((await adminA.post('/api/documents', { json: body(vehicleA, extra) })).status).toBe(
        400,
      );
  });
});

describe('errors', () => {
  it('uses uniform bodies with the documented status for each business conflict', async () => {
    const { adminA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const stale = await adminA.put(`/api/documents/${v.id}`, { json: { version: 7, title: 'x' } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'stale_version', message: 'Conflict' });
    expect(stale.json).not.toHaveProperty('field');
    const staleRenew = await adminA.post(`/api/documents/${v.id}/renew`, {
      json: { version: 7, expiresOn: '2030-01-01' },
    });
    expect(staleRenew.json.code).toBe('stale_version');
    const archived = await adminA.post(`/api/documents/${v.id}/archive`, { json: { version: 1 } });
    expect(archived.status).toBe(200);
    for (const reply of [
      await adminA.put(`/api/documents/${v.id}`, { json: { version: 2, title: 'x' } }),
      await adminA.post(`/api/documents/${v.id}/renew`, {
        json: { version: 2, expiresOn: '2030-01-01' },
      }),
      await adminA.post(`/api/documents/${v.id}/archive`, { json: { version: 2 } }),
    ]) {
      expect(reply.status).toBe(409);
      expect(reply.json.code).toBe('immutable');
    }
  });

  it('rejects malformed bodies and unknown properties with a uniform 400 that echoes nothing', async () => {
    const { adminA, vehicleA } = await fixture();
    const v = await create(adminA, vehicleA);
    const secret = 'SECRET-<script>-VALUE';
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/documents', { ...body(vehicleA), extra: secret }],
      ['POST', '/api/documents', { title: 'only' }],
      ['POST', '/api/documents', body(vehicleA, { title: `${secret}\u0007` })],
      ['POST', '/api/documents', body(vehicleA, { typeCode: secret })],
      ['POST', '/api/documents', body(vehicleA, { ownerType: 'policy' })],
      ['POST', '/api/documents', body(vehicleA, { typeCode: 'medical_exam' })],
      ['POST', '/api/documents', body(vehicleA, { expiresOn: null })],
      ['POST', '/api/documents', body(vehicleA, { expiresOn: '2027-02-30' })],
      ['POST', '/api/documents', body(vehicleA, { issuedOn: '2099-01-01' })],
      ['POST', '/api/documents', body(vehicleA, { documentNumber: secret })],
      ['POST', '/api/documents', []],
      ['PUT', `/api/documents/${v.id}`, { title: 'no version' }],
      ['PUT', `/api/documents/${v.id}`, { version: 1 }],
      ['PUT', `/api/documents/${v.id}`, { version: 1, expiresOn: '2030-01-01' }],
      ['PUT', `/api/documents/${v.id}`, { version: 'one', title: 'x' }],
      ['POST', `/api/documents/${v.id}/renew`, { expiresOn: '2030-01-01' }],
      ['POST', `/api/documents/${v.id}/renew`, { version: 1 }],
      ['POST', `/api/documents/${v.id}/renew`, { version: 1, expiresOn: '2030-01-01', title: 'x' }],
      ['POST', `/api/documents/${v.id}/archive`, {}],
      ['POST', `/api/documents/${v.id}/archive`, { version: 1, force: true }],
    ];
    for (const [method, path, json] of attempts) {
      const reply = await adminA.send(method, path, { json });
      expect(reply.status, `${method} ${path} ${JSON.stringify(json)}`).toBe(400);
      expect(reply.json).toMatchObject({ code: 'bad_request', message: 'Invalid request' });
      expect(reply.text).not.toContain(secret);
    }
    expect((await adminA.send('POST', '/api/documents', { raw: 'not json' })).status).toBe(400);
    expect((await adminA.get(`/api/documents/${v.id}`)).json.version).toBe(1);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { adminA } = await fixture();
    for (const query of [
      '?limit=10',
      '?limit=25&limit=50',
      '?status=Vencido',
      '?status=',
      '?ownerType=policy',
      '?ownerId=veh-1',
      '?ownerType=vehicle&ownerId=a/b',
      '?typeCode=Not%20A%20Code',
      '?includeArchived=yes',
      '?sort=expiresOn',
      '?q=TC-1',
    ])
      expect((await adminA.get(`/api/documents${query}`)).status, query).toBe(400);
  });

  it('answers 404 for malformed ids and 405 for the wrong method', async () => {
    const { adminA } = await fixture();
    expect((await adminA.get('/api/documents/has%20space')).status).toBe(404);
    expect((await adminA.get(`/api/documents/${'a'.repeat(65)}`)).status).toBe(404);
    const wrong = await adminA.send('DELETE', '/api/documents/abc');
    expect(wrong.status).toBe(405);
    expect(wrong.headers['allow']).toBe('GET, PUT');
    expect((await adminA.send('PUT', '/api/documents/abc/renew', { json: {} })).status).toBe(405);
    expect((await adminA.send('GET', '/api/documents/abc/archive')).status).toBe(405);
  });

  it('never leaks internals when the store fails', async () => {
    world = createBffWorld({
      adapters: {
        documents: {
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
      await admin.post('/api/documents', { json: body(vehicle.json.id as string) }),
      await admin.get('/api/documents'),
    ]) {
      expect(reply.status).toBe(500);
      expect(reply.json).toMatchObject({ code: 'internal_error', message: 'Request failed' });
      expect(reply.text).not.toContain('db-prod');
    }
  });
});
