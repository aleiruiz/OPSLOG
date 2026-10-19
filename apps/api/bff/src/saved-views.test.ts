import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES, bffPath, bffRouteIds } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const P = '/api/v1/views';

async function fixture() {
  world = createBffWorld();
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  await world.member('subject-admin-a', 'auditor', 'subject-auditor-a');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  return {
    a,
    adminA: await world.loginAs('subject-admin-a'),
    adminB: await world.loginAs('subject-admin-b'),
    viewerA: await world.loginAs('subject-viewer-a'),
    auditorA: await world.loginAs('subject-auditor-a'),
    editorA: await world.loginAs('subject-editor-a'),
  };
}

const create = (extra: Record<string, unknown> = {}) => ({
  module: 'maintenance',
  name: 'Vencidas del taller',
  filters: { overdue: 'true', status: 'scheduled' },
  ...extra,
});

describe('saved views routes', () => {
  it('are routes of the contract', () => {
    for (const id of [
      'views.list',
      'views.create',
      'views.update',
      'views.delete',
      'views.columns',
      'views.columnsSave',
    ] as const)
      expect(bffRouteIds).toContain(id);
    expect(BFF_ROUTES['views.create']).toMatchObject({
      method: 'POST',
      kind: 'session-csrf',
      status: 201,
    });
    expect(BFF_ROUTES['views.delete']).toMatchObject({ method: 'DELETE', status: 204 });
    expect(bffPath('views.list', {}, { module: 'vehicles' })).toBe(`${P}?module=vehicles`);
    expect(bffPath('views.columns', { module: 'incidents' })).toBe(`${P}/columns/incidents`);
  });

  it('need a session, and a CSRF token to change anything', async () => {
    world = createBffWorld();
    const anonymous = world.browser();
    expect((await anonymous.get(`${P}?module=vehicles`)).status).toBe(401);
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const admin = await world.loginAs('subject-admin-a');
    const noCsrf = await admin.post(P, { json: create(), csrf: null });
    expect(noCsrf.status).toBe(403);
  });

  it('keeps a view per user: private views are invisible (404) to the rest of the company', async () => {
    const { adminA, viewerA } = await fixture();
    const made = await adminA.post(P, { json: create() });
    expect(made.status, made.text).toBe(201);
    expect(made.json).toMatchObject({ mine: true, canEdit: true, version: 1, shared: false });
    const id = made.json.id as string;
    expect((await viewerA.get(`${P}?module=maintenance`)).json.items).toEqual([]);
    const patch = await viewerA.send('PATCH', `${P}/${id}`, {
      json: { version: 1, name: 'Robada' },
    });
    expect(patch.status).toBe(404);
    expect((await viewerA.delete(`${P}/${id}`)).status).toBe(404);
    expect((await adminA.get(`${P}?module=maintenance`)).json.items).toHaveLength(1);
  });

  it('isolates companies: a view and its id of company A mean nothing to B', async () => {
    const { adminA, adminB } = await fixture();
    const made = await adminA.post(P, { json: create({ shared: true }) });
    const id = made.json.id as string;
    expect((await adminB.get(`${P}?module=maintenance`)).json.items).toEqual([]);
    expect(
      (await adminB.send('PATCH', `${P}/${id}`, { json: { version: 1, name: 'x' } })).status,
    ).toBe(404);
    expect((await adminB.delete(`${P}/${id}`)).status).toBe(404);
    const same = await adminB.post(P, { json: create({ shared: true }) });
    expect(same.status).toBe(201);
    expect(same.json.id).not.toBe(id);
    expect((await adminA.get(`${P}?module=maintenance`)).json.items).toHaveLength(1);
  });

  it('drops with a notice, for a reader without view_costs, the cost filter and column of a shared view', async () => {
    const { adminA, viewerA } = await fixture();
    const made = await adminA.post(P, {
      json: create({
        shared: true,
        filters: { status: 'scheduled', costFrom: '1000' },
        columns: ['order', 'status', 'cost'],
      }),
    });
    expect(made.status, made.text).toBe(201);
    const seen = (await viewerA.get(`${P}?module=maintenance`)).json.items[0];
    expect(seen).toMatchObject({
      mine: false,
      canEdit: false,
      filters: { status: 'scheduled' },
      columns: ['order', 'status'],
    });
    expect(seen.dropped).toEqual([
      { kind: 'filter', key: 'costFrom', label: 'Costo desde', reason: 'permission' },
      { kind: 'column', key: 'cost', label: 'Costo', reason: 'permission' },
    ]);
    // The viewer cannot save a view that names the cost filter either.
    const refused = await viewerA.post(P, {
      json: create({ name: 'Mía', filters: { costFrom: '5' } }),
    });
    expect(refused.status).toBe(403);
  });

  it('forbids editing the shared view of another member without manage_config, and allows an admin', async () => {
    const { adminA, editorA } = await fixture();
    const made = await editorA.post(P, { json: create({ shared: true }) });
    const id = made.json.id as string;
    const byAdmin = await adminA.send('PATCH', `${P}/${id}`, {
      json: { version: 1, name: 'Del admin' },
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.json).toMatchObject({
      name: 'Del admin',
      version: 2,
      mine: false,
      canEdit: true,
    });
    // The editor owns it and edits with the current version; the old one is a 409.
    expect(
      (await editorA.send('PATCH', `${P}/${id}`, { json: { version: 1, shared: false } })).status,
    ).toBe(409);
    const own = await editorA.send('PATCH', `${P}/${id}`, { json: { version: 2, shared: false } });
    expect(own.status).toBe(200);
    // Unshared again, the admin no longer sees it.
    expect((await adminA.get(`${P}?module=maintenance`)).json.items).toEqual([]);
  });

  it('forbids a shared view of someone else to a member without manage_config (403)', async () => {
    const { adminA, editorA } = await fixture();
    const made = await adminA.post(P, { json: create({ shared: true }) });
    const id = made.json.id as string;
    expect(
      (await editorA.send('PATCH', `${P}/${id}`, { json: { version: 1, name: 'x' } })).status,
    ).toBe(403);
    expect((await editorA.delete(`${P}/${id}`)).status).toBe(403);
    expect((await adminA.delete(`${P}/${id}`)).status).toBe(204);
  });

  it('rejects a repeated name (409), the 51st view (422) and unknown or malformed input (400)', async () => {
    const { adminA } = await fixture();
    expect((await adminA.post(P, { json: create() })).status).toBe(201);
    expect((await adminA.post(P, { json: create({ name: 'VENCIDAS DEL TALLER' }) })).status).toBe(
      409,
    );
    for (let index = 1; index < 50; index += 1)
      expect((await adminA.post(P, { json: create({ name: `v${index}` }) })).status).toBe(201);
    const full = await adminA.post(P, { json: create({ name: 'de más' }) });
    expect(full.status).toBe(422);
    expect(full.json.field).toBe('view_limit');
    const bad = [
      create({ filters: { nope: '1' } }),
      create({ filters: { status: 'no' } }),
      create({ module: 'users' }),
      create({ sort: { field: 'folio', direction: 'asc' } }),
      create({ columns: ['order', 'order'] }),
      create({ extra: true }),
      { module: 'maintenance' },
    ];
    for (const json of bad) expect((await adminA.post(P, { json })).status).toBe(400);
    expect((await adminA.post(P, { raw: '{"module":', json: undefined })).status).toBe(400);
    expect((await adminA.get(`${P}?module=users`)).status).toBe(400);
    expect((await adminA.get(`${P}?module=vehicles&x=1`)).status).toBe(400);
    expect((await adminA.get(P)).status).toBe(400);
  });

  it('closes the list of siniestros to a reader without incidents:view', async () => {
    const { auditorA } = await fixture();
    expect((await auditorA.get(`${P}?module=incidents`)).status).toBe(403);
    expect((await auditorA.get(`${P}?module=vehicles`)).status).toBe(200);
    expect((await auditorA.get(`${P}/columns/incidents`)).status).toBe(403);
  });

  it('keeps the visible columns per member on the server', async () => {
    const { adminA, viewerA } = await fixture();
    expect((await adminA.get(`${P}/columns/vehicles`)).json).toEqual({
      module: 'vehicles',
      columns: null,
      dropped: [],
    });
    const saved = await adminA.put(`${P}/columns/vehicles`, {
      json: { columns: ['economicNumber', 'plate', 'actions'] },
    });
    expect(saved.status, saved.text).toBe(200);
    expect((await adminA.get(`${P}/columns/vehicles`)).json.columns).toEqual([
      'economicNumber',
      'plate',
      'actions',
    ]);
    expect((await viewerA.get(`${P}/columns/vehicles`)).json.columns).toBeNull();
    expect(
      (await adminA.put(`${P}/columns/vehicles`, { json: { columns: ['cost'] } })).status,
    ).toBe(400);
    expect(
      (await viewerA.put(`${P}/columns/maintenance`, { json: { columns: ['order', 'cost'] } }))
        .status,
    ).toBe(403);
    expect(
      (await adminA.put(`${P}/columns/vehicles`, { json: { columns: null } })).json.columns,
    ).toBeNull();
  });
});
