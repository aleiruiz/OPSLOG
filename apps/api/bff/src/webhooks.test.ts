import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES, bffPath, bffRouteIds } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const W = '/api/v1/webhooks/endpoints';
const URL_A = 'https://hooks.receiver-a.example.com/opslog';
const NONE = '00000000-0000-4000-8000-000000000001';
const resolver = async (host: string) =>
  host.startsWith('private')
    ? [{ address: '10.0.0.5', family: 4 as const }]
    : [{ address: '93.184.216.34', family: 4 as const }];

async function fixture() {
  world = createBffWorld({
    adapters: {
      webhookResolver: resolver,
      webhookClient: { send: async () => ({ status: 200, durationMs: 3, failure: null }) },
    },
  });
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  return {
    adminA: await world.loginAs('subject-admin-a'),
    adminB: await world.loginAs('subject-admin-b'),
    editorA: await world.loginAs('subject-editor-a'),
  };
}

describe('contract', () => {
  it('declares the nine webhook routes with their protection', () => {
    const ids = bffRouteIds.filter((id) => id.startsWith('webhooks.'));
    expect(ids).toHaveLength(9);
    expect(BFF_ROUTES['webhooks.list']).toMatchObject({ method: 'GET', kind: 'session' });
    expect(BFF_ROUTES['webhooks.deliveries']).toMatchObject({ method: 'GET', kind: 'session' });
    for (const id of ids.filter(
      (item) => !['webhooks.list', 'webhooks.get', 'webhooks.deliveries'].includes(item),
    ))
      expect(BFF_ROUTES[id as keyof typeof BFF_ROUTES]).toMatchObject({ kind: 'session-csrf' });
    expect(BFF_ROUTES['webhooks.update'].method).toBe('PATCH');
    expect(bffPath('webhooks.rotate', { endpointId: 'e 1' })).toBe(`${W}/e%201/rotate-secret`);
  });
});

describe('endpoints', () => {
  it('needs a session, the CSRF token and the integrations permission', async () => {
    const { adminA, editorA } = await fixture();
    expect((await world.browser().get(W)).status).toBe(401);
    expect(
      (await adminA.post(W, { json: { url: URL_A, events: ['vehicle.created'] }, csrf: null }))
        .status,
    ).toBe(403);
    expect((await editorA.get(W)).status).toBe(403);
    expect(
      (await editorA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } })).status,
    ).toBe(403);
  });

  it('shows the secret once, never again, and reads without tenant data', async () => {
    const { adminA } = await fixture();
    const made = await adminA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } });
    expect(made.status, made.text).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    const secret = made.json.secret as string;
    const id = made.json.endpoint.id as string;
    for (const path of [W, `${W}/${id}`, `${W}/${id}/deliveries`]) {
      const read = await adminA.get(path);
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(secret);
      expect(read.text).not.toMatch(/tenantId|secret/);
    }
    const list = (await adminA.get(W)).json;
    expect(list.max).toBe(5);
    expect(list.items[0].events).toEqual(['vehicle.created']);
  });

  it('edits with the version, rotates, tests, deletes and answers 404 across companies', async () => {
    const { adminA, adminB } = await fixture();
    const made = await adminA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } });
    const id = made.json.endpoint.id as string;
    const patched = await adminA.send('PATCH', `${W}/${id}`, {
      json: { version: 1, active: false },
    });
    expect(patched.json).toMatchObject({ active: false, version: 2 });
    expect(
      (await adminA.send('PATCH', `${W}/${id}`, { json: { version: 1, active: true } })).status,
    ).toBe(409);
    const rotated = await adminA.post(`${W}/${id}/rotate-secret`, { json: { version: 2 } });
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).not.toBe(made.json.secret);
    expect((await adminA.post(`${W}/${id}/test`, { json: {} })).status).toBe(409);
    await adminA.send('PATCH', `${W}/${id}`, { json: { version: 3, active: true } });
    expect((await adminA.post(`${W}/${id}/test`, { json: {} })).status).toBe(200);

    for (const [method, path] of [
      ['GET', `${W}/${id}`],
      ['PATCH', `${W}/${id}`],
      ['DELETE', `${W}/${id}`],
      ['POST', `${W}/${id}/rotate-secret`],
      ['POST', `${W}/${id}/test`],
      ['GET', `${W}/${id}/deliveries`],
      ['POST', `${W}/${id}/deliveries/${NONE}/retry`],
    ] as const)
      expect(
        (await adminB.send(method, path, { json: method === 'GET' ? undefined : { version: 1 } }))
          .status,
        `${method} ${path}`,
      ).toBe(404);

    expect((await adminA.delete(`${W}/${id}`)).status).toBe(204);
    expect((await adminA.get(`${W}/${id}`)).status).toBe(404);
  });

  it('is strict with bodies, queries and destinations', async () => {
    const { adminA } = await fixture();
    const bad: Record<string, unknown>[] = [
      { url: URL_A },
      { url: URL_A, events: [] },
      { url: URL_A, events: ['vehicle.deleted'] },
      { url: URL_A, events: ['vehicle.created'], extra: 1 },
      { url: 'http://hooks.receiver-a.example.com/x', events: ['vehicle.created'] },
      { url: 'https://private.receiver.example.com/x', events: ['vehicle.created'] },
      { url: 'https://169.254.169.254/x', events: ['vehicle.created'] },
    ];
    for (const json of bad)
      expect((await adminA.post(W, { json })).status, JSON.stringify(json)).toBe(400);
    const id = (await adminA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } })).json
      .endpoint.id as string;
    expect((await adminA.get(`${W}/${id}/deliveries?limit=x`)).status).toBe(400);
    expect((await adminA.get(`${W}/${id}/deliveries?other=1`)).status).toBe(400);
    expect((await adminA.get(`${W}/${id}/deliveries?limit=5&offset=0`)).status).toBe(200);
  });
});
