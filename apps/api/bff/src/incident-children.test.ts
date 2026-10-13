import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES } from '../../../../packages/contracts/src/index.js';
import { SYNTHETIC_MALWARE_MARKER } from '../../../../packages/platform/files/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

async function fixture() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const adminA = await world.loginAs('subject-admin-a');
  const managerA = await world.loginAs('subject-manager-a');
  const editorA = await world.loginAs('subject-editor-a');
  const adminB = await world.loginAs('subject-admin-b');
  const area = await adminA.post('/api/areas', { json: { name: 'Taller' } });
  const vehicle = await adminA.post('/api/vehicles', {
    json: {
      economicNumber: 'I-001',
      plate: 'INC-001',
      make: 'Nissan',
      model: 'NP300',
      year: 2023,
      areaId: area.json.id,
      odometerKm: 5000,
    },
  });
  const created = await managerA.post(P, {
    json: { vehicleId: vehicle.json.id, type: 'collision' },
  });
  expect(created.status, created.text).toBe(201);
  return { adminA, managerA, editorA, adminB, id: created.json.id as string };
}

const P = '/api/v1/incidents';
const png = (extra: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 7),
  ]);
const pdf = (extra: number) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(extra, 32)]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const body = (version: number, bytes: Buffer, contentType: string, extra: object = {}) => ({
  version,
  category: 'photo',
  stage: 'on_site',
  name: 'foto.png',
  contentType,
  contentBase64: bytes.toString('base64'),
  ...extra,
});

describe('incident third party and evidence contract', () => {
  it('declares session reads and CSRF-protected writes with bounded bodies', () => {
    const ids = Object.keys(BFF_ROUTES).filter(
      (id) => id.startsWith('incidents.thirdParties.') || id.startsWith('incidents.evidence.'),
    );
    expect(ids.sort()).toEqual([
      'incidents.evidence.content',
      'incidents.evidence.detach',
      'incidents.evidence.list',
      'incidents.evidence.upload',
      'incidents.thirdParties.create',
      'incidents.thirdParties.list',
      'incidents.thirdParties.remove',
      'incidents.thirdParties.update',
    ]);
    for (const id of ids) {
      const route = BFF_ROUTES[id as keyof typeof BFF_ROUTES];
      expect(route.kind, id).toBe(route.method === 'GET' ? 'session' : 'session-csrf');
    }
  });
});

describe('third parties over HTTP', () => {
  it('adds, edits, lists and removes with identity protected without view_pii (cases 10, 11)', async () => {
    const f = await fixture();
    const T = `${P}/${f.id}/third-parties`;
    const input = {
      version: 1,
      kind: 'vehicle',
      name: 'Tercero Sintetico',
      contact: '+525500000000',
      plates: 'TER-123',
      policyNumber: 'POL-SYNTH-1',
      insurerName: 'Aseguradora Ficticia',
      injuries: false,
    };
    const created = await f.managerA.post(T, {
      json: input,
      headers: { 'idempotency-key': 'tp-key-1' },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.json.version).toBe(2);
    // The manager lacks view_pii: the protected fields are absent, never masked.
    expect(created.json.item).toMatchObject({ kind: 'vehicle', identityRestricted: true });
    expect(created.text).not.toMatch(/Sintetico|TER-123|POL-SYNTH|525500000000/);
    const replay = await f.managerA.post(T, {
      json: input,
      headers: { 'idempotency-key': 'tp-key-1' },
    });
    expect(replay.status, replay.text).toBe(201);
    expect(replay.json.item.id).toBe(created.json.item.id);
    const partyId = created.json.item.id as string;

    const restricted = await f.managerA.get(T);
    expect(restricted.json).toMatchObject({ identityRestricted: true });
    expect(restricted.json.items).toHaveLength(1);
    expect(restricted.text).not.toMatch(/Sintetico|TER-123/);
    const open = await f.adminA.get(T);
    expect(open.json.identityRestricted).toBe(false);
    expect(open.json.items[0]).toMatchObject({
      name: 'Tercero Sintetico',
      plates: 'TER-123',
      policyNumber: 'POL-SYNTH-1',
    });

    const edited = await f.managerA.send('PATCH', `${T}/${partyId}`, {
      json: { version: 2, injuries: true },
    });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.json.item.injuries).toBe(true);
    const noCsrf = await f.managerA.send('PATCH', `${T}/${partyId}`, {
      json: { version: 3, injuries: false },
      csrf: null,
    });
    expect(noCsrf.status).toBe(403);
    const stale = await f.managerA.send('PATCH', `${T}/${partyId}`, {
      json: { version: 2, injuries: false },
    });
    expect(stale.status).toBe(409);
    const removed = await f.managerA.post(`${T}/${partyId}/remove`, { json: { version: 3 } });
    expect(removed.status, removed.text).toBe(200);
    expect((await f.adminA.get(T)).json.items).toEqual([]);
    const timeline = await f.managerA.get(`${P}/${f.id}/timeline`);
    expect(timeline.text).not.toMatch(/Sintetico|TER-123|POL-SYNTH|525500000000/);
  });

  it('names bad fields on 400, refuses the editor on 403 and hides the case from other tenants', async () => {
    const f = await fixture();
    const T = `${P}/${f.id}/third-parties`;
    const bad = await f.managerA.post(T, { json: { version: 1, kind: 'robot' } });
    expect(bad.status).toBe(400);
    expect(bad.json.fieldErrors).toEqual(expect.any(Array));
    expect(
      (
        await f.managerA.post(T, {
          json: { version: 1, kind: 'person' },
          headers: { 'idempotency-key': '!' },
        })
      ).status,
    ).toBe(400);
    expect((await f.editorA.post(T, { json: { version: 1, kind: 'person' } })).status).toBe(403);
    expect((await f.adminB.get(T)).status).toBe(404);
    expect((await f.adminB.post(T, { json: { version: 1, kind: 'person' } })).status).toBe(404);
    expect((await f.managerA.get(`${P}/${f.id}/third-parties`)).json.items).toEqual([]);
  });
});

describe('evidence over HTTP', () => {
  it('uploads, counts only after a clean scan, downloads with audit and detaches (cases 10, 17)', async () => {
    const f = await fixture();
    const E = `${P}/${f.id}/evidence`;
    const bytes = png(2000);
    const up = await f.managerA.post(E, {
      json: body(1, bytes, 'image/png', { clientCompressed: true }),
      headers: { 'idempotency-key': 'ev-key-1' },
    });
    expect(up.status, up.text).toBe(201);
    expect(up.json.item).toMatchObject({
      fileStatus: 'pending_scan',
      counts: false,
      clientCompressed: true,
    });
    expect(up.text).not.toMatch(/storageKey|sha256|fileId|tenantId/);
    const replay = await f.managerA.post(E, {
      json: body(1, bytes, 'image/png', { clientCompressed: true }),
      headers: { 'idempotency-key': 'ev-key-1' },
    });
    expect(replay.json.item.id).toBe(up.json.item.id);
    const evidenceId = up.json.item.id as string;
    expect((await f.managerA.get(`${E}/${evidenceId}/content`)).status).toBe(409);

    await world.platform.pipeline.processScans();
    const list = await f.managerA.get(E);
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0]).toMatchObject({ fileStatus: 'clean', counts: true });
    const content = await f.managerA.get(`${E}/${evidenceId}/content`);
    expect(content.status, content.text).toBe(200);
    // Case 17: the bytes stored are exactly the bytes received.
    expect(sha(Buffer.from(content.json.contentBase64, 'base64'))).toBe(sha(bytes));
    expect(content.json.contentType).toBe('image/png');
    expect((await f.adminB.get(`${E}/${evidenceId}/content`)).status).toBe(404);

    const detached = await f.managerA.post(`${E}/${evidenceId}/detach`, {
      json: { version: up.json.version },
    });
    expect(detached.status, detached.text).toBe(200);
    expect((await f.managerA.get(E)).json.items).toEqual([]);
    expect((await f.managerA.get(`${E}/${evidenceId}/content`)).status).toBe(404);
  });

  it('applies the files limits by type: a 16 MB PDF is accepted, a 16 MB image is not', async () => {
    const f = await fixture();
    const E = `${P}/${f.id}/evidence`;
    const big = await f.managerA.post(E, {
      json: body(1, pdf(16 * 1024 * 1024), 'application/pdf', {
        category: 'police_report',
        name: 'parte.pdf',
      }),
    });
    expect(big.status, big.text.slice(0, 200)).toBe(201);
    const tooBig = await f.managerA.post(E, {
      json: body(big.json.version, png(16 * 1024 * 1024), 'image/png'),
    });
    expect(tooBig.status).toBe(400);
    expect((await f.managerA.get(E)).json.items).toHaveLength(1);
  });

  it('never serves a rejected file and does not count it', async () => {
    const f = await fixture();
    const E = `${P}/${f.id}/evidence`;
    const infected = Buffer.concat([png(10), Buffer.from(SYNTHETIC_MALWARE_MARKER)]);
    const up = await f.managerA.post(E, { json: body(1, infected, 'image/png') });
    expect(up.status, up.text).toBe(201);
    await world.platform.pipeline.processScans();
    const list = await f.managerA.get(E);
    expect(list.json.items[0]).toMatchObject({ fileStatus: 'rejected', counts: false });
    expect((await f.managerA.get(`${E}/${up.json.item.id}/content`)).status).toBeGreaterThanOrEqual(
      409,
    );
    expect((await f.adminA.get(`${E}/${up.json.item.id}/content`)).json).not.toHaveProperty(
      'contentBase64',
    );
  });

  it('refuses the editor and other tenants, and bad input names its fields', async () => {
    const f = await fixture();
    const E = `${P}/${f.id}/evidence`;
    expect((await f.editorA.post(E, { json: body(1, png(10), 'image/png') })).status).toBe(403);
    expect((await f.adminB.post(E, { json: body(1, png(10), 'image/png') })).status).toBe(404);
    expect((await f.adminB.get(E)).status).toBe(404);
    const bad = await f.managerA.post(E, { json: { version: 1, category: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.json.fieldErrors).toEqual(expect.any(Array));
    const notBase64 = await f.managerA.post(E, {
      json: { ...body(1, png(10), 'image/png'), contentBase64: '***' },
    });
    expect(notBase64.status).toBe(400);
  });
});
