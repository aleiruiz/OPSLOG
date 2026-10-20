import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES, bffPath, bffRouteIds } from '../../../../packages/contracts/src/index.js';
import { SinkMailAdapter } from '../../../../packages/platform/mail/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const NOTICES = '/api/v1/notifications';

/** Two companies; A has an admin, an editor and a viewer. Joining members already left a notice for the admin. */
async function fixture() {
  const mail = new SinkMailAdapter({ retain: 50 });
  world = createBffWorld({ adapters: { mail } });
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  await world.member('subject-admin-b', 'editor', 'subject-editor-b');
  await world.platform.runtime.drainOutbox();
  return {
    mail,
    adminA: await world.loginAs('subject-admin-a'),
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    adminB: await world.loginAs('subject-admin-b'),
  };
}

describe('contract', () => {
  it('declares the notification routes with their protection', () => {
    const ids = bffRouteIds.filter((id) => id.startsWith('notifications.'));
    expect(ids).toHaveLength(12);
    expect(BFF_ROUTES['notifications.read']).toMatchObject({
      method: 'POST',
      kind: 'session-csrf',
    });
    expect(BFF_ROUTES['notifications.list']).toMatchObject({ method: 'GET', kind: 'session' });
    expect(BFF_ROUTES['notifications.unsubscribe']).toMatchObject({
      method: 'DELETE',
      status: 204,
    });
    expect(bffPath('notifications.read', { notificationId: 'n 1' })).toBe(`${NOTICES}/n%201/read`);
  });
});

describe('center', () => {
  it('needs a session, counts what is unread and lists newest first without company or person', async () => {
    const f = await fixture();
    expect((await world.browser().get(NOTICES)).status).toBe(401);
    const count = await f.adminA.get(`${NOTICES}/unread-count`);
    expect(count.json).toEqual({ unread: 2 });
    const list = await f.adminA.get(`${NOTICES}?limit=1`);
    expect(list.status, list.text).toBe(200);
    expect(list.json).toMatchObject({ total: 2, unread: 2, offset: 0, limit: 1 });
    expect(Object.keys(list.json.items[0]).sort()).toEqual([
      'createdAt',
      'entityId',
      'entityType',
      'eventKind',
      'id',
      'link',
      'readAt',
      'severity',
      'title',
    ]);
    expect(list.json.items[0]).toMatchObject({
      eventKind: 'membership_created',
      link: '/configuracion/usuarios',
    });
    expect(list.text).not.toContain('subject-');
    // The member who joined has their own notice; nobody else's.
    expect((await f.editorA.get(`${NOTICES}/unread-count`)).json).toEqual({ unread: 1 });
  });

  it('marks one notice, then all, as read; a notice of someone else is not found', async () => {
    const f = await fixture();
    const first = (await f.adminA.get(NOTICES)).json.items[0].id as string;
    expect((await f.editorA.post(`${NOTICES}/${first}/read`)).status).toBe(404);
    expect((await f.adminB.post(`${NOTICES}/${first}/read`)).status).toBe(404);
    expect((await f.adminA.post(`${NOTICES}/${first}/read`, { csrf: null })).status).toBe(403);
    const read = await f.adminA.post(`${NOTICES}/${first}/read`);
    expect(read.status, read.text).toBe(200);
    expect(read.json.readAt).not.toBeNull();
    expect((await f.adminA.get(`${NOTICES}?unread=true`)).json.total).toBe(1);
    expect((await f.adminA.post(`${NOTICES}/read-all`)).json).toEqual({ changed: 1 });
    expect((await f.adminA.get(`${NOTICES}/unread-count`)).json).toEqual({ unread: 0 });
    expect((await f.adminA.get(`${NOTICES}?kind=export_ready`)).json.total).toBe(0);
  });

  it('keeps the two companies apart: counters, lists and reads do not cross', async () => {
    const f = await fixture();
    expect((await f.adminB.get(`${NOTICES}/unread-count`)).json).toEqual({ unread: 1 });
    const own = (await f.adminB.get(NOTICES)).json;
    const other = (await f.adminA.get(NOTICES)).json;
    const ids = new Set(other.items.map((n: { id: string }) => n.id));
    expect(own.items.every((n: { id: string }) => !ids.has(n.id))).toBe(true);
    expect((await f.adminB.post(`${NOTICES}/read-all`)).json).toEqual({ changed: 1 });
    expect((await f.adminA.get(`${NOTICES}/unread-count`)).json).toEqual({ unread: 2 });
  });

  it('answers a uniform 400 for a malformed query', async () => {
    const f = await fixture();
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=x',
      '?offset=-1',
      '?kind=nope',
      '?unread=yes',
      '?x=1',
      '?limit=1&limit=2',
    ])
      expect((await f.adminA.get(`${NOTICES}${query}`)).status, query).toBe(400);
  });
});

describe('preferences', () => {
  it('shows the matrix with the mandatory kinds fixed, saves a choice and refuses to switch one off', async () => {
    const f = await fixture();
    const matrix = await f.viewerA.get('/api/v1/notification-preferences');
    expect(matrix.status, matrix.text).toBe(200);
    const row = (kind: string) =>
      matrix.json.items.find((i: { eventKind: string }) => i.eventKind === kind);
    expect(row('export_ready')).toMatchObject({ mandatory: true, inApp: true, email: true });
    expect(row('incident_created')).toMatchObject({ mandatory: false });
    const saved = await f.viewerA.put('/api/v1/notification-preferences', {
      json: { items: [{ eventKind: 'document_expiring', inApp: true, email: false }] },
    });
    expect(saved.status, saved.text).toBe(200);
    expect(
      saved.json.items.find((i: { eventKind: string }) => i.eventKind === 'document_expiring'),
    ).toMatchObject({ email: false });
    const refused = await f.viewerA.put('/api/v1/notification-preferences', {
      json: { items: [{ eventKind: 'export_ready', inApp: false, email: false }] },
    });
    expect(refused.status).toBe(422);
    expect(refused.json.field).toBe('mandatory');
    expect(
      (await f.viewerA.put('/api/v1/notification-preferences', { json: { items: 'x', extra: 1 } }))
        .status,
    ).toBe(400);
    expect(
      (await f.viewerA.put('/api/v1/notification-preferences', { json: { items: [] }, csrf: null }))
        .status,
    ).toBe(403);
  });
});

describe('subscriptions', () => {
  it('lists, validates and refuses what is not followable', async () => {
    const f = await fixture();
    expect((await f.editorA.get('/api/v1/subscriptions')).json).toEqual({ items: [] });
    expect((await f.editorA.get('/api/v1/subscriptions?type=vehicle')).status).toBe(200);
    expect((await f.editorA.get('/api/v1/subscriptions?type=export')).status).toBe(400);
    expect((await f.editorA.put('/api/v1/subscriptions/export/e1')).status).toBe(400);
    // The vehicle does not exist: it cannot be followed.
    expect((await f.editorA.put('/api/v1/subscriptions/vehicle/missing')).status).toBe(404);
    expect((await f.viewerA.put('/api/v1/subscriptions/incident/missing')).status).toBe(404);
    const gone = await f.editorA.delete('/api/v1/subscriptions/vehicle/missing');
    expect(gone.status).toBe(204);
    expect(
      (await f.editorA.delete('/api/v1/subscriptions/vehicle/missing', { csrf: null })).status,
    ).toBe(403);
  });

  it('follows a vehicle that exists, once, and keeps it to the company', async () => {
    const f = await fixture();
    const area = (await f.adminA.post('/api/areas', { json: { name: 'Taller' } })).json
      .id as string;
    const created = await f.adminA.post('/api/vehicles', {
      json: {
        economicNumber: 'ECO-1',
        plate: 'AAA-001',
        make: 'Nissan',
        model: 'NP300',
        year: 2023,
        areaId: area,
        odometerKm: 1,
      },
    });
    expect(created.status, created.text).toBe(201);
    const id = created.json.id as string;
    const url = `/api/v1/subscriptions/vehicle/${id}`;
    expect((await f.editorA.put(url)).status).toBe(200);
    expect((await f.editorA.put(url)).status).toBe(200);
    expect((await f.editorA.get('/api/v1/subscriptions')).json.items).toHaveLength(1);
    expect((await f.adminB.get('/api/v1/subscriptions')).json.items).toHaveLength(0);
    expect((await f.adminB.put(url)).status).toBe(404);
    expect((await f.editorA.delete(url)).status).toBe(204);
    expect((await f.editorA.get('/api/v1/subscriptions')).json.items).toHaveLength(0);
  });
});

describe('company rule and failed deliveries', () => {
  it('belong to the administrator who manages the configuration', async () => {
    const f = await fixture();
    for (const browser of [f.editorA, f.viewerA]) {
      expect((await browser.get('/api/v1/notification-rules')).status).toBe(403);
      expect((await browser.get('/api/v1/notification-deliveries/failed')).status).toBe(403);
      expect(
        (
          await browser.put('/api/v1/notification-rules', {
            json: { emailKinds: [], quietHours: false },
          })
        ).status,
      ).toBe(403);
    }
    const rule = await f.adminA.get('/api/v1/notification-rules');
    expect(rule.json).toMatchObject({ quietHours: false, updatedAt: null });
    expect(rule.json.emailKinds).toContain('export_ready');
    const saved = await f.adminA.put('/api/v1/notification-rules', {
      json: { emailKinds: ['export_ready'], quietHours: true },
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toMatchObject({ emailKinds: ['export_ready'], quietHours: true });
    expect((await f.adminB.get('/api/v1/notification-rules')).json.quietHours).toBe(false);
    expect(
      (
        await f.adminA.put('/api/v1/notification-rules', {
          json: { emailKinds: ['nope'], quietHours: true },
        })
      ).status,
    ).toBe(400);
    expect((await f.adminA.get('/api/v1/notification-deliveries/failed')).json).toEqual({
      items: [],
      total: 0,
      offset: 0,
      limit: 25,
    });
    expect((await f.adminA.get('/api/v1/notification-deliveries/failed?limit=0')).status).toBe(400);
  });
});
