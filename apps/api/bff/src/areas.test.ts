import { afterEach, describe, expect, it } from 'vitest';
import {
  BFF_AREA_ACTIONS,
  BFF_AREA_FIELDS,
  BFF_ROUTES,
} from '../../../../packages/contracts/src/index.js';
import { AREA_ACTIONS, AREA_FIELDS } from '../../../../packages/domain/areas/src/index.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

interface Fixture {
  readonly adminA: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly adminB: Browser;
  readonly ids: { readonly admin: string; readonly editor: string; readonly viewer: string };
}

async function fixture(): Promise<Fixture> {
  world = createBffWorld();
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  const editor = await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const viewer = await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  return {
    adminA: await world.loginAs('subject-admin-a'),
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    adminB: await world.loginAs('subject-admin-b'),
    ids: { admin: a.adminId, editor: editor.identityId, viewer: viewer.identityId },
  };
}

const create = async (browser: Browser, over: Record<string, unknown> = {}) => {
  const reply = await browser.post('/api/areas', { json: { name: 'Operaciones', ...over } });
  if (reply.status !== 201) throw new Error(`create fixture failed: ${reply.status}`);
  return reply.json as { id: string; version: number; depth: number };
};

const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

describe('contract', () => {
  it('declares the same actions and fields as the domain', () => {
    expect([...BFF_AREA_ACTIONS]).toEqual([...AREA_ACTIONS]);
    expect([...BFF_AREA_FIELDS]).toEqual([...AREA_FIELDS]);
  });
  it('protects every area route: reads need a session, writes also the CSRF token', () => {
    const areaRoutes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('areas.'));
    expect(areaRoutes).toHaveLength(7);
    for (const [id, definition] of areaRoutes)
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('areas over HTTP', () => {
  it('creates, reads, lists, edits, moves, deactivates, reactivates and shows the history', async () => {
    const { adminA, ids } = await fixture();
    const created = await adminA.post('/api/areas', {
      json: { name: 'Pais', code: 'mx', responsibleIds: [ids.editor] },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      name: 'Pais',
      code: 'MX',
      parentId: null,
      depth: 1,
      active: true,
      version: 1,
      responsibleIds: [ids.editor],
      deactivatedAt: null,
    });
    expect(created.json).not.toHaveProperty('tenantId');
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.headers['x-correlation-id']).toBeTruthy();
    const id = created.json.id as string;

    const detail = await adminA.get(`/api/areas/${id}`);
    expect(detail.json).toEqual({ ...created.json, resourceCounts: { vehicles: 0, people: 0 } });
    const child = await create(adminA, { name: 'Ciudad', parentId: id });
    expect(child.depth).toBe(2);
    const edited = await adminA.put(`/api/areas/${child.id}`, {
      json: { version: 1, name: 'Ciudad Norte', code: null, responsibleIds: [ids.admin] },
    });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({
      name: 'Ciudad Norte',
      code: null,
      version: 2,
      responsibleIds: [ids.admin],
    });
    const moved = await adminA.put(`/api/areas/${child.id}`, {
      json: { version: 2, parentId: null },
    });
    expect(moved.json).toMatchObject({ parentId: null, depth: 1, version: 3 });
    const off = await adminA.post(`/api/areas/${child.id}/deactivate`, { json: { version: 3 } });
    expect(off.json).toMatchObject({ active: false, version: 4 });
    expect((await adminA.get('/api/areas')).json.items.map((a: { id: string }) => a.id)).toEqual([
      id,
    ]);
    expect((await adminA.get('/api/areas?includeInactive=true')).json.total).toBe(2);
    const on = await adminA.post(`/api/areas/${child.id}/activate`, { json: { version: 4 } });
    expect(on.json).toMatchObject({ active: true, deactivatedAt: null, version: 5 });

    const history = await adminA.get(`/api/areas/${child.id}/history`);
    expect(history.status).toBe(200);
    expect(history.json).toMatchObject({
      total: 5,
      nextCursor: null,
      sort: { field: 'version', direction: 'desc' },
    });
    expect(
      history.json.items.map((e: { action: string; fields: string[] }) => [e.action, e.fields]),
    ).toEqual([
      ['activated', []],
      ['deactivated', []],
      ['updated', ['parent']],
      ['updated', ['name', 'responsibles']],
      ['created', []],
    ]);
    expect(history.json.items[2]).toMatchObject({ fromParentId: id, toParentId: null });
    expect(history.text).not.toContain('Ciudad');
  });

  it('lists roots, children and everything, in name order', async () => {
    const { adminA } = await fixture();
    const b = await create(adminA, { name: 'b' });
    await create(adminA, { name: 'A' });
    await create(adminA, { name: 'C', parentId: b.id });
    const names = async (query: string) =>
      (await adminA.get(`/api/areas${query}`)).json.items.map((a: { name: string }) => a.name);
    expect(await names('')).toEqual(['A', 'b', 'C']);
    expect(await names('?parentId=root')).toEqual(['A', 'b']);
    expect(await names(`?parentId=${b.id}`)).toEqual(['C']);
    expect(await names('?includeInactive=false&limit=50')).toEqual(['A', 'b', 'C']);
    expect((await adminA.get('/api/areas')).json.sort).toEqual({ field: 'name', direction: 'asc' });
  });

  it('pages the list and the history with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB } = await fixture();
    for (let n = 1; n <= 27; n += 1)
      await create(adminA, { name: `Area ${String(n).padStart(2, '0')}` });
    await create(adminB, { name: 'Area 01' });
    const page1 = await adminA.get('/api/areas');
    expect(page1.json.items).toHaveLength(25);
    expect(page1.json.total).toBe(27);
    const cursor = page1.json.nextCursor as string;
    expect(cursor).toBeTruthy();
    const page2 = await adminA.get(`/api/areas?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.items, ...page2.json.items].map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(27);
    for (const path of [
      `/api/areas?cursor=${encodeURIComponent(cursor)}&includeInactive=true`,
      `/api/areas?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `/api/areas?cursor=${encodeURIComponent(cursor)}&parentId=root`,
      `/api/areas?cursor=${encodeURIComponent(`${cursor}x`)}`,
      '/api/areas?cursor=garbage',
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`/api/areas?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);

    // The history is bounded and paged too (25 per page by default, newest first).
    const area = await create(adminA, { name: 'Historia' });
    let version = area.version;
    for (let n = 1; n <= 27; n += 1) {
      const next = await adminA.put(`/api/areas/${area.id}`, {
        json: { version, name: `Historia ${n}` },
      });
      version = next.json.version as number;
    }
    const h1 = await adminA.get(`/api/areas/${area.id}/history`);
    expect(h1.json.items).toHaveLength(25);
    expect(h1.json.total).toBe(28);
    expect(h1.json.items[0].version).toBe(28);
    const hcursor = h1.json.nextCursor as string;
    const h2 = await adminA.get(
      `/api/areas/${area.id}/history?cursor=${encodeURIComponent(hcursor)}`,
    );
    expect(h2.json.items.map((e: { version: number }) => e.version)).toEqual([3, 2, 1]);
    expect(h2.json.nextCursor).toBeNull();
    // A history cursor is bound to its area, to the limit and to the tenant.
    const other = await create(adminA, { name: 'Otra historia' });
    for (const path of [
      `/api/areas/${other.id}/history?cursor=${encodeURIComponent(hcursor)}`,
      `/api/areas/${area.id}/history?cursor=${encodeURIComponent(hcursor)}&limit=50`,
      `/api/areas/${area.id}/history?cursor=${encodeURIComponent(cursor)}`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect(
      (await adminB.get(`/api/areas/${area.id}/history?cursor=${encodeURIComponent(hcursor)}`))
        .status,
    ).toBe(400);
  });
});

describe('who may do what', () => {
  it('answers 401 without a session and 403 for a missing permission, changing nothing', async () => {
    const { adminA, editorA, viewerA } = await fixture();
    const a = await create(adminA);
    const anonymous = world.browser();
    await world.prepare(anonymous);
    const writes: [string, string, unknown][] = [
      ['POST', '/api/areas', { name: 'Nueva' }],
      ['PUT', `/api/areas/${a.id}`, { version: 1, name: 'x' }],
      ['POST', `/api/areas/${a.id}/deactivate`, { version: 1 }],
      ['POST', `/api/areas/${a.id}/activate`, { version: 1 }],
    ];
    const reads: [string, string, unknown?][] = [
      ['GET', '/api/areas'],
      ['GET', `/api/areas/${a.id}`],
      ['GET', `/api/areas/${a.id}/history`],
    ];
    for (const [method, path, json] of [...reads, ...writes])
      expect((await anonymous.send(method, path, { json })).status, `${method} ${path}`).toBe(401);
    for (const [method, path, json] of writes) {
      const denied = await viewerA.send(method, path, { json });
      expect(denied.status, `viewer ${method} ${path}`).toBe(403);
      expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    }
    // The editor may change but not deactivate (soft delete needs `delete`).
    const forbidden = await editorA.post(`/api/areas/${a.id}/deactivate`, { json: { version: 1 } });
    expect(forbidden.status).toBe(403);
    expect((await viewerA.get(`/api/areas/${a.id}`)).json).toMatchObject({
      version: 1,
      active: true,
    });
    expect((await viewerA.get('/api/areas')).json.total).toBe(1);
    expect(
      (await editorA.put(`/api/areas/${a.id}`, { json: { version: 1, name: 'Editor' } })).status,
    ).toBe(200);
  });

  it('requires the CSRF token on every area write', async () => {
    const { adminA } = await fixture();
    const a = await create(adminA);
    for (const [method, path, json] of [
      ['POST', '/api/areas', { name: 'Csrf' }],
      ['PUT', `/api/areas/${a.id}`, { version: 1, name: 'x' }],
      ['POST', `/api/areas/${a.id}/deactivate`, { version: 1 }],
      ['POST', `/api/areas/${a.id}/activate`, { version: 1 }],
    ] as [string, string, unknown][])
      for (const csrf of [null, '', 'forged']) {
        const reply = await adminA.send(method, path, { json, csrf });
        expect(reply.status, `${method} ${path} ${csrf}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect((await adminA.get(`/api/areas/${a.id}`)).json).toMatchObject({
      version: 1,
      name: 'Operaciones',
    });
  });
});

describe('tenant isolation over HTTP', () => {
  it('answers 404 to another tenant exactly as for an unknown id, and changes nothing', async () => {
    const { adminA, adminB } = await fixture();
    const a = await create(adminA);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const calls = (id: string): [string, string, unknown?][] => [
      ['GET', `/api/areas/${id}`],
      ['GET', `/api/areas/${id}/history`],
      ['PUT', `/api/areas/${id}`, { version: 1, name: 'Robada' }],
      ['POST', `/api/areas/${id}/deactivate`, { version: 1 }],
      ['POST', `/api/areas/${id}/activate`, { version: 1 }],
    ];
    const foreign = calls(a.id);
    const missing = calls(unknown);
    for (const [index, [method, path, json]] of foreign.entries()) {
      const x = await adminB.send(method, path, { json });
      const y = await adminB.send(method, (missing[index] as [string, string])[1], { json });
      expect(x.status, path).toBe(404);
      expect(withoutId(x)).toEqual(withoutId(y));
    }
    expect((await adminA.get(`/api/areas/${a.id}`)).json).toMatchObject({
      version: 1,
      name: 'Operaciones',
    });
    expect((await adminB.get('/api/areas')).json.total).toBe(0);
  });

  it('answers a foreign parent exactly as an unknown parent', async () => {
    const { adminA, adminB } = await fixture();
    const theirs = await create(adminB, { name: 'Ajena' });
    const mine = await create(adminA, { name: 'Mia' });
    const unknown = '00000000-0000-4000-8000-000000000000';
    const attempt = async (parentId: string) => [
      withoutId(await adminA.post('/api/areas', { json: { name: 'Hija', parentId } })),
      withoutId(await adminA.put(`/api/areas/${mine.id}`, { json: { version: 1, parentId } })),
    ];
    const foreign = await attempt(theirs.id);
    expect(foreign).toEqual(await attempt(unknown));
    expect(foreign[0]).toMatchObject({
      code: 'invalid_hierarchy',
      message: 'Unprocessable request',
    });
    expect((await adminA.get('/api/areas?parentId=' + theirs.id)).json.total).toBe(0);
  });

  it('refuses tenant hints in headers, query strings and bodies', async () => {
    const { adminA, adminB } = await fixture();
    await create(adminB, { name: 'Beta' });
    expect(
      (await adminA.get('/api/areas', { headers: { 'x-tenant-id': 'someone-else' } })).json.total,
    ).toBe(0);
    expect((await adminA.get('/api/areas?tenant=x')).status).toBe(400);
    expect((await adminA.get('/api/areas?tenantId=x')).status).toBe(400);
    for (const extra of [
      { tenantId: 'x' },
      { companyId: 'x' },
      { active: false },
      { id: 'x' },
      { depth: 1 },
    ])
      expect((await adminA.post('/api/areas', { json: { name: 'X', ...extra } })).status).toBe(400);
  });
});

describe('errors', () => {
  it('uses uniform bodies with the documented status for each business conflict', async () => {
    const { adminA } = await fixture();
    const root = await create(adminA, { name: 'Raiz', code: 'R' });
    const second = await create(adminA, { name: 'Segunda' });

    const dup = await adminA.post('/api/areas', { json: { name: 'RAIZ' } });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ code: 'duplicate', message: 'Conflict', field: 'name' });
    const dupCode = await adminA.put(`/api/areas/${second.id}`, {
      json: { version: 1, code: 'r' },
    });
    expect(dupCode.json).toMatchObject({ code: 'duplicate', field: 'code' });

    const stale = await adminA.put(`/api/areas/${root.id}`, { json: { version: 7, name: 'x' } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'stale_version', message: 'Conflict' });
    expect(stale.json).not.toHaveProperty('field');

    const child = await create(adminA, { name: 'Hija', parentId: root.id });
    const inUse = await adminA.post(`/api/areas/${root.id}/deactivate`, { json: { version: 1 } });
    expect(inUse.status).toBe(409);
    expect(inUse.json).toMatchObject({
      code: 'area_in_use',
      message: 'Conflict',
      field: 'sub_areas',
    });
    expect(Object.keys(inUse.json).sort()).toEqual([
      'code',
      'correlationId',
      'field',
      'message',
      'status',
    ]);

    const cycle = await adminA.put(`/api/areas/${root.id}`, {
      json: { version: 1, parentId: child.id },
    });
    expect(cycle.status).toBe(422);
    expect(cycle.json).toMatchObject({
      code: 'invalid_hierarchy',
      message: 'Unprocessable request',
    });
    const stranger = await adminA.post('/api/areas', {
      json: { name: 'X', responsibleIds: ['no-such-user'] },
    });
    expect(stranger.status).toBe(422);
    expect(stranger.json).toMatchObject({ code: 'invalid_responsible' });
    expect(stranger.json).not.toHaveProperty('field');

    expect(
      (await adminA.post(`/api/areas/${root.id}/activate`, { json: { version: 1 } })).json.code,
    ).toBe('invalid_transition');
    const off = await adminA.post(`/api/areas/${second.id}/deactivate`, { json: { version: 1 } });
    expect(off.status).toBe(200);
    const immutable = await adminA.put(`/api/areas/${second.id}`, {
      json: { version: 2, name: 'x' },
    });
    expect(immutable.status).toBe(409);
    expect(immutable.json.code).toBe('immutable');
  });

  it('refuses to deactivate an area with active vehicles (409, naming the kind only)', async () => {
    const { adminA } = await fixture();
    const area = await create(adminA);
    const car = await adminA.post('/api/vehicles', {
      json: {
        economicNumber: 'U-1',
        plate: 'ABC123',
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId: area.id,
        odometerKm: 10,
      },
    });
    expect(car.status).toBe(201);
    const blocked = await adminA.post(`/api/areas/${area.id}/deactivate`, { json: { version: 1 } });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ code: 'area_in_use', field: 'vehicles' });
    expect(blocked.text).not.toMatch(/\b1\b/);
    expect((await adminA.get(`/api/areas/${area.id}`)).json.resourceCounts).toEqual({
      vehicles: 1,
      people: 0,
    });
    await adminA.post(`/api/vehicles/${car.json.id}/archive`, { json: { version: 1 } });
    expect(
      (await adminA.post(`/api/areas/${area.id}/deactivate`, { json: { version: 1 } })).status,
    ).toBe(200);
  });

  it('rejects malformed bodies and unknown properties with a uniform 400 that echoes nothing', async () => {
    const { adminA } = await fixture();
    const a = await create(adminA);
    const secret = 'SECRET-<script>-VALUE';
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/areas', { name: 'x', extra: secret }],
      ['POST', '/api/areas', { code: 'only' }],
      ['POST', '/api/areas', { name: secret.repeat(10) }],
      ['POST', '/api/areas', { name: 5 }],
      ['POST', '/api/areas', { name: 'x', code: 'bad code' }],
      ['POST', '/api/areas', { name: 'x', parentId: 5 }],
      ['POST', '/api/areas', { name: 'x', responsibleIds: secret }],
      ['POST', '/api/areas', { name: 'x', responsibleIds: [secret] }],
      ['POST', '/api/areas', []],
      ['PUT', `/api/areas/${a.id}`, { name: 'no version' }],
      ['PUT', `/api/areas/${a.id}`, { version: 1 }],
      ['PUT', `/api/areas/${a.id}`, { version: 1, active: false }],
      ['PUT', `/api/areas/${a.id}`, { version: 1, depth: 2 }],
      ['PUT', `/api/areas/${a.id}`, { version: 'one', name: 'x' }],
      ['PUT', `/api/areas/${a.id}`, { version: 1, parentId: 'bad id' }],
      ['POST', `/api/areas/${a.id}/deactivate`, {}],
      ['POST', `/api/areas/${a.id}/deactivate`, { version: 1, force: true }],
      ['POST', `/api/areas/${a.id}/activate`, { version: '1' }],
    ];
    for (const [method, path, json] of attempts) {
      const reply = await adminA.send(method, path, { json });
      expect(reply.status, `${method} ${path} ${JSON.stringify(json)}`).toBe(400);
      expect(reply.json).toMatchObject({ code: 'bad_request', message: 'Invalid request' });
      expect(reply.text).not.toContain(secret);
    }
    expect((await adminA.send('POST', '/api/areas', { raw: 'not json' })).status).toBe(400);
    expect((await adminA.get(`/api/areas/${a.id}`)).json.version).toBe(1);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { adminA } = await fixture();
    const a = await create(adminA);
    for (const query of [
      '?limit=10',
      '?limit=25&limit=50',
      '?parentId=a/b',
      '?parentId=',
      '?includeInactive=yes',
      '?includeArchived=true',
      '?sort=name',
      '?q=x',
    ])
      expect((await adminA.get(`/api/areas${query}`)).status, query).toBe(400);
    for (const query of [
      '?limit=10',
      '?limit=25&limit=50',
      '?sort=version',
      '?parentId=x',
      '?includeInactive=true',
    ])
      expect((await adminA.get(`/api/areas/${a.id}/history${query}`)).status, query).toBe(400);
  });

  it('answers 404 for malformed ids and 405 for the wrong method', async () => {
    const { adminA } = await fixture();
    expect((await adminA.get('/api/areas/has%20space')).status).toBe(404);
    expect((await adminA.get(`/api/areas/${'a'.repeat(65)}`)).status).toBe(404);
    const wrong = await adminA.send('DELETE', '/api/areas/abc');
    expect(wrong.status).toBe(405);
    expect(wrong.headers['allow']).toBe('GET, PUT');
    expect((await adminA.send('PUT', '/api/areas/abc/deactivate', { json: {} })).status).toBe(405);
    expect((await adminA.send('GET', '/api/areas/abc/activate')).status).toBe(405);
    expect((await adminA.send('DELETE', '/api/areas')).headers['allow']).toBe('GET, POST');
  });

  it('never leaks internals when the store fails', async () => {
    world = createBffWorld({
      adapters: {
        areas: {
          transaction: async () => {
            throw new Error('connection to db-prod.internal refused');
          },
          find: async () => null,
          list: async () => {
            throw new Error('db-prod.internal exploded');
          },
          history: async () => {
            throw new Error('db-prod.internal exploded');
          },
        },
      },
    });
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const admin = await world.loginAs('subject-admin-a');
    for (const reply of [
      await admin.post('/api/areas', { json: { name: 'X' } }),
      await admin.get('/api/areas'),
    ]) {
      expect(reply.status).toBe(500);
      expect(reply.json).toMatchObject({ code: 'internal_error', message: 'Request failed' });
      expect(reply.text).not.toContain('db-prod');
    }
  });
});
