import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { MAINTENANCE_TABLES } from '../../../packages/persistence/maintenance/plans/src/index.js';
import { MAINTENANCE_PLAN_SCAN_JOB } from '../../../apps/api/composition/src/platform/runtime.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from '../fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../fleet/world.js';
import { deliverOutboxEvents, makeEventsAvailable } from '../../fixtures/maintenance/plan-scan.js';

const suite = adminUrl ? describe : describe.skip;

suite('periodic maintenance plan scan on MySQL', () => {
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

  const scanEvents = () =>
    database.tenantA.rows<{ event_id: string; status: string }>(
      `SELECT event_id, status FROM ${AUDIT_TABLES.outbox} WHERE tenant_id = ? AND type = 'maintenance.plan.scan' ORDER BY event_id`,
      [fleet.tenantA],
    );

  it('queues a scan per active plan on each tick, creates one preventive order and never duplicates it', async () => {
    const area = await fleet.area(fleet.adminA, 'Mantenimiento periódico');
    const dueVehicle = await fleet.vehicle(fleet.adminA, area, 'PER001');
    const pausedVehicle = await fleet.vehicle(fleet.adminA, area, 'PER002');
    // The target date (2026-10-06) is already reached on the composed clock.
    const body = (vehicleId: string) => ({
      json: {
        vehicleId,
        intervalDays: 30,
        lastServiceDate: '2026-09-06',
        intervalKm: 100000,
        lastServiceKm: 0,
      },
    });
    const duePlan = await fleet.adminA.post('/api/v1/maintenance/plans', body(dueVehicle));
    expect(duePlan.status, duePlan.text).toBe(201);
    const pausedPlan = await fleet.adminA.post('/api/v1/maintenance/plans', body(pausedVehicle));
    expect(pausedPlan.status, pausedPlan.text).toBe(201);
    const paused = await fleet.adminA.post(
      `/api/v1/maintenance/plans/${pausedPlan.json.id as string}/pause`,
      { json: { version: 1 } },
    );
    expect(paused.status, paused.text).toBe(200);
    const planId = duePlan.json.id as string;

    expect(await fleet.platformA.runtime.periodic.tick(MAINTENANCE_PLAN_SCAN_JOB)).toEqual({
      enqueued: 1,
      failed: 0,
    });
    const queued = await scanEvents();
    // Only the active plan is queued; the paused one is skipped.
    expect(queued.map((row) => row.event_id)).toEqual([expect.stringContaining(`-${planId}-`)]);
    const eventIds = queued.map((row) => row.event_id);
    // Synthetic events carry the database clock; align them with the composed world clock.
    await makeEventsAvailable(database.tenantA, fleet.tenantA, eventIds);
    await deliverOutboxEvents(fleet.platformA, database.tenantA, fleet.tenantA, eventIds);

    const orders = () =>
      database.tenantA.rows<{ status: string; kind: string }>(
        `SELECT status, kind FROM ${MAINTENANCE_TABLES.orders} WHERE company_id = ? AND plan_id = ?`,
        [fleet.tenantA, planId],
      );
    expect(await orders()).toEqual([{ status: 'scheduled', kind: 'preventive' }]);

    // A second tick inside the same hour repeats the same event ids: nothing new is queued.
    await fleet.platformA.runtime.periodic.tick(MAINTENANCE_PLAN_SCAN_JOB);
    expect((await scanEvents()).map((row) => row.event_id)).toEqual(eventIds);
    await fleet.platformA.runtime.drainOutbox();
    expect(await orders()).toHaveLength(1);
    const occurrences = await database.tenantA.rows<{ sequence: number }>(
      `SELECT sequence FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id = ? AND plan_id = ?`,
      [fleet.tenantA, planId],
    );
    expect(occurrences).toEqual([{ sequence: 1 }]);
  }, 120_000);
});
