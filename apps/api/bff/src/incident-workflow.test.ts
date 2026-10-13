import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const P = '/api/v1/incidents';

async function fixture() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  const manager = await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const adminA = await world.loginAs('subject-admin-a');
  const managerA = await world.loginAs('subject-manager-a');
  const editorA = await world.loginAs('subject-editor-a');
  const mechanicMember = await world.member('subject-admin-a', 'viewer', 'subject-mech-a');
  const mechanicBrowser = await world.loginAs('subject-mech-a');
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
  const draft = async (over: Record<string, unknown> = {}) => {
    const created = await managerA.post(P, {
      json: {
        vehicleId: vehicle.json.id,
        type: 'collision',
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
  return {
    adminA,
    managerA,
    editorA,
    adminB,
    draft,
    managerId: manager.identityId,
    vehicleId: vehicle.json.id as string,
    mechanicBrowser,
    mechanicIdentity: mechanicMember.identityId,
  };
}

describe('incident workflow contract', () => {
  it('declares the four routes with their methods, CSRF and the keys that are required', () => {
    expect(BFF_ROUTES['incidents.transition']).toMatchObject({
      method: 'POST',
      kind: 'session-csrf',
      status: 200,
      idempotency: { requiredFor: ['approve_assumption', 'approve_close', 'close', 'reopen'] },
    });
    expect(BFF_ROUTES['incidents.nextSteps']).toMatchObject({ method: 'GET', kind: 'session' });
    expect(BFF_ROUTES['incidents.insurance.update']).toMatchObject({
      method: 'PUT',
      kind: 'session-csrf',
    });
    expect(BFF_ROUTES['incidents.resolution.update']).toMatchObject({
      method: 'PUT',
      kind: 'session-csrf',
    });
  });
});

describe('incident workflow over HTTP', () => {
  it('reports a case, lists the next steps and replays the same key', async () => {
    const { managerA, draft } = await fixture();
    const incident = await draft();
    const steps = await managerA.get(`${P}/${incident.id}/next-steps`);
    expect(steps.status, steps.text).toBe(200);
    expect(steps.json.items.map((item: { command: string }) => item.command)).toEqual([
      'report',
      'cancel',
    ]);
    const body = { command: 'report', version: incident.version, comment: 'Listo' };
    const reported = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: body,
      headers: { 'idempotency-key': 'report-key-0001' },
    });
    expect(reported.status, reported.text).toBe(200);
    expect(reported.json).toMatchObject({ status: 'reported', version: incident.version + 1 });
    expect(reported.json.allowedCommands).toEqual(['assign', 'review', 'cancel']);
    const replay = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: body,
      headers: { 'idempotency-key': 'report-key-0001' },
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(reported.json);
    const clash = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { ...body, comment: 'Otro' },
      headers: { 'idempotency-key': 'report-key-0001' },
    });
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe('idempotency_conflict');
  });

  it('answers 422 with the full list of missing requirements, 400 for a missing or bad key, 409 for state', async () => {
    const { managerA, draft } = await fixture();
    const incident = await draft({ description: undefined, severity: undefined });
    const missing = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'report', version: incident.version },
    });
    expect(missing.status).toBe(422);
    expect(missing.json).toMatchObject({
      code: 'missing_requirements',
      missingRequirements: ['description', 'severity'],
    });
    const noKey = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'close', version: incident.version },
    });
    expect(noKey.status).toBe(400);
    expect(noKey.json.code).toBe('idempotency_key_required');
    const badKey = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'report', version: incident.version },
      headers: { 'idempotency-key': 'x' },
    });
    expect(badKey.status).toBe(400);
    const wrongState = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'review', version: incident.version },
    });
    expect(wrongState.status).toBe(409);
    const stale = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'report', version: 9 },
    });
    expect(stale.status).toBe(409);
    const unknown = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'jump', version: 1 },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.fieldErrors).toContainEqual({ field: 'command', code: 'invalid' });
  });

  it('refuses CSRF-less writes, readers without the permission, and other tenants', async () => {
    const { managerA, editorA, adminB, draft } = await fixture();
    const incident = await draft();
    const json = { command: 'report', version: incident.version };
    expect(
      (await managerA.send('POST', `${P}/${incident.id}/transitions`, { json, csrf: null })).status,
    ).toBe(403);
    const reader = await editorA.post(`${P}/${incident.id}/transitions`, { json });
    expect(reader.status).toBe(403);
    expect((await editorA.get(`${P}/${incident.id}/next-steps`)).json.items).toEqual([]);
    expect((await adminB.post(`${P}/${incident.id}/transitions`, { json })).status).toBe(404);
    expect((await adminB.get(`${P}/${incident.id}/next-steps`)).status).toBe(404);
    expect((await adminB.put(`${P}/${incident.id}/insurance`, { json: {} })).status).toBe(404);
  });

  it('updates the insurer data and the resolution, and never accepts a body outside the contract', async () => {
    const { managerA, adminA, draft, managerId } = await fixture();
    const incident = await draft();
    const reported = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'report', version: incident.version },
    });
    const assigned = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'assign', version: reported.json.version, responsibleId: managerId },
    });
    expect(assigned.status, assigned.text).toBe(200);
    const review = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'review', version: assigned.json.version },
    });
    expect(review.json.status).toBe('under_review');
    const insurance = await managerA.put(`${P}/${incident.id}/insurance`, {
      json: { version: review.json.version, claimNumber: 'REP-0001' },
    });
    expect(insurance.status, insurance.text).toBe(200);
    expect(insurance.json.insurance).toMatchObject({ claimNumber: 'REP-0001' });
    const resolution = await managerA.put(`${P}/${incident.id}/resolution`, {
      json: { version: insurance.json.version, resolutionSummary: 'Resuelto' },
    });
    expect(resolution.json.resolution).toMatchObject({ resolutionSummary: 'Resuelto' });
    const bad = await managerA.put(`${P}/${incident.id}/insurance`, {
      json: { version: resolution.json.version, status: 'closed' },
    });
    expect(bad.status).toBe(400);
    const notJson = await adminA.send('PUT', `${P}/${incident.id}/resolution`, { json: [] });
    expect(notJson.status).toBe(400);
    expect(JSON.stringify(reported.json)).not.toContain('tenantId');
  });

  it('applies the company photo setting to the report (case 4)', async () => {
    const { adminA, managerA, draft } = await fixture();
    const saved = await adminA.put('/api/alerts/settings', {
      json: {
        version: 0,
        expiryWindowDays: 7,
        recipientRoles: ['admin'],
        incidentReportPhoto: 'photo_required',
      },
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.incidentReportPhoto).toBe('photo_required');
    const incident = await draft();
    const refused = await managerA.post(`${P}/${incident.id}/transitions`, {
      json: { command: 'report', version: incident.version },
    });
    expect(refused.json.missingRequirements).toEqual(['photo_or_justification']);
  });
});

describe('approvals, close and reopen over HTTP (PR 2)', () => {
  let keys = 0;
  const key = () => `key-pr2-${(keys += 1)}-bff-test`;
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Browser = Fixture['managerA'];
  const go = (browser: Browser, id: string, json: Record<string, unknown>, k?: string) =>
    browser.post(`${P}/${id}/transitions`, { json, headers: k ? { 'idempotency-key': k } : {} });

  /** A direct-route case taken to `resolved` by the manager. */
  async function resolved(f: Fixture, over: Record<string, unknown> = {}) {
    const incident = await f.draft({ type: 'other', ...over });
    let current = (
      await go(f.managerA, incident.id, { command: 'report', version: incident.version })
    ).json;
    current = (
      await go(f.managerA, incident.id, {
        command: 'assign',
        version: current.version,
        responsibleId: f.managerId,
      })
    ).json;
    current = (await go(f.managerA, incident.id, { command: 'review', version: current.version }))
      .json;
    current = (
      await f.managerA.put(`${P}/${incident.id}/resolution`, {
        json: {
          version: current.version,
          resolutionSummary: 'Resuelto',
          vehicleStatusDecision: 'restricted',
        },
      })
    ).json;
    const done = await go(f.managerA, incident.id, {
      command: 'resolve',
      version: current.version,
    });
    expect(done.status, done.text).toBe(200);
    return { id: incident.id, version: done.json.version as number };
  }

  it('closes with a key, replays it, reopens into a second cycle and closes again (cases 9 and 12)', async () => {
    const f = await fixture();
    const { id, version } = await resolved(f);
    const first = key();
    const closed = await go(f.managerA, id, { command: 'close', version }, first);
    expect(closed.status, closed.text).toBe(200);
    expect(closed.json).toMatchObject({ status: 'closed', cycle: 1, allowedCommands: [] });
    expect(closed.json.resolution.closedBy).toMatchObject({ displayName: expect.any(String) });
    const replay = await go(f.managerA, id, { command: 'close', version }, first);
    expect(replay.json).toEqual(closed.json);
    expect(
      (await go(f.managerA, id, { command: 'close', version, comment: 'x' }, first)).status,
    ).toBe(409);

    // The manager template cannot reopen; the administrator can, with a reason and a key.
    const denied = await go(
      f.managerA,
      id,
      { command: 'reopen', version: closed.json.version, reason: 'x' },
      key(),
    );
    expect(denied.status).toBe(403);
    const noKey = await go(f.adminA, id, {
      command: 'reopen',
      version: closed.json.version,
      reason: 'x',
    });
    expect(noKey.status).toBe(400);
    const noReason = await go(
      f.adminA,
      id,
      { command: 'reopen', version: closed.json.version },
      key(),
    );
    expect([noReason.status, noReason.json.missingRequirements]).toEqual([422, ['reason']]);
    const reopened = await go(
      f.adminA,
      id,
      { command: 'reopen', version: closed.json.version, reason: 'Nuevo dato' },
      key(),
    );
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.json).toMatchObject({ status: 'reopened', cycle: 2, reopenCount: 1 });
    const timeline = await f.managerA.get(`${P}/${id}/timeline`);
    expect(
      timeline.json.items.map((entry: { command: string }) => entry.command).slice(-2),
    ).toEqual(['close', 'reopen']);
  });

  it('asks the D20 approval fail-closed without INC-COSTS, from incidents:approve only, and again after an edit (case 8)', async () => {
    const f = await fixture();
    const saved = await f.adminA.put('/api/alerts/settings', {
      json: {
        version: 0,
        expiryWindowDays: 7,
        recipientRoles: ['admin'],
        closeCostThreshold: { amountMinor: '500000', currency: 'MXN' },
      },
    });
    expect(saved.status, saved.text).toBe(200);
    const { id, version } = await resolved(f);
    const steps = await f.managerA.get(`${P}/${id}/next-steps`);
    expect(steps.json.items).toContainEqual({
      command: 'close',
      missingRequirements: ['close_approval'],
    });
    const refused = await go(f.managerA, id, { command: 'close', version }, key());
    expect([refused.status, refused.json.missingRequirements]).toEqual([422, ['close_approval']]);
    // The manager has no `incidents:approve`; the generic verbs do not stand in for it.
    expect((await go(f.managerA, id, { command: 'approve_close', version }, key())).status).toBe(
      403,
    );
    expect((await go(f.editorA, id, { command: 'approve_close', version }, key())).status).toBe(
      403,
    );
    const approved = await go(f.adminA, id, { command: 'approve_close', version }, key());
    expect(approved.status, approved.text).toBe(200);
    expect(approved.json.resolution.closeApproval).not.toBeNull();
    const edited = await f.managerA.put(`${P}/${id}/resolution`, {
      json: { version: approved.json.version, resolutionSummary: 'Resuelto otra vez' },
    });
    expect(edited.json.resolution.closeApproval).toBeNull();
    const again = await go(
      f.managerA,
      id,
      { command: 'close', version: edited.json.version },
      key(),
    );
    expect(again.json.missingRequirements).toEqual(['close_approval']);
    const reapproved = await go(
      f.adminA,
      id,
      { command: 'approve_close', version: edited.json.version },
      key(),
    );
    const closed = await go(
      f.managerA,
      id,
      { command: 'close', version: reapproved.json.version },
      key(),
    );
    expect(closed.status, closed.text).toBe(200);
    const noThreshold = await go(
      f.adminA,
      id,
      { command: 'approve_close', version: closed.json.version },
      key(),
    );
    expect(noThreshold.status).toBe(409);
  });

  it('refuses active for the vehicle while another open case holds it, and the same from a work order (case 14)', async () => {
    const f = await fixture();
    const { id } = await resolved(f, { vehicleOperable: false });
    await f.draft({ type: 'other', vehicleOperable: false });
    const active = await f.managerA.put(`${P}/${id}/resolution`, {
      json: {
        version: (await f.managerA.get(`${P}/${id}`)).json.version,
        vehicleStatusDecision: 'active',
      },
    });
    expect(active.status, active.text).toBe(200);
    const blocked = await go(
      f.managerA,
      id,
      { command: 'close', version: active.json.version },
      key(),
    );
    expect([blocked.status, blocked.json.field]).toEqual([422, 'vehicle_blocked']);

    // The other way round: an order of the workshop cannot return the vehicle to active either.
    const workshop = await f.adminA.post('/api/v1/maintenance/workshops', {
      json: { name: 'Taller Uno', specialties: ['frenos'] },
    });
    const mechanic = await f.adminA.post('/api/v1/maintenance/mechanics', {
      json: {
        name: 'Mecánico',
        specialties: ['frenos'],
        kind: 'internal',
        workshopId: workshop.json.id,
        memberId: f.mechanicIdentity,
      },
    });
    const created = await f.adminA.post('/api/v1/work-orders', {
      json: { vehicleId: f.vehicleId, description: 'Frenos' },
    });
    const t = (b: Browser, json: Record<string, unknown>) =>
      b.post(`/api/v1/work-orders/${created.json.id}/transitions`, {
        json,
        headers: json['command'] === 'close' ? { 'idempotency-key': key() } : {},
      });
    const assigned = await t(f.adminA, {
      command: 'assign',
      version: 1,
      responsibleId: f.managerId,
      workshopId: workshop.json.id,
      mechanicId: mechanic.json.id,
      scheduledDate: '2026-10-13',
    });
    expect(assigned.status, assigned.text).toBe(200);
    const started = await t(f.mechanicBrowser, {
      command: 'start',
      version: assigned.json.version,
    });
    const worked = await f.mechanicBrowser.put(`/api/v1/work-orders/${created.json.id}/work`, {
      json: { version: started.json.version, tasks: [{ description: 'Balatas' }] },
    });
    const completed = await t(f.mechanicBrowser, {
      command: 'complete',
      version: worked.json.version,
      actualDate: '2026-10-06',
      actualKm: 5100,
    });
    const refused = await t(f.adminA, {
      command: 'close',
      version: completed.json.version,
      vehicleStatus: 'active',
    });
    expect(refused.status, refused.text).toBe(422);
    expect(refused.json.missingRequirements).toContain('noOpenIncidentHoldingVehicle');
    // An order of the workshop that is still open holds the vehicle for a case as well.
    const second = await f.adminA.post('/api/vehicles', {
      json: {
        economicNumber: 'W-002',
        plate: 'WRK-002',
        make: 'Nissan',
        model: 'NP300',
        year: 2023,
        areaId: (await f.adminA.get('/api/vehicles')).json.items[0].areaId,
        odometerKm: 100,
      },
    });
    expect(second.status, second.text).toBe(201);
    const held = await f.adminA.post('/api/v1/work-orders', {
      json: { vehicleId: second.json.id, description: 'Luces' },
    });
    const heldAssign = await f.adminA.post(`/api/v1/work-orders/${held.json.id}/transitions`, {
      json: {
        command: 'assign',
        version: 1,
        responsibleId: f.managerId,
        workshopId: workshop.json.id,
        mechanicId: mechanic.json.id,
        scheduledDate: '2026-10-13',
      },
    });
    await f.mechanicBrowser.post(`/api/v1/work-orders/${held.json.id}/transitions`, {
      json: { command: 'start', version: heldAssign.json.version, requiresWorkshop: true },
    });
    const onSecond = await resolved(f, { vehicleId: second.json.id });
    const decided = await f.managerA.put(`${P}/${onSecond.id}/resolution`, {
      json: { version: onSecond.version, vehicleStatusDecision: 'active' },
    });
    const byOrder = await go(
      f.managerA,
      onSecond.id,
      { command: 'close', version: decided.json.version },
      key(),
    );
    expect([byOrder.status, byOrder.json.field]).toEqual([422, 'vehicle_blocked']);
    const fine = await t(f.adminA, {
      command: 'close',
      version: completed.json.version,
      vehicleStatus: 'in_maintenance',
    });
    expect(fine.status, fine.text).toBe(200);
  });
});
