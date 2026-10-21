import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const P = '/api/v1/incidents';
const W = '/api/v1/work-orders';
let keys = 0;
const key = () => `key-costs-${(keys += 1)}-bff-test`;
const withKey = (json: Record<string, unknown>) => ({
  json,
  headers: { 'idempotency-key': key() },
});
const towing = (amountMinor: string, currency = 'MXN') => ({
  kind: 'expense',
  category: 'towing',
  amount: { amountMinor, currency },
});

async function fixture() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  const manager = await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  const editor = await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const mech = await world.member('subject-admin-a', 'viewer', 'subject-mech-a');
  const adminA = await world.loginAs('subject-admin-a');
  const managerA = await world.loginAs('subject-manager-a');
  const editorA = await world.loginAs('subject-editor-a');
  const mechA = await world.loginAs('subject-mech-a');
  const adminB = await world.loginAs('subject-admin-b');
  const area = await adminA.post('/api/areas', { json: { name: 'Taller' } });
  const vehicle = await adminA.post('/api/vehicles', {
    json: {
      economicNumber: 'W-001',
      plate: 'WRK-001',
      make: 'Nissan',
      model: 'NP300',
      year: 2023,
      areaId: area.json.id,
      odometerKm: 5000,
    },
  });
  const workshop = await adminA.post('/api/v1/maintenance/workshops', {
    json: { name: 'Taller Uno', specialties: ['frenos'] },
  });
  const mechanic = await adminA.post('/api/v1/maintenance/mechanics', {
    json: {
      name: 'Mecánico Interno',
      specialties: ['frenos'],
      kind: 'internal',
      workshopId: workshop.json.id,
      memberId: mech.identityId,
    },
  });
  const draft = async (over: Record<string, unknown> = {}) => {
    const created = await managerA.post(P, {
      json: {
        vehicleId: vehicle.json.id,
        type: 'other',
        severity: 'low',
        occurredAt: new Date().toISOString(),
        location: { text: 'Calle Sintética' },
        description: 'Descripción sintética',
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
        ...over,
      },
    });
    expect(created.status, created.text).toBe(201);
    return created.json as { id: string; version: number };
  };
  const go = (id: string, json: Record<string, unknown>) =>
    managerA.post(`${P}/${id}/transitions`, { json, headers: { 'idempotency-key': key() } });
  /** A case taken by the commands to `under_review`. */
  const underReview = async (over: Record<string, unknown> = {}) => {
    const incident = await draft(over);
    const reported = await go(incident.id, { command: 'report', version: incident.version });
    const assigned = await go(incident.id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId: manager.identityId,
    });
    const reviewed = await go(incident.id, { command: 'review', version: assigned.json.version });
    expect(reviewed.status, reviewed.text).toBe(200);
    return { id: incident.id, version: reviewed.json.version as number };
  };
  /** A corrective order of the vehicle, taken to `completed` with a cost, ready to close. */
  const order = async (stage: 'created' | 'completed' = 'created') => {
    const created = await editorA.post(W, {
      json: { vehicleId: vehicle.json.id, description: 'Frenos rechinan' },
    });
    expect(created.status, created.text).toBe(201);
    const id = created.json.id as string;
    if (stage === 'created') return { id, version: created.json.version as number };
    const t = (browser: typeof adminA, json: Record<string, unknown>) =>
      browser.post(`${W}/${id}/transitions`, { json });
    const assigned = await t(editorA, {
      command: 'assign',
      version: 1,
      responsibleId: editor.identityId,
      workshopId: workshop.json.id,
      mechanicId: mechanic.json.id,
      scheduledDate: '2026-10-13',
    });
    const started = await t(mechA, { command: 'start', version: assigned.json.version });
    const worked = await mechA.put(`${W}/${id}/work`, {
      json: {
        version: started.json.version,
        tasks: [{ description: 'Cambio de balatas' }],
        parts: [{ name: 'Balata', quantity: '4' }],
      },
    });
    const costed = await adminA.put(`${W}/${id}/costs`, {
      json: {
        version: worked.json.version,
        costs: [{ category: 'labor', amount: { amountMinor: '150000', currency: 'MXN' } }],
      },
    });
    const done = await t(mechA, {
      command: 'complete',
      version: costed.json.version,
      actualDate: '2026-10-06',
      actualKm: 5100,
    });
    expect(done.status, done.text).toBe(200);
    return { id, version: done.json.version as number };
  };
  return {
    adminA,
    managerA,
    editorA,
    mechA,
    adminB,
    draft,
    underReview,
    order,
    go,
    managerId: manager.identityId,
    vehicleId: vehicle.json.id as string,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe('incident costs contract', () => {
  it('declares the five routes with method, CSRF, status and the keys that are required', () => {
    expect(BFF_ROUTES['incidents.repairs.list']).toMatchObject({ method: 'GET', kind: 'session' });
    expect(BFF_ROUTES['incidents.repairs.link']).toMatchObject({
      method: 'POST',
      kind: 'session-csrf',
      status: 200,
    });
    expect(BFF_ROUTES['incidents.repairs.unlink']).toMatchObject({
      method: 'POST',
      kind: 'session-csrf',
    });
    expect(BFF_ROUTES['incidents.costs.get']).toMatchObject({ method: 'GET', kind: 'session' });
    expect(BFF_ROUTES['incidents.costs.update']).toMatchObject({
      method: 'PUT',
      kind: 'session-csrf',
    });
  });
});

describe('incident costs over HTTP', () => {
  it('replaces costs with a key, replays it, and keeps every amount out of the other roles', async () => {
    const f = await fixture();
    const incident = await f.underReview();
    const body = { version: incident.version, lines: [towing('50000')] };
    const k = key();
    const saved = await f.managerA.put(`${P}/${incident.id}/costs`, {
      json: body,
      headers: { 'idempotency-key': k },
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.totals).toEqual([
      { currency: 'MXN', repairs: '0', expenses: '50000', recoveries: '0', companyBorne: '50000' },
    ]);
    const replay = await f.managerA.put(`${P}/${incident.id}/costs`, {
      json: body,
      headers: { 'idempotency-key': k },
    });
    expect([replay.status, replay.json]).toEqual([200, saved.json]);
    const clash = await f.managerA.put(`${P}/${incident.id}/costs`, {
      json: { ...body, lines: [] },
      headers: { 'idempotency-key': k },
    });
    expect([clash.status, clash.json.code]).toEqual([409, 'idempotency_conflict']);
    const read = await f.managerA.get(`${P}/${incident.id}/costs`);
    expect(read.json.lines).toHaveLength(1);
    // The case itself never shows an amount; the generic verbs of the editor grant nothing.
    const plain = await f.managerA.get(`${P}/${incident.id}`);
    expect(plain.text).not.toMatch(/50000|MXN/);
    const asEditor = await f.editorA.get(`${P}/${incident.id}/costs`);
    expect([403, 404]).toContain(asEditor.status);
    expect(asEditor.text).not.toMatch(/50000|MXN/);
    expect(
      (await f.editorA.put(`${P}/${incident.id}/costs`, withKey({ version: 3, lines: [] }))).status,
    ).toBeGreaterThanOrEqual(403);
    expect((await f.adminB.get(`${P}/${incident.id}/costs`)).status).toBe(404);
  });

  it('answers 400 for a missing, repeated or malformed key and for a bad body, naming only fields', async () => {
    const f = await fixture();
    const incident = await f.underReview();
    const json = { version: incident.version, lines: [] };
    const noKey = await f.managerA.put(`${P}/${incident.id}/costs`, { json });
    expect([noKey.status, noKey.json.code]).toEqual([400, 'idempotency_key_required']);
    const badKey = await f.managerA.put(`${P}/${incident.id}/costs`, {
      json,
      headers: { 'idempotency-key': 'x' },
    });
    expect(badKey.status).toBe(400);
    const bad = await f.managerA.put(
      `${P}/${incident.id}/costs`,
      withKey({ ...json, lines: [towing('-77'), { ...towing('5'), category: 'insurer' }] }),
    );
    expect(bad.status).toBe(400);
    expect(bad.json.fieldErrors.map((e: { field: string }) => e.field)).toEqual([
      'lines[0].amount',
      'lines[1].category',
    ]);
    // The correlation id is a random UUID and may itself contain '-77'.
    expect(JSON.stringify({ ...bad.json, correlationId: undefined })).not.toContain('-77');
    const notObject = await f.managerA.put(`${P}/${incident.id}/costs`, {
      json: [] as never,
      headers: { 'idempotency-key': key() },
    });
    expect(notObject.status).toBe(400);
    const stale = await f.managerA.put(
      `${P}/${incident.id}/costs`,
      withKey({ ...json, version: 99 }),
    );
    expect(stale.status).toBe(409);
  });

  it('links a corrective order, lists it by name, refuses a second link and unlinks it', async () => {
    const f = await fixture();
    const incident = await f.underReview();
    const order = await f.order();
    const link = (id: string, version: number, orderId: string) =>
      f.managerA.post(`${P}/${id}/repairs`, withKey({ version, orderId }));
    const linked = await link(incident.id, incident.version, order.id);
    expect(linked.status, linked.text).toBe(200);
    expect(linked.json).toMatchObject({
      version: incident.version + 1,
      item: { orderId: order.id },
    });
    expect(JSON.stringify(linked.json.item.linkedBy)).not.toMatch(/^user-/);
    const list = await f.managerA.get(`${P}/${incident.id}/repairs`);
    expect(list.json.items).toHaveLength(1);
    expect(list.text).not.toMatch(/150000|amountMinor/);
    const other = await f.underReview();
    const twice = await link(other.id, other.version, order.id);
    expect([twice.status, twice.json.code]).toEqual([409, 'duplicate']);
    const unknown = await link(other.id, other.version, 'nope');
    expect(unknown.status).toBe(404);
    const linkId = linked.json.item.id as string;
    const gone = await f.managerA.post(
      `${P}/${incident.id}/repairs/${linkId}/unlink`,
      withKey({ version: linked.json.version }),
    );
    expect(gone.status, gone.text).toBe(200);
    expect(gone.json.version).toBe(linked.json.version + 1);
    expect((await f.managerA.get(`${P}/${incident.id}/repairs`)).json.items).toEqual([]);
    expect((await link(other.id, other.version, order.id)).status).toBe(200);
  });

  it('counts the linked order live beside the own lines, once, and shows it only with view_costs (cases 1 and 3)', async () => {
    const f = await fixture();
    const incident = await f.underReview();
    const order = await f.order('completed');
    const linked = await f.managerA.post(
      `${P}/${incident.id}/repairs`,
      withKey({ version: incident.version, orderId: order.id }),
    );
    const saved = await f.managerA.put(
      `${P}/${incident.id}/costs`,
      withKey({ version: linked.json.version, lines: [towing('50000')] }),
    );
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.totals).toEqual([
      {
        currency: 'MXN',
        repairs: '150000',
        expenses: '50000',
        recoveries: '0',
        companyBorne: '200000',
      },
    ]);
    expect(saved.json.repairs).toEqual([
      expect.objectContaining({
        orderId: order.id,
        totals: [{ currency: 'MXN', amountMinor: '150000' }],
      }),
    ]);
  });
});

describe('a case and the order that repairs it do not block each other (mutual vehicle block)', () => {
  const closeOrder = (f: Fixture, order: { id: string; version: number }) =>
    f.adminA.post(`${W}/${order.id}/transitions`, {
      json: { command: 'close', version: order.version, vehicleStatus: 'active' },
      headers: { 'idempotency-key': key() },
    });

  it('an open case that holds the vehicle blocks the order, unless it is the case that repairs it', async () => {
    const f = await fixture();
    const incident = await f.underReview({ vehicleOperable: false });
    const order = await f.order('completed');
    const refused = await closeOrder(f, order);
    expect(refused.status, refused.text).toBe(422);
    expect(refused.json.missingRequirements).toContain('noOpenIncidentHoldingVehicle');
    const linked = await f.managerA.post(
      `${P}/${incident.id}/repairs`,
      withKey({ version: incident.version, orderId: order.id }),
    );
    expect(linked.status, linked.text).toBe(200);
    const closed = await closeOrder(f, order);
    expect(closed.status, closed.text).toBe(200);
    expect(closed.json.status).toBe('closed');
  });

  it('an open order blocks the case from returning the vehicle to active, unless it is the order that repairs it', async () => {
    const f = await fixture();
    const incident = await f.underReview();
    const order = await f.order('completed');
    const decide = (version: number) =>
      f.managerA.put(`${P}/${incident.id}/resolution`, {
        json: { version, resolutionSummary: 'Resuelto', vehicleStatusDecision: 'active' },
      });
    const decided = await decide(incident.version);
    expect(decided.status, decided.text).toBe(200);
    const refused = await f.go(incident.id, { command: 'resolve', version: decided.json.version });
    expect(refused.status, refused.text).toBe(422);
    const linked = await f.managerA.post(
      `${P}/${incident.id}/repairs`,
      withKey({ version: decided.json.version, orderId: order.id }),
    );
    expect(linked.status, linked.text).toBe(200);
    const resolvedNow = await f.go(incident.id, {
      command: 'resolve',
      version: linked.json.version,
    });
    expect(resolvedNow.status, resolvedNow.text).toBe(200);
  });
});
