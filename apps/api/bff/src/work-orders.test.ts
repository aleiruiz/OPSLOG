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

describe('work order contract', () => {
  it('declares work order routes as session reads or CSRF-protected writes', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('workOrders.'));
    expect(routes).toHaveLength(8);
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
      browser.post(`/api/v1/work-orders/${id}/transitions`, { json });

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
});
