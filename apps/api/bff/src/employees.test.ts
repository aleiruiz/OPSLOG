import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BFF_EMPLOYEE_KINDS,
  BFF_EMPLOYEE_STATUSES,
  BFF_ROUTES,
} from '../../../../packages/contracts/src/index.js';
import {
  EMPLOYEE_KINDS,
  EMPLOYEE_STATUSES,
} from '../../../../packages/domain/employees/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../composition/src/testing.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

const areaIds = { a1: '', a2: '', b1: '' };
const defaultArea = new Map<Browser, string>();

const SECRETS = {
  nationalId: 'SYNTH-ID-7788-QX',
  phone: '+52 55 9000 1234',
  email: 'ana.perez@synthetic.example',
  licenseNumber: 'LIC-445566-ZZ',
};

let serial = 0;
const body = (over: Record<string, unknown> = {}) => {
  serial += 1;
  return {
    kind: 'driver',
    firstName: 'Ana',
    lastName: 'Perez',
    areaId: areaIds.a1,
    employeeNumber: `E-${serial}`,
    idType: 'ine',
    ...SECRETS,
    nationalId: `SYNTH-ID-7788-Q${serial}`,
    email: `ana.perez${serial}@synthetic.example`,
    licenseNumber: `LIC-445566-${serial}`,
    licenseType: 'c',
    licenseExpiresOn: '2099-01-31',
    ...over,
  };
};

interface Fixture {
  readonly adminA: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly piiA: Browser;
  readonly adminB: Browser;
}

async function fixture(): Promise<Fixture> {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  await world.member('subject-admin-a', 'pii_reader', 'subject-pii-a');
  const fx = {
    adminA: await world.loginAs('subject-admin-a'),
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    piiA: await world.loginAs('subject-pii-a'),
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
  for (const browser of [fx.adminA, fx.editorA, fx.viewerA, fx.piiA])
    defaultArea.set(browser, areaIds.a1);
  defaultArea.set(fx.adminB, areaIds.b1);
  return fx;
}

const create = async (browser: Browser, over: Record<string, unknown> = {}) => {
  const reply = await browser.post('/api/employees', {
    json: body({ areaId: defaultArea.get(browser), ...over }),
  });
  if (reply.status !== 201) throw new Error(`create fixture failed: ${reply.status}`);
  return reply.json as { id: string; version: number };
};

const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

describe('contract', () => {
  it('declares the same kinds and statuses as the domain', () => {
    expect([...BFF_EMPLOYEE_KINDS]).toEqual([...EMPLOYEE_KINDS]);
    expect([...BFF_EMPLOYEE_STATUSES]).toEqual([...EMPLOYEE_STATUSES]);
  });
  it('protects every employee route: reads need a session, writes also the CSRF token', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('employees.'));
    expect(routes).toHaveLength(7);
    for (const [id, definition] of routes)
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('employees over HTTP', () => {
  it('creates, reads, lists, edits, changes status, archives and shows the history', async () => {
    const { adminA } = await fixture();
    const created = await adminA.post('/api/employees', { json: body() });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Perez',
      status: 'active',
      version: 1,
      archivedAt: null,
      licenseType: 'C',
      piiPresent: { nationalId: true, phone: true, email: true, licenseNumber: true },
      fitness: { fit: true, reasons: [] },
    });
    expect(created.json).not.toHaveProperty('tenantId');
    expect(created.json).not.toHaveProperty('pii');
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.headers['x-correlation-id']).toBeTruthy();
    const id = created.json.id as string;

    const read = await adminA.get(`/api/employees/${id}`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ id, pii: { phone: '+525590001234' } });
    const edited = await adminA.put(`/api/employees/${id}`, {
      json: { version: 1, position: 'Jefe', phone: null },
    });
    expect(edited.json).toMatchObject({
      position: 'Jefe',
      version: 2,
      piiPresent: { phone: false },
    });
    const moved = await adminA.post(`/api/employees/${id}/status`, {
      json: { version: 2, status: 'suspended', reason: 'Caso 12' },
    });
    expect(moved.json).toMatchObject({ status: 'suspended', statusReason: 'Caso 12', version: 3 });
    const history = await adminA.get(`/api/employees/${id}/history`);
    expect(history.status).toBe(200);
    expect(history.json.items.map((e: { from: unknown; to: string }) => [e.from, e.to])).toEqual([
      ['active', 'suspended'],
      [null, 'active'],
    ]);
    const archived = await adminA.post(`/api/employees/${id}/archive`, { json: { version: 3 } });
    expect(archived.json.archivedAt).not.toBeNull();
    expect((await adminA.get('/api/employees')).json).toMatchObject({ items: [], total: 0 });
    expect((await adminA.get('/api/employees?includeArchived=true')).json.items).toHaveLength(1);
  });

  it('never returns personal data in a list, a write response or the history', async () => {
    const { adminA, piiA } = await fixture();
    const made = await create(adminA);
    await adminA.put(`/api/employees/${made.id}`, { json: { version: 1, phone: SECRETS.phone } });
    for (const browser of [adminA, piiA]) {
      const texts = [
        (await browser.get('/api/employees')).text,
        (await browser.get(`/api/employees/${made.id}/history`)).text,
      ];
      for (const text of texts)
        for (const fragment of [
          'SYNTH-ID-7788',
          'ID-7788-QX',
          '9000 1234',
          'synthetic.example',
          'LIC-445566',
        ])
          expect(text, fragment).not.toContain(fragment);
    }
  });

  it('pages with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB } = await fixture();
    for (let n = 1; n <= 27; n += 1)
      await create(adminA, { lastName: `Apellido ${'abcdefghijklmnopqrstuvwxyz'[n - 1]}` });
    await create(adminB, { lastName: 'Otro' });
    const page1 = await adminA.get('/api/employees');
    expect(page1.json.items).toHaveLength(25);
    expect(page1.json.total).toBe(27);
    const cursor = page1.json.nextCursor as string;
    expect(cursor).toBeTruthy();
    const page2 = await adminA.get(`/api/employees?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.items, ...page2.json.items].map((v: { id: string }) => v.id);
    expect(new Set(ids).size).toBe(27);
    for (const path of [
      `/api/employees?cursor=${encodeURIComponent(cursor)}&status=inactive`,
      `/api/employees?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `/api/employees?cursor=${encodeURIComponent(`${cursor}x`)}`,
      '/api/employees?cursor=garbage',
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`/api/employees?cursor=${encodeURIComponent(cursor)}`)).status).toBe(
      400,
    );
  });

  it('pages the history with a cursor bound to the employee and the page size', async () => {
    const { adminA } = await fixture();
    const one = await create(adminA);
    const two = await create(adminA);
    let version = 1;
    for (let n = 0; n < 30; n += 1) {
      const status = n % 2 === 0 ? 'inactive' : 'active';
      const reply = await adminA.post(`/api/employees/${one.id}/status`, {
        json: { version, status, reason: `Cambio ${n}` },
      });
      expect(reply.status).toBe(200);
      version += 1;
    }
    const first = await adminA.get(`/api/employees/${one.id}/history`);
    expect(first.json.items).toHaveLength(25);
    expect(first.json.total).toBe(31);
    const cursor = encodeURIComponent(first.json.nextCursor as string);
    const second = await adminA.get(`/api/employees/${one.id}/history?cursor=${cursor}`);
    expect(second.json.items).toHaveLength(6);
    expect(second.json.nextCursor).toBeNull();
    for (const path of [
      `/api/employees/${two.id}/history?cursor=${cursor}`,
      `/api/employees/${one.id}/history?cursor=${cursor}&limit=50`,
      `/api/employees/${one.id}/history?cursor=garbage`,
      `/api/employees/${one.id}/history?kind=status`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
  });

  it('filters by kind, status, area and archived flag', async () => {
    const { adminA } = await fixture();
    const one = await create(adminA, { lastName: 'A' });
    await create(adminA, {
      lastName: 'B',
      kind: 'dispatcher',
      licenseNumber: undefined,
      licenseType: undefined,
      licenseExpiresOn: undefined,
      areaId: areaIds.a2,
    });
    await adminA.post(`/api/employees/${one.id}/status`, {
      json: { version: 1, status: 'inactive', reason: 'Temporada' },
    });
    const names = async (query: string) =>
      (await adminA.get(`/api/employees${query}`)).json.items.map(
        (v: { lastName: string }) => v.lastName,
      );
    expect(await names('?status=inactive')).toEqual(['A']);
    expect(await names('?kind=dispatcher')).toEqual(['B']);
    expect(await names(`?areaId=${areaIds.a2}`)).toEqual(['B']);
    expect(await names('?includeArchived=false&limit=50')).toEqual(['A', 'B']);
  });
});

describe('who may do what', () => {
  it('answers 401 without a session and 403 for a missing permission, changing nothing', async () => {
    const { adminA, editorA, viewerA } = await fixture();
    const v = await create(adminA);
    const anonymous = world.browser();
    await world.prepare(anonymous);
    const calls = (): [string, string, unknown?][] => [
      ['GET', '/api/employees'],
      ['GET', `/api/employees/${v.id}`],
      ['GET', `/api/employees/${v.id}/history`],
      ['POST', '/api/employees', body()],
      ['PUT', `/api/employees/${v.id}`, { version: 1, position: 'x' }],
      ['POST', `/api/employees/${v.id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/employees/${v.id}/archive`, { version: 1 }],
    ];
    for (const [method, path, json] of calls())
      expect((await anonymous.send(method, path, { json })).status, `${method} ${path}`).toBe(401);
    for (const [method, path, json] of calls().slice(3)) {
      const denied = await viewerA.send(method, path, { json });
      expect(denied.status, `viewer ${method} ${path}`).toBe(403);
      expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    }
    expect(
      (await editorA.post(`/api/employees/${v.id}/archive`, { json: { version: 1 } })).status,
    ).toBe(403);
    expect((await viewerA.get(`/api/employees/${v.id}`)).json).toMatchObject({
      version: 1,
      archivedAt: null,
    });
    expect(
      (await editorA.put(`/api/employees/${v.id}`, { json: { version: 1, position: 'Editor' } }))
        .status,
    ).toBe(200);
  });

  it('masks personal data for roles without view_pii and refuses their writes of it', async () => {
    const { adminA, editorA, viewerA, piiA } = await fixture();
    const v = await create(adminA);
    const masked = await viewerA.get(`/api/employees/${v.id}`);
    expect(masked.json.pii).toBeNull();
    for (const fragment of [
      'SYNTH-ID-7788',
      'ID-7788-QX',
      '9000 1234',
      'synthetic.example',
      'LIC-445566',
    ])
      expect(masked.text, fragment).not.toContain(fragment);
    expect((await piiA.get(`/api/employees/${v.id}`)).json.pii).toMatchObject({
      phone: '+525590001234',
    });
    // an editor cannot write or probe personal data, even to learn that it is a duplicate
    const probe = await editorA.post('/api/employees', {
      json: body({ nationalId: SECRETS.nationalId }),
    });
    expect(probe.status).toBe(403);
    const patch = await editorA.put(`/api/employees/${v.id}`, {
      json: { version: 1, email: SECRETS.email },
    });
    expect(patch.status).toBe(403);
    expect(patch.text).not.toContain(SECRETS.email);
  });

  it('requires the CSRF token on every employee write', async () => {
    const { adminA } = await fixture();
    const v = await create(adminA);
    for (const [method, path, json] of [
      ['POST', '/api/employees', body()],
      ['PUT', `/api/employees/${v.id}`, { version: 1, position: 'x' }],
      ['POST', `/api/employees/${v.id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/employees/${v.id}/archive`, { version: 1 }],
    ] as [string, string, unknown][])
      for (const csrf of [null, '', 'forged']) {
        const reply = await adminA.send(method, path, { json, csrf });
        expect(reply.status, `${method} ${path} ${csrf}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect((await adminA.get(`/api/employees/${v.id}`)).json).toMatchObject({
      version: 1,
      position: null,
    });
  });
});

describe('tenant isolation over HTTP', () => {
  it('answers 404 to another tenant exactly as for an unknown id, and changes nothing', async () => {
    const { adminA, adminB } = await fixture();
    const v = await create(adminA);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const calls = (id: string): [string, string, unknown?][] => [
      ['GET', `/api/employees/${id}`],
      ['GET', `/api/employees/${id}/history`],
      ['PUT', `/api/employees/${id}`, { version: 1, position: 'Robado' }],
      ['PUT', `/api/employees/${id}`, { version: 1, phone: SECRETS.phone }],
      ['POST', `/api/employees/${id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/employees/${id}/archive`, { version: 1 }],
    ];
    const foreign = calls(v.id);
    const missing = calls(unknown);
    for (const [index, [method, path, json]] of foreign.entries()) {
      const a = await adminB.send(method, path, { json });
      const b = await adminB.send(method, (missing[index] as [string, string])[1], { json });
      expect(a.status, path).toBe(404);
      expect(withoutId(a)).toEqual(withoutId(b));
    }
    expect((await adminA.get(`/api/employees/${v.id}`)).json).toMatchObject({
      version: 1,
      position: null,
    });
    expect((await adminB.get('/api/employees')).json.total).toBe(0);
  });

  it('refuses tenant hints in headers, query strings and bodies', async () => {
    const { adminA, adminB } = await fixture();
    await create(adminB);
    expect(
      (await adminA.get('/api/employees', { headers: { 'x-tenant-id': 'someone-else' } })).json
        .total,
    ).toBe(0);
    expect((await adminA.get('/api/employees?tenant=x')).status).toBe(400);
    expect((await adminA.get('/api/employees?tenantId=x')).status).toBe(400);
    for (const extra of [
      { tenantId: 'x' },
      { companyId: 'x' },
      { status: 'terminated' },
      { id: 'x' },
      { pii: {} },
    ])
      expect((await adminA.post('/api/employees', { json: body(extra) })).status).toBe(400);
  });
});

describe('errors', () => {
  it('uses uniform bodies with the documented status for each business conflict', async () => {
    const { adminA, piiA } = await fixture();
    const v = await create(adminA, { employeeNumber: 'U-1', nationalId: SECRETS.nationalId });
    const dupNumber = await adminA.post('/api/employees', {
      json: body({ employeeNumber: 'u-1' }),
    });
    expect(dupNumber.status).toBe(409);
    expect(dupNumber.json).toMatchObject({
      code: 'duplicate',
      message: 'Conflict',
      field: 'employee_number',
    });
    const dupId = await adminA.post('/api/employees', {
      json: body({ nationalId: 'synth id 7788 qx' }),
    });
    expect(dupId.json).toMatchObject({ code: 'duplicate', field: 'national_id' });
    expect(dupId.text).not.toContain('SYNTH-ID-7788');
    // the reader of personal data gets the same answer
    expect(
      (await piiA.post('/api/employees', { json: body({ nationalId: SECRETS.nationalId }) })).json,
    ).toMatchObject({ code: 'duplicate', field: 'national_id' });

    const stale = await adminA.put(`/api/employees/${v.id}`, {
      json: { version: 7, position: 'x' },
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'stale_version', message: 'Conflict' });
    expect(stale.json).not.toHaveProperty('field');

    const transition = await adminA.post(`/api/employees/${v.id}/status`, {
      json: { version: 1, status: 'active', reason: 'x' },
    });
    expect(transition.status).toBe(409);

    const area = await adminA.post('/api/employees', { json: body({ areaId: 'desconocida' }) });
    expect(area.status).toBe(422);
    expect(area.json).toMatchObject({ code: 'invalid_area', field: 'area_id' });

    const gone = await adminA.post(`/api/employees/${v.id}/status`, {
      json: { version: 1, status: 'terminated', reason: 'Renuncia' },
    });
    expect(gone.status).toBe(200);
    const immutable = await adminA.put(`/api/employees/${v.id}`, {
      json: { version: 2, position: 'x' },
    });
    expect(immutable.status).toBe(409);
    expect(immutable.json.code).toBe('immutable');
  });

  it('rejects malformed bodies and unknown properties with a uniform 400 that echoes nothing', async () => {
    const { adminA } = await fixture();
    const v = await create(adminA);
    const secret = 'SECRET-<script>-VALUE';
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/employees', { ...body(), extra: secret }],
      ['POST', '/api/employees', { firstName: 'only' }],
      ['POST', '/api/employees', body({ firstName: secret })],
      ['POST', '/api/employees', body({ email: secret })],
      ['POST', '/api/employees', body({ nationalId: secret })],
      ['POST', '/api/employees', body({ kind: 'robot' })],
      ['POST', '/api/employees', []],
      ['PUT', `/api/employees/${v.id}`, { position: 'no version' }],
      ['PUT', `/api/employees/${v.id}`, { version: 1 }],
      ['PUT', `/api/employees/${v.id}`, { version: 1, status: 'inactive' }],
      ['PUT', `/api/employees/${v.id}`, { version: 1, kind: 'other' }],
      ['PUT', `/api/employees/${v.id}`, { version: 'one', position: 'x' }],
      ['POST', `/api/employees/${v.id}/status`, { version: 1, status: 'Activo', reason: 'x' }],
      ['POST', `/api/employees/${v.id}/status`, { version: 1, status: 'inactive' }],
      ['POST', `/api/employees/${v.id}/status`, { version: 1, status: 'inactive', reason: '' }],
      ['POST', `/api/employees/${v.id}/archive`, {}],
      ['POST', `/api/employees/${v.id}/archive`, { version: 1, force: true }],
    ];
    for (const [method, path, json] of attempts) {
      const reply = await adminA.send(method, path, { json });
      expect(reply.status, `${method} ${path} ${JSON.stringify(json)}`).toBe(400);
      expect(reply.json).toMatchObject({ code: 'bad_request', message: 'Invalid request' });
      expect(reply.text).not.toContain(secret);
    }
    expect((await adminA.send('POST', '/api/employees', { raw: 'not json' })).status).toBe(400);
    expect((await adminA.get(`/api/employees/${v.id}`)).json.version).toBe(1);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { adminA } = await fixture();
    for (const query of [
      '?limit=10',
      '?limit=25&limit=50',
      '?status=Activo',
      '?status=',
      '?kind=robot',
      '?areaId=a/b',
      '?includeArchived=yes',
      '?sort=lastName',
      '?q=SYNTH-1',
      '?nationalId=SYNTH-1',
    ])
      expect((await adminA.get(`/api/employees${query}`)).status, query).toBe(400);
  });

  it('answers 404 for malformed ids and 405 for the wrong method', async () => {
    const { adminA } = await fixture();
    expect((await adminA.get('/api/employees/has%20space')).status).toBe(404);
    expect((await adminA.get(`/api/employees/${'a'.repeat(65)}`)).status).toBe(404);
    const wrong = await adminA.send('DELETE', '/api/employees/abc');
    expect(wrong.status).toBe(405);
    expect(wrong.headers['allow']).toBe('GET, PUT');
    expect((await adminA.send('PUT', '/api/employees/abc/status', { json: {} })).status).toBe(405);
    expect((await adminA.send('GET', '/api/employees/abc/archive')).status).toBe(405);
  });

  it('never leaks internals or personal data when the store fails', async () => {
    world = createBffWorld({
      adapters: {
        pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')),
        employees: {
          insert: async () => {
            throw new Error(`connection to db-prod.internal refused for ${SECRETS.nationalId}`);
          },
          find: async () => null,
          list: async () => {
            throw new Error('db-prod.internal exploded');
          },
          replace: async () => false,
          history: async () => {
            throw new Error('db-prod.internal exploded');
          },
          countLiveInArea: async () => 0,
        },
      },
    });
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const admin = await world.loginAs('subject-admin-a');
    const area = await admin.post('/api/areas', { json: { name: 'Area 1' } });
    for (const reply of [
      await admin.post('/api/employees', { json: body({ areaId: area.json.id }) }),
      await admin.get('/api/employees'),
    ]) {
      expect(reply.status).toBe(500);
      expect(reply.json).toMatchObject({ code: 'internal_error', message: 'Request failed' });
      expect(reply.text).not.toContain('db-prod');
      expect(reply.text).not.toContain(SECRETS.nationalId);
    }
  });

  it('writes personal data neither to the console nor to the process streams', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const { adminA, viewerA } = await fixture();
    const v = await create(adminA, SECRETS);
    await adminA.get(`/api/employees/${v.id}`);
    await viewerA.get(`/api/employees/${v.id}`);
    await adminA.post('/api/employees', { json: body({ nationalId: SECRETS.nationalId }) });
    const written = [
      ...spies.flatMap((spy) => spy.mock.calls),
      ...out.mock.calls,
      ...err.mock.calls,
    ]
      .flat()
      .join(' ');
    for (const value of Object.values(SECRETS)) expect(written).not.toContain(value);
  });
});
