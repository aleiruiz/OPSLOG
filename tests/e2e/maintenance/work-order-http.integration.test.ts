import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { MAINTENANCE_TABLES } from '../../../packages/persistence/maintenance/plans/src/index.js';
import { WORK_ORDER_TABLES } from '../../../packages/persistence/maintenance/orders/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from '../fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../fleet/world.js';
import {
  deliverOutboxEvents,
  enqueuePlanScans,
  makeEventsAvailable,
} from '../../fixtures/maintenance/plan-scan.js';

const suite = adminUrl ? describe : describe.skip;

suite('work orders through composed HTTP, worker and MySQL', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
  }, 120_000);

  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  it('closes a preventive order once and advances its plan through the durable outbox', async () => {
    const area = await fleet.area(fleet.adminA, 'Órdenes sintéticas A');
    const vehicleId = await fleet.vehicle(fleet.adminA, area, 'WO001');
    const workshop = await fleet.adminA.post('/api/v1/maintenance/workshops', {
      json: { name: 'Taller sintético', specialties: ['servicio'] },
    });
    expect(workshop.status, workshop.text).toBe(201);
    const plan = await fleet.adminA.post('/api/v1/maintenance/plans', {
      json: { vehicleId, intervalDays: 30, lastServiceDate: '2026-09-01' },
    });
    expect(plan.status, plan.text).toBe(201);
    const planId = plan.json.id as string;
    const scans = await enqueuePlanScans(database.tenantA, fleet.tenantA, [
      { planId, attempt: 'wo' },
    ]);
    await deliverOutboxEvents(fleet.platformA, database.tenantA, fleet.tenantA, scans);
    const schedule = await fleet.adminA.get(`/api/v1/maintenance/plans/${planId}/schedule`);
    const scheduledOrderId = schedule.json.order.id as string;

    const adopted = await fleet.adminA.post('/api/v1/work-orders/preventive', {
      json: { planId, scheduledOrderId },
    });
    expect(adopted.status, adopted.text).toBe(201);
    expect(adopted.json).toMatchObject({
      id: scheduledOrderId,
      kind: 'preventive',
      status: 'scheduled',
    });
    expect(
      (
        await fleet.adminA.post('/api/v1/work-orders/preventive', {
          json: { planId, scheduledOrderId },
        })
      ).status,
    ).toBe(409);
    expect((await fleet.adminB.get(`/api/v1/work-orders/${scheduledOrderId}`)).status).toBe(404);

    const step = async (json: Record<string, unknown>) => {
      const reply = await fleet.adminA.post(`/api/v1/work-orders/${scheduledOrderId}/transitions`, {
        json,
      });
      expect(reply.status, reply.text).toBe(200);
      return reply.json;
    };
    let order = await step({
      command: 'assign',
      version: 1,
      responsibleId: (await fleet.adminA.get('/api/auth/session')).json.user.id,
      workshopId: workshop.json.id,
      scheduledDate: '2026-10-06',
    });
    order = await step({ command: 'start', version: order.version });
    const worked = await fleet.adminA.put(`/api/v1/work-orders/${scheduledOrderId}/work`, {
      json: { version: order.version, tasks: [{ description: 'Servicio 30 días' }] },
    });
    expect(worked.status, worked.text).toBe(200);
    const early = await fleet.adminA.post(`/api/v1/work-orders/${scheduledOrderId}/transitions`, {
      json: {
        command: 'complete',
        version: worked.json.version,
        actualDate: '2026-08-31',
        actualKm: 0,
      },
    });
    expect(early.status).toBe(400);
    order = await step({
      command: 'complete',
      version: worked.json.version,
      actualDate: '2026-10-05',
      actualKm: 120,
    });
    order = await step({ command: 'close', version: order.version, vehicleStatus: 'active' });
    expect(order).toMatchObject({ status: 'closed', vehicleStatusDecision: 'active' });

    const closures = await database.rows<{ event_id: string }>(
      `SELECT event_id FROM ${AUDIT_TABLES.outbox} WHERE tenant_id = ? AND type = 'maintenance.order.preventive_closed' AND entity_id = ?`,
      [fleet.tenantA, scheduledOrderId],
    );
    expect(closures).toHaveLength(1);
    const closureIds = closures.map((c) => c.event_id);
    await makeEventsAvailable(database.tenantA, fleet.tenantA, closureIds);
    await deliverOutboxEvents(fleet.platformA, database.tenantA, fleet.tenantA, closureIds);
    const advanced = await fleet.adminA.get(`/api/v1/maintenance/plans/${planId}`);
    expect(advanced.json).toMatchObject({
      version: 2,
      lastServiceDate: '2026-10-05',
      lastServiceKm: 120,
    });
    const occurrences = await database.rows<{ state: string }>(
      `SELECT state FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id = ? AND plan_id = ?`,
      [fleet.tenantA, planId],
    );
    expect(occurrences).toEqual([{ state: 'completed' }]);
    const transitions = await database.rows<{ command: string }>(
      `SELECT command FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id = ? AND order_id = ? ORDER BY sequence`,
      [fleet.tenantA, scheduledOrderId],
    );
    expect(transitions.map((t) => t.command)).toEqual([
      'create',
      'assign',
      'start',
      'complete',
      'close',
    ]);
  }, 90_000);

  it('keeps corrective orders, costs and commands inside their tenant and role', async () => {
    const areaB = await fleet.area(fleet.adminB, 'Órdenes sintéticas B');
    const vehicleB = await fleet.vehicle(fleet.adminB, areaB, 'WO002');
    const foreign = await fleet.adminA.post('/api/v1/work-orders', {
      json: { vehicleId: vehicleB, description: 'Vehículo ajeno' },
    });
    const unknown = await fleet.adminA.post('/api/v1/work-orders', {
      json: { vehicleId: '00000000-0000-4000-8000-000000000077', description: 'Inexistente' },
    });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    const created = await fleet.adminB.post('/api/v1/work-orders', {
      json: { vehicleId: vehicleB, description: 'Ruido en suspensión' },
    });
    expect(created.status, created.text).toBe(201);
    const id = created.json.id as string;
    expect(
      (await fleet.adminA.get('/api/v1/work-orders')).json.map((o: { id: string }) => o.id),
    ).not.toContain(id);
    expect(
      (
        await fleet.adminA.post(`/api/v1/work-orders/${id}/transitions`, {
          json: { command: 'cancel', version: 1, reason: 'intento ajeno' },
        })
      ).status,
    ).toBe(404);
    const viewerCreate = await fleet.viewerA.post('/api/v1/work-orders', {
      json: { vehicleId: vehicleB, description: 'x' },
    });
    expect(viewerCreate.status).toBe(403);
    const rows = await database.rowsB<{ status: string }>(
      `SELECT status FROM ${WORK_ORDER_TABLES.orders} WHERE company_id = ? AND id = ?`,
      [fleet.tenantB, id],
    );
    expect(rows).toEqual([{ status: 'scheduled' }]);
    const leaked = await database.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${WORK_ORDER_TABLES.orders} WHERE id = ?`,
      [id],
    );
    expect(Number(leaked[0]?.total)).toBe(0);
  }, 60_000);
});
