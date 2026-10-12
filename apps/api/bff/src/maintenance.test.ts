import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

async function fixture() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const adminA = await world.loginAs('subject-admin-a');
  const viewerA = await world.loginAs('subject-viewer-a');
  const adminB = await world.loginAs('subject-admin-b');
  const area = await adminA.post('/api/areas', { json: { name: 'Operaciones' } });
  const vehicle = await adminA.post('/api/vehicles', {
    json: {
      economicNumber: 'M-001',
      plate: 'MNT-001',
      make: 'Toyota',
      model: 'Hilux',
      year: 2024,
      areaId: area.json.id,
      odometerKm: 1000,
    },
  });
  expect(vehicle.status).toBe(201);
  return { adminA, adminB, viewerA, vehicleId: vehicle.json.id as string };
}

describe('maintenance contract', () => {
  it('declares all maintenance routes as session reads or CSRF-protected writes', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('maintenance.'));
    expect(routes).toHaveLength(18);
    for (const [id, definition] of routes)
      expect(definition.kind, id).toBe(definition.method === 'GET' ? 'session' : 'session-csrf');
  });
});

describe('maintenance over HTTP', () => {
  it('manages plans, schedules, workshops and mechanics with tenant-scoped responses', async () => {
    const { adminA, adminB, vehicleId } = await fixture();
    const workshop = await adminA.post('/api/v1/maintenance/workshops', {
      json: { name: 'Taller Centro', specialties: ['motor'], contact: 'centro@example.test' },
    });
    expect(workshop.status).toBe(201);
    expect(workshop.json).not.toHaveProperty('tenantId');
    expect((await adminA.get('/api/v1/maintenance/workshops')).json).toHaveLength(1);
    expect((await adminA.get(`/api/v1/maintenance/workshops/${workshop.json.id}`)).json.name).toBe(
      'Taller Centro',
    );
    expect(
      (
        await adminA.put(`/api/v1/maintenance/workshops/${workshop.json.id}`, {
          json: { name: 'Taller Norte', specialties: ['motor', 'frenos'] },
        })
      ).json.name,
    ).toBe('Taller Norte');

    const mechanic = await adminA.post('/api/v1/maintenance/mechanics', {
      json: {
        name: 'Mecánica Externa',
        specialties: ['motor'],
        kind: 'external',
        workshopId: workshop.json.id,
      },
    });
    expect(mechanic.status).toBe(201);
    expect((await adminA.get('/api/v1/maintenance/mechanics')).json).toHaveLength(1);
    expect((await adminA.get(`/api/v1/maintenance/mechanics/${mechanic.json.id}`)).json.kind).toBe(
      'external',
    );
    expect(
      (
        await adminA.put(`/api/v1/maintenance/mechanics/${mechanic.json.id}`, {
          json: {
            name: 'Mecánica Preferida',
            specialties: ['motor'],
            kind: 'external',
            workshopId: workshop.json.id,
          },
        })
      ).json.name,
    ).toBe('Mecánica Preferida');

    const plan = await adminA.post('/api/v1/maintenance/plans', {
      json: {
        vehicleId,
        intervalDays: 180,
        lastServiceDate: '2026-01-01',
        defaultWorkshopId: workshop.json.id,
        defaultMechanicId: mechanic.json.id,
      },
    });
    expect(plan.status).toBe(201);
    expect(plan.json).toMatchObject({
      vehicleId,
      defaultWorkshopId: workshop.json.id,
      defaultMechanicId: mechanic.json.id,
      version: 1,
    });
    expect(plan.json).not.toHaveProperty('tenantId');
    const planId = plan.json.id as string;
    expect((await adminA.get('/api/v1/maintenance/plans')).json).toHaveLength(1);
    expect((await adminA.get(`/api/v1/maintenance/plans/${planId}`)).json.id).toBe(planId);
    expect((await adminA.get(`/api/v1/maintenance/plans/${planId}/schedule`)).json).toMatchObject({
      planId,
      occurrence: null,
      order: null,
    });
    expect((await adminA.get(`/api/v1/maintenance/plans/${planId}/orders`)).json).toEqual([]);

    const updated = await adminA.put(`/api/v1/maintenance/plans/${planId}`, {
      json: { version: 1, intervalDays: 90 },
    });
    expect(updated.json).toMatchObject({ version: 2, intervalDays: 90 });
    const paused = await adminA.post(`/api/v1/maintenance/plans/${planId}/pause`, {
      json: { version: 2 },
    });
    expect(paused.json).toMatchObject({ state: 'paused', version: 3 });
    const resumed = await adminA.post(`/api/v1/maintenance/plans/${planId}/resume`, {
      json: { version: 3 },
    });
    expect(resumed.json).toMatchObject({ state: 'active', version: 4 });

    expect((await adminB.get('/api/v1/maintenance/plans')).json).toEqual([]);
    expect((await adminB.get(`/api/v1/maintenance/plans/${planId}`)).status).toBe(404);
    expect((await adminA.get('/api/v1/maintenance/mechanics')).json).toHaveLength(1);
    const closedMechanic = await adminA.post(
      `/api/v1/maintenance/mechanics/${mechanic.json.id}/deactivate`,
    );
    expect(closedMechanic.json.active).toBe(false);
    const closedWorkshop = await adminA.post(
      `/api/v1/maintenance/workshops/${workshop.json.id}/deactivate`,
    );
    expect(closedWorkshop.json.active).toBe(false);
  });

  it('rejects bad bodies, missing sessions, foreign catalog IDs and read-only writes', async () => {
    const { adminA, adminB, viewerA, vehicleId } = await fixture();
    expect(
      (await adminA.post('/api/v1/maintenance/workshops', { json: { unknown: true } })).status,
    ).toBe(400);
    expect(
      (await adminA.post('/api/v1/maintenance/mechanics', { json: { name: 'Incomplete' } })).status,
    ).toBe(400);
    expect(
      (await adminA.post('/api/v1/maintenance/plans', { json: { vehicleId, extra: true } })).status,
    ).toBe(400);
    expect(
      (await adminA.put('/api/v1/maintenance/plans/plan', { json: { version: 1 } })).status,
    ).toBe(400);
    expect((await adminA.post('/api/v1/maintenance/plans/plan/pause', { json: {} })).status).toBe(
      400,
    );
    expect((await adminA.get('/api/v1/maintenance/plans', { cookies: false })).status).toBe(401);
    expect(
      (
        await viewerA.post('/api/v1/maintenance/workshops', {
          json: { name: 'No autorizado', specialties: [] },
        })
      ).status,
    ).toBe(403);

    const foreignWorkshop = await adminB.post('/api/v1/maintenance/workshops', {
      json: { name: 'Taller Beta', specialties: [] },
    });
    const rejectedPlan = await adminA.post('/api/v1/maintenance/plans', {
      json: {
        vehicleId,
        intervalDays: 30,
        lastServiceDate: '2026-01-01',
        defaultWorkshopId: foreignWorkshop.json.id,
      },
    });
    expect(rejectedPlan.status).toBe(409);
    expect((await adminA.get('/api/v1/maintenance/workshops/foreign-id')).status).toBe(404);
  });

  it('maps a persistence error to a uniform response without exposing details', async () => {
    const { adminA, vehicleId } = await fixture();
    Object.defineProperty(world.platform.maintenance, 'createPlan', {
      value: async () => ({
        ok: false,
        error: { code: 'internal_error', status: 500, message: 'database is unavailable' },
      }),
    });
    const failed = await adminA.post('/api/v1/maintenance/plans', {
      json: { vehicleId, intervalDays: 30, lastServiceDate: '2026-01-01' },
    });
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain('database is unavailable');
    expect((await adminA.get('/api/v1/maintenance/plans')).status).toBe(200);
  });
});
