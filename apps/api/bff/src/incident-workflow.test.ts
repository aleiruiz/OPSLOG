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
  return { adminA, managerA, editorA, adminB, draft, managerId: manager.identityId };
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
