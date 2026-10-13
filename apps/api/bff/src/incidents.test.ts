import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

async function fixture() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const mech = await world.member('subject-admin-a', 'viewer', 'subject-mech-a');
  const adminA = await world.loginAs('subject-admin-a');
  const managerA = await world.loginAs('subject-manager-a');
  const editorA = await world.loginAs('subject-editor-a');
  const mechA = await world.loginAs('subject-mech-a');
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
  return { adminA, managerA, editorA, mechA, adminB, vehicleId: vehicle.json.id as string };
}

const P = '/api/v1/incidents';

describe('incident contract', () => {
  it('declares incident routes as session reads or CSRF-protected writes', () => {
    const routes = Object.entries(BFF_ROUTES).filter(
      ([id]) => id.startsWith('incidents.') && id.split('.').length === 2,
    );
    expect(routes.map(([id]) => id).sort()).toEqual([
      'incidents.create',
      'incidents.get',
      'incidents.list',
      'incidents.nextSteps',
      'incidents.suggestions',
      'incidents.timeline',
      'incidents.transition',
      'incidents.update',
    ]);
    expect(BFF_ROUTES['incidents.update'].method).toBe('PATCH');
    for (const [id, definition] of routes)
      expect(definition.kind, id).toBe(definition.method === 'GET' ? 'session' : 'session-csrf');
  });
});

describe('incidents over HTTP', () => {
  it('creates a draft, edits it with CSRF, reads it, lists it and shows the timeline', async () => {
    const { managerA, adminA, vehicleId } = await fixture();
    const created = await managerA.post(P, {
      json: { vehicleId, type: 'collision' },
      headers: { 'idempotency-key': 'incident-key-1' },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({ status: 'draft', version: 1 });
    expect(created.json).not.toHaveProperty('tenantId');
    const replay = await managerA.post(P, {
      json: { vehicleId, type: 'collision' },
      headers: { 'idempotency-key': 'incident-key-1' },
    });
    expect(replay.status).toBe(201);
    expect(replay.json.id).toBe(created.json.id);
    const id = created.json.id as string;

    const noCsrf = await managerA.send('PATCH', `${P}/${id}`, {
      json: { version: 1, description: 'x' },
      csrf: null,
    });
    expect(noCsrf.status).toBe(403);
    const edited = await managerA.send('PATCH', `${P}/${id}`, {
      json: { version: 1, description: 'Golpe lateral' },
    });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.json).toMatchObject({ version: 2, description: 'Golpe lateral' });
    expect((await managerA.get(`${P}/${id}`)).json.id).toBe(id);
    const list = await adminA.get(`${P}?limit=25&status=draft`);
    expect(list.status, list.text).toBe(200);
    expect(list.json).toMatchObject({ total: 1, items: [{ id }] });
    const timeline = await managerA.get(`${P}/${id}/timeline`);
    expect(timeline.status, timeline.text).toBe(200);
    const suggestions = await managerA.get(
      `${P}/suggestions?vehicleId=${vehicleId}&occurredAt=2026-10-13T12:00:00.000Z`,
    );
    expect(suggestions.status, suggestions.text).toBe(200);
  });

  it('answers field errors on 400, stale versions on 409 and bad queries on 400', async () => {
    const { managerA, vehicleId } = await fixture();
    const bad = await managerA.post(P, { json: { vehicleId, type: 'teleport' } });
    expect(bad.status).toBe(400);
    expect(bad.json.fieldErrors).toEqual(expect.any(Array));
    const created = await managerA.post(P, { json: { vehicleId, type: 'collision' } });
    const id = created.json.id as string;
    const stale = await managerA.send('PATCH', `${P}/${id}`, {
      json: { version: 7, description: 'x' },
    });
    expect(stale.status).toBe(409);
    expect((await managerA.get(`${P}?limit=7`)).status).toBe(400);
    expect((await managerA.get(`${P}?cursor=forjado.forjado`)).status).toBe(400);
    expect((await managerA.get(`${P}?unknown=1`)).status).toBe(400);
  });

  it('accepts the status filter comma-separated or repeated, and nothing else repeated', async () => {
    const { managerA, vehicleId } = await fixture();
    expect((await managerA.post(P, { json: { vehicleId, type: 'collision' } })).status).toBe(201);
    for (const query of ['status=draft,reported', 'status=draft&status=reported'])
      expect((await managerA.get(`${P}?${query}`)).json.total, query).toBe(1);
    expect((await managerA.get(`${P}?status=reported&status=closed`)).json.total).toBe(0);
    expect((await managerA.get(`${P}?type=collision&type=rollover`)).status).toBe(400);
  });

  it('paginates with a signed cursor that cannot be forged', async () => {
    const { managerA, vehicleId } = await fixture();
    for (let n = 0; n < 3; n += 1)
      expect((await managerA.post(P, { json: { vehicleId, type: 'collision' } })).status).toBe(201);
    const first = await managerA.get(`${P}?limit=25`);
    expect(first.json.items).toHaveLength(3);
    expect(first.json.nextCursor ?? null).toBeNull();
    expect((await managerA.get(`${P}?cursor=abc.def`)).status).toBe(400);
  });

  it('refuses the generic editor, hides other tenants and fails closed for the mechanic scope', async () => {
    const { managerA, editorA, mechA, adminB, vehicleId } = await fixture();
    const created = await managerA.post(P, { json: { vehicleId, type: 'collision' } });
    const id = created.json.id as string;
    expect((await editorA.post(P, { json: { vehicleId, type: 'collision' } })).status).toBe(403);
    expect(
      (await editorA.send('PATCH', `${P}/${id}`, { json: { version: 1, description: 'x' } }))
        .status,
    ).toBe(403);
    expect((await adminB.get(`${P}/${id}`)).status).toBe(404);
    expect((await adminB.get(`${P}/${id}/timeline`)).status).toBe(404);
    expect((await mechA.get(`${P}/${id}`)).status).toBe(404);
    expect((await mechA.get(P)).json).toMatchObject({ total: 0, items: [] });
  });

  it('resolves driver and policy references of the tenant for suggestions and creation', async () => {
    const { managerA, adminA, vehicleId } = await fixture();
    const area = await adminA.post('/api/areas', { json: { name: 'Choferes' } });
    const driver = await adminA.post('/api/employees', {
      json: {
        kind: 'driver',
        firstName: 'Ana',
        lastName: 'Perez',
        areaId: area.json.id,
        employeeNumber: 'E-1',
        idType: 'ine',
        nationalId: 'SYNTH-ID-7788-Q1',
        phone: '+525590001234',
        email: 'ana.perez@synthetic.example',
        licenseNumber: 'LIC-445566-1',
        licenseType: 'c',
        licenseExpiresOn: '2099-01-31',
      },
    });
    expect(driver.status, driver.text).toBe(201);
    const assigned = await adminA.post('/api/vehicle-assignments', {
      json: {
        vehicleId,
        employeeId: driver.json.id,
        type: 'principal',
        reason: 'Alta de unidad',
      },
    });
    expect(assigned.status, assigned.text).toBe(201);
    const policy = await adminA.post('/api/insurance-policies', {
      json: {
        vehicleId,
        insurer: 'Aseguradora Ficticia',
        policyNumber: 'pol-001',
        coverageType: 'comprehensive',
        startsOn: '2020-01-01',
        endsOn: '2099-12-31',
      },
    });
    expect(policy.status, policy.text).toBe(201);
    const occurredAt = new Date().toISOString();
    const found = await managerA.get(
      `${P}/suggestions?vehicleId=${vehicleId}&occurredAt=${occurredAt}`,
    );
    expect(found.status, found.text).toBe(200);
    expect(found.json.policies).toHaveLength(1);
    expect(found.json.policies[0]).toMatchObject({ insurer: 'Aseguradora Ficticia' });
    expect(found.json.drivers).toEqual([
      { employeeId: driver.json.id, displayName: 'Ana Perez', type: 'principal' },
    ]);
    const created = await managerA.post(P, {
      json: {
        vehicleId,
        type: 'collision',
        occurredAt,
        driverId: driver.json.id,
        policyId: policy.json.id,
      },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.json.driver).toMatchObject({ displayName: 'Ana Perez' });
  });
});
