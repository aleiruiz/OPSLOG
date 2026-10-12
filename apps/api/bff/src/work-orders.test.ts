import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

async function fixture() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  const editor = await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const mech = await world.member('subject-admin-a', 'viewer', 'subject-mech-a');
  const adminA = await world.loginAs('subject-admin-a');
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
  expect(mechanic.status, mechanic.text).toBe(201);
  return {
    world,
    editorIdentity: editor.identityId,
    adminA,
    editorA,
    mechA,
    adminB,
    vehicleId: vehicle.json.id as string,
    workshopId: workshop.json.id as string,
    mechanicId: mechanic.json.id as string,
  };
}

/** Close and reopen need an Idempotency-Key: every call of these helpers is a new submit. */
let submits = 0;
const keyed = (json: Record<string, unknown>): Record<string, string> =>
  json['command'] === 'close' || json['command'] === 'reopen'
    ? { 'idempotency-key': `submit-${(submits += 1)}-bff-test` }
    : {};

describe('work order contract', () => {
  it('declares work order routes as session reads or CSRF-protected writes', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('workOrders.'));
    expect(routes).toHaveLength(12);
    expect(BFF_ROUTES['workOrders.transition'].idempotency).toEqual({
      requiredFor: ['close', 'reopen'],
    });
    for (const [id, definition] of routes)
      expect(definition.kind, id).toBe(definition.method === 'GET' ? 'session' : 'session-csrf');
  });
});

describe('work orders over HTTP', () => {
  it('runs a corrective order through its commands with mechanic scope and cost redaction', async () => {
    const { adminA, editorA, mechA, adminB, vehicleId, workshopId, mechanicId, editorIdentity } =
      await fixture();
    const created = await editorA.post('/api/v1/work-orders', {
      json: { vehicleId, description: 'Frenos rechinan' },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.json).not.toHaveProperty('tenantId');
    const id = created.json.id as string;
    const transition = (browser: typeof adminA, json: Record<string, unknown>) =>
      browser.post(`/api/v1/work-orders/${id}/transitions`, { json, headers: keyed(json) });

    const missing = await transition(editorA, { command: 'assign', version: 1 });
    expect(missing.status).toBe(422);
    expect(missing.json).toMatchObject({
      code: 'missing_requirements',
      missingRequirements: ['responsibleId', 'scheduledDate', 'workshopOrMechanic'],
    });
    expect((await transition(editorA, { command: 'teleport', version: 1 })).status).toBe(400);
    const assigned = await transition(editorA, {
      command: 'assign',
      version: 1,
      responsibleId: editorIdentity,
      workshopId,
      mechanicId,
      scheduledDate: '2026-10-13',
    });
    expect(assigned.status, assigned.text).toBe(200);
    expect((await adminB.get(`/api/v1/work-orders/${id}`)).status).toBe(404);
    const started = await transition(mechA, { command: 'start', version: assigned.json.version });
    expect(started.status, started.text).toBe(200);
    expect(started.json.vehicleProposal).toEqual({
      suggestedStatus: 'in_maintenance',
      eligibilityBlocked: true,
    });
    const worked = await mechA.put(`/api/v1/work-orders/${id}/work`, {
      json: {
        version: started.json.version,
        tasks: [{ description: 'Cambio de balatas' }],
        parts: [{ name: 'Balata', quantity: '4' }],
      },
    });
    expect(worked.status, worked.text).toBe(200);
    expect(
      (
        await mechA.put(`/api/v1/work-orders/${id}/costs`, {
          json: { version: worked.json.version },
        })
      ).status,
    ).toBe(403);
    const costed = await adminA.put(`/api/v1/work-orders/${id}/costs`, {
      json: {
        version: worked.json.version,
        costs: [{ category: 'labor', amount: { amountMinor: '150000', currency: 'MXN' } }],
      },
    });
    expect(costed.status, costed.text).toBe(200);
    expect(costed.json.costs).toEqual([
      expect.objectContaining({ amount: { amountMinor: '150000', currency: 'MXN' } }),
    ]);
    const asEditor = await editorA.get(`/api/v1/work-orders/${id}`);
    expect(asEditor.text).not.toMatch(/150000|MXN|"costs"/);
    expect((await mechA.get('/api/v1/work-orders')).json).toHaveLength(1);
    const completed = await transition(mechA, {
      command: 'complete',
      version: costed.json.version,
      actualDate: '2026-10-06',
      actualKm: 5100,
    });
    expect(completed.status, completed.text).toBe(200);
    expect(
      (
        await transition(editorA, {
          command: 'close',
          version: completed.json.version,
          vehicleStatus: 'active',
        })
      ).status,
    ).toBe(403);
    const closed = await transition(adminA, {
      command: 'close',
      version: completed.json.version,
      vehicleStatus: 'active',
    });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.json).toMatchObject({ status: 'closed', vehicleStatusDecision: 'active' });
    const stale = await transition(adminA, { command: 'reopen', version: 1, reason: 'x' });
    expect(stale.json.code).toBe('stale_version');
    const history = await adminA.get(`/api/v1/work-orders/${id}/history`);
    expect(history.json.map((t: { command: string }) => t.command)).toEqual([
      'create',
      'assign',
      'start',
      'complete',
      'close',
    ]);
    expect(
      (
        await adminA.post('/api/v1/work-orders/preventive', {
          json: { planId: 'p', scheduledOrderId: 'o' },
        })
      ).status,
    ).toBe(404);
    expect((await adminA.post('/api/v1/work-orders', { json: { vehicleId } })).status).toBe(400);
  });

  const settingsBody = (version: number, over: Record<string, unknown>) => ({
    version,
    expiryWindowDays: 7,
    recipientRoles: ['editor', 'admin'],
    ...over,
  });

  async function inProgress(f: Awaited<ReturnType<typeof fixture>>) {
    const created = await f.editorA.post('/api/v1/work-orders', {
      json: { vehicleId: f.vehicleId, description: 'Frenos' },
    });
    const id = created.json.id as string;
    const t = (b: typeof f.adminA, json: Record<string, unknown>) =>
      b.post(`/api/v1/work-orders/${id}/transitions`, { json, headers: keyed(json) });
    const assigned = await t(f.editorA, {
      command: 'assign',
      version: 1,
      responsibleId: f.editorIdentity,
      workshopId: f.workshopId,
      mechanicId: f.mechanicId,
      scheduledDate: '2026-10-13',
    });
    const started = await t(f.mechA, { command: 'start', version: assigned.json.version });
    const worked = await f.mechA.put(`/api/v1/work-orders/${id}/work`, {
      json: { version: started.json.version, tasks: [{ description: 'Cambio de balatas' }] },
    });
    return { id, t, version: worked.json.version as number };
  }

  it('requires persisted evidence and invoice files, scoped by permission and tenant (G3 H3)', async () => {
    const f = await fixture();
    expect(
      (
        await f.adminA.send('PUT', '/api/alerts/settings', {
          json: settingsBody(0, { maintenanceEvidence: 'evidence_invoice' }),
        })
      ).status,
    ).toBe(200);
    const { id, t, version } = await inProgress(f);
    const complete = { command: 'complete', actualDate: '2026-10-06', actualKm: 5100 };
    const blocked = await t(f.mechA, { ...complete, version });
    expect(blocked.status).toBe(422);
    expect(blocked.json.missingRequirements).toEqual(['evidence', 'invoice']);

    const pdf = Buffer.from('%PDF-1.4 evidencia').toString('base64');
    const upload = (b: typeof f.adminA, v: number, kind: string) =>
      b.post(`/api/v1/work-orders/${id}/files`, {
        json: {
          version: v,
          kind,
          name: `${kind}.pdf`,
          contentType: 'application/pdf',
          contentBase64: pdf,
        },
      });
    const evidence = await upload(f.mechA, version, 'evidence');
    expect(evidence.status, evidence.text).toBe(200);
    expect(evidence.text).not.toMatch(/tenantId|storageKey/);
    expect((await upload(f.mechA, evidence.json.version, 'invoice')).status).toBe(403);
    expect((await upload(f.adminB, evidence.json.version, 'evidence')).status).toBe(404);
    const invoice = await upload(f.adminA, evidence.json.version, 'invoice');
    expect(invoice.status, invoice.text).toBe(200);

    // Not yet scanned: the files do not count.
    const pending = await t(f.mechA, { ...complete, version: invoice.json.version });
    expect(pending.status).toBe(422);
    expect(pending.json.missingRequirements).toEqual(['evidence', 'invoice']);
    await f.world.platform.pipeline.processScans();
    const completed = await t(f.mechA, { ...complete, version: invoice.json.version });
    expect(completed.status, completed.text).toBe(200);

    const list = await f.adminA.get(`/api/v1/work-orders/${id}/files`);
    expect(list.json.map((x: { kind: string }) => x.kind).sort()).toEqual(['evidence', 'invoice']);
    expect((await f.mechA.get(`/api/v1/work-orders/${id}/files`)).json).toHaveLength(1);
    const closed = await t(f.adminA, {
      command: 'close',
      version: completed.json.version,
      vehicleStatus: 'active',
    });
    expect(closed.status, closed.text).toBe(200);
    expect((await upload(f.adminA, closed.json.version, 'evidence')).status).toBe(409);
    const fileId = list.json[0].id as string;
    expect(
      (
        await f.adminA.post(`/api/v1/work-orders/${id}/files/${fileId}/detach`, {
          json: { version: closed.json.version },
        })
      ).status,
    ).toBe(409);
  });

  it('requires approval for every close once a cost threshold is configured (G3 D20)', async () => {
    const f = await fixture();
    await f.adminA.send('PUT', '/api/alerts/settings', {
      json: settingsBody(0, { closeCostThreshold: { amountMinor: '500000', currency: 'MXN' } }),
    });
    const { t, version } = await inProgress(f);
    const completed = await t(f.mechA, {
      command: 'complete',
      version,
      actualDate: '2026-10-06',
      actualKm: 5100,
    });
    const close = { command: 'close', vehicleStatus: 'active' };
    const refused = await t(f.adminA, { ...close, version: completed.json.version });
    expect(refused.status).toBe(422);
    expect(refused.json.missingRequirements).toContain('closeApproval');
    const approved = await t(f.adminA, {
      command: 'approve_close',
      version: completed.json.version,
    });
    expect(approved.status, approved.text).toBe(200);
    const closed = await t(f.adminA, { ...close, version: approved.json.version });
    expect(closed.status, closed.text).toBe(200);
  });

  describe('Idempotency-Key (G3 H2)', () => {
    async function completedOrder() {
      const f = await fixture();
      const { id, t, version } = await inProgress(f);
      const completed = await t(f.mechA, {
        command: 'complete',
        version,
        actualDate: '2026-10-06',
        actualKm: 5100,
      });
      const send = (
        browser: typeof f.adminA,
        json: Record<string, unknown>,
        key?: string,
        name = 'idempotency-key',
      ) =>
        browser.post(`/api/v1/work-orders/${id}/transitions`, {
          json,
          headers: key === undefined ? {} : { [name]: key },
        });
      return { f, id, send, version: completed.json.version as number };
    }
    const close = (version: number, extra: object = {}) => ({
      command: 'close',
      version,
      vehicleStatus: 'active',
      ...extra,
    });

    it('requires a well-formed key to close and reopen, and accepts it optionally elsewhere', async () => {
      const { f, id, send, version } = await completedOrder();
      const missing = await send(f.adminA, close(version));
      expect(missing.status).toBe(400);
      expect(missing.json).toMatchObject({ code: 'idempotency_key_required', status: 400 });
      expect((await send(f.adminA, { command: 'reopen', version, reason: 'x' })).json.code).toBe(
        'idempotency_key_required',
      );
      for (const bad of ['corta', 'con espacios aqui!', 'x'.repeat(129)])
        expect((await send(f.adminA, close(version), bad)).json.code, bad).toBe('bad_request');
      // Nothing happened to the order.
      expect((await f.adminA.get(`/api/v1/work-orders/${id}`)).json.version).toBe(version);
      // A key in the body is not a key: the body is strict.
      expect(
        (await send(f.adminA, { ...close(version), idempotencyKey: 'body-key-0001' })).status,
      ).toBe(400);
      // The other commands take the header or leave it out.
      const approved = await send(
        f.adminA,
        { command: 'approve_close', version },
        'approve-key-001',
      );
      expect(approved.status).toBe(409); // no approval threshold configured: not applicable
    });

    it('replays the first result for the same key and payload, even after the order moved on', async () => {
      const { f, id, send, version } = await completedOrder();
      const first = await send(f.adminA, close(version), 'close-key-0001');
      expect(first.status, first.text).toBe(200);
      const again = await send(f.adminA, close(version), 'close-key-0001');
      expect(again.status).toBe(200);
      expect(again.json).toEqual(first.json);
      const history = await f.adminA.get(`/api/v1/work-orders/${id}/history`);
      expect(
        history.json.filter((entry: { command: string }) => entry.command === 'close'),
      ).toHaveLength(1);
      const reopened = await send(
        f.adminA,
        { command: 'reopen', version: first.json.version, reason: 'Falta factura' },
        'reopen-key-001',
      );
      expect(reopened.json.status).toBe('in_progress');
      const replay = await send(f.adminA, close(version), 'close-key-0001');
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(first.json);
      expect((await f.adminA.get(`/api/v1/work-orders/${id}`)).json.status).toBe('in_progress');
    });

    it('answers 409 idempotency_conflict for the same key with another payload and never leaks to other callers', async () => {
      const { f, send, version } = await completedOrder();
      const first = await send(f.adminA, close(version), 'close-key-0001');
      const conflict = await send(f.adminA, close(version, { comment: 'otro' }), 'close-key-0001');
      expect(conflict.status).toBe(409);
      expect(conflict.json).toMatchObject({ code: 'idempotency_conflict', status: 409 });
      // Another actor's identical key is not a replay of this one.
      const editor = await send(f.editorA, close(version), 'close-key-0001');
      expect(editor.status).toBe(403);
      expect(editor.text).not.toContain(first.json.closedAt);
      // Another tenant cannot reach the order, with or without the key.
      expect((await send(f.adminB, close(version), 'close-key-0001')).status).toBe(404);
    });
  });
});
