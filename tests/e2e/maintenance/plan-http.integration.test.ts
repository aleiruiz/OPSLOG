import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAINTENANCE_TABLES } from '../../../packages/persistence/maintenance/plans/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from '../fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../fleet/world.js';
import { deliverOutboxEvents, enqueuePlanScans } from '../../fixtures/maintenance/plan-scan.js';

const suite = adminUrl ? describe : describe.skip;

suite('maintenance plans through composed HTTP and MySQL', () => {
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

  it('chooses the first reached metric, keeps plans private across tenants, and deduplicates scan retries', async () => {
    const areaA = await fleet.area(fleet.adminA, 'Mantenimiento sintético A');
    const areaB = await fleet.area(fleet.adminB, 'Mantenimiento sintético B');
    const vehicleOdometer = await fleet.vehicle(fleet.adminA, areaA, 'MNT001');
    const vehicleDate = await fleet.vehicle(fleet.adminA, areaA, 'MNT002');
    const vehicleB = await fleet.vehicle(fleet.adminB, areaB, 'MNT003');

    const odometerPlan = await fleet.adminA.post('/api/v1/maintenance/plans', {
      json: {
        vehicleId: vehicleOdometer,
        intervalDays: 30,
        lastServiceDate: '2026-09-20',
        intervalKm: 10,
        lastServiceKm: 0,
      },
    });
    expect(odometerPlan.status, odometerPlan.text).toBe(201);
    expect(odometerPlan.json).not.toHaveProperty('tenantId');

    const datePlan = await fleet.adminA.post('/api/v1/maintenance/plans', {
      json: {
        vehicleId: vehicleDate,
        intervalDays: 30,
        lastServiceDate: '2026-09-06',
        intervalKm: 10,
        lastServiceKm: 0,
      },
    });
    expect(datePlan.status, datePlan.text).toBe(201);

    const planB = await fleet.adminB.post('/api/v1/maintenance/plans', {
      json: {
        vehicleId: vehicleB,
        intervalDays: 30,
        lastServiceDate: '2026-10-01',
        intervalKm: 100,
        lastServiceKm: 10,
      },
    });
    expect(planB.status, planB.text).toBe(201);

    const planAId = odometerPlan.json.id as string;
    const datePlanId = datePlan.json.id as string;
    const planBId = planB.json.id as string;

    const firstScans = await enqueuePlanScans(database.tenantA, fleet.tenantA, [
      { planId: planAId, attempt: 'first' },
      { planId: datePlanId, attempt: 'first' },
    ]);
    await deliverOutboxEvents(fleet.platformA, database.tenantA, fleet.tenantA, firstScans);
    // A later retry of an already processed scan must not create a second occurrence or alert.
    const retryScans = await enqueuePlanScans(database.tenantA, fleet.tenantA, [
      { planId: planAId, attempt: 'retry' },
    ]);
    await deliverOutboxEvents(fleet.platformA, database.tenantA, fleet.tenantA, retryScans);

    const odometerSchedule = await fleet.adminA.get(
      `/api/v1/maintenance/plans/${planAId}/schedule`,
    );
    expect(odometerSchedule.status, odometerSchedule.text).toBe(200);
    expect(odometerSchedule.json).toMatchObject({
      planId: planAId,
      nextTargetDate: '2026-10-20',
      nextTargetKm: 10,
      occurrence: { sequence: 1, trigger: 'odometer', state: 'scheduled' },
      order: {
        planId: planAId,
        vehicleId: vehicleOdometer,
        kind: 'preventive',
        status: 'scheduled',
      },
    });
    expect(odometerSchedule.json.occurrence.id).toBe(odometerSchedule.json.order.occurrenceId);

    const dateSchedule = await fleet.adminA.get(`/api/v1/maintenance/plans/${datePlanId}/schedule`);
    expect(dateSchedule.status, dateSchedule.text).toBe(200);
    expect(dateSchedule.json).toMatchObject({
      nextTargetDate: '2026-10-06',
      nextTargetKm: 10,
      occurrence: { sequence: 1, trigger: 'date', state: 'scheduled' },
      order: { kind: 'preventive', status: 'scheduled' },
    });

    const odometerRows = await database.rows<{
      sequence: number;
      trigger_kind: string;
      state: string;
    }>(
      `SELECT sequence, trigger_kind, state FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id = ? AND plan_id = ?`,
      [fleet.tenantA, planAId],
    );
    const odometerOrders = await database.rows<{ id: string; status: string }>(
      `SELECT id, status FROM ${MAINTENANCE_TABLES.orders} WHERE company_id = ? AND plan_id = ?`,
      [fleet.tenantA, planAId],
    );
    const odometerAlerts = await database.rows<{
      kind: string;
      trigger_kind: string;
      threshold_kind: string;
      odometer_age_seconds: number | null;
    }>(
      `SELECT kind, trigger_kind, threshold_kind, odometer_age_seconds FROM ${MAINTENANCE_TABLES.alerts} WHERE company_id = ? AND plan_id = ?`,
      [fleet.tenantA, planAId],
    );
    expect(odometerRows).toEqual([{ sequence: 1, trigger_kind: 'odometer', state: 'scheduled' }]);
    expect(odometerOrders).toHaveLength(1);
    expect(odometerOrders[0]?.status).toBe('scheduled');
    expect(odometerAlerts).toHaveLength(1);
    expect(odometerAlerts[0]).toMatchObject({
      kind: 'due',
      trigger_kind: 'odometer',
      threshold_kind: 'target',
      odometer_age_seconds: expect.any(Number),
    });

    const dateRows = await database.rows<{ sequence: number; trigger_kind: string; state: string }>(
      `SELECT sequence, trigger_kind, state FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id = ? AND plan_id = ?`,
      [fleet.tenantA, datePlanId],
    );
    const dateAlerts = await database.rows<{ kind: string; trigger_kind: string }>(
      `SELECT kind, trigger_kind FROM ${MAINTENANCE_TABLES.alerts} WHERE company_id = ? AND plan_id = ?`,
      [fleet.tenantA, datePlanId],
    );
    expect(dateRows).toEqual([{ sequence: 1, trigger_kind: 'date', state: 'scheduled' }]);
    expect(dateAlerts).toEqual([{ kind: 'due', trigger_kind: 'date' }]);

    expect((await fleet.adminA.get('/api/v1/maintenance/plans')).json).toHaveLength(2);
    expect((await fleet.adminB.get('/api/v1/maintenance/plans')).json).toHaveLength(1);
    expect((await fleet.adminA.get(`/api/v1/maintenance/plans/${planBId}`)).status).toBe(404);
    expect((await fleet.adminB.get(`/api/v1/maintenance/plans/${planAId}`)).status).toBe(404);
    expect(
      (await fleet.adminA.get(`/api/v1/maintenance/plans/${planAId}/schedule`)).text,
    ).not.toContain(fleet.tenantA);

    // M2 (G3): the in-app alert records the worker persisted are listed through the typed route.
    const listed = await fleet.adminA.get('/api/v1/maintenance/alerts');
    expect(listed.status, listed.text).toBe(200);
    expect(listed.json).toMatchObject({
      total: 2,
      nextCursor: null,
      sort: { field: 'occurredAt', direction: 'desc' },
    });
    expect(listed.text).not.toContain(fleet.tenantA);
    const items = listed.json.items as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items.find((item) => item['planId'] === planAId)).toMatchObject({
      vehicleId: vehicleOdometer,
      kind: 'due',
      trigger: 'odometer',
      threshold: 'target',
      targetKm: 10,
      odometerAgeSeconds: expect.any(Number),
    });
    expect(items.find((item) => item['planId'] === datePlanId)).toMatchObject({
      vehicleId: vehicleDate,
      kind: 'due',
      trigger: 'date',
      targetDate: '2026-10-06',
      odometerAgeSeconds: null,
    });
    const byPlan = await fleet.adminA.get(`/api/v1/maintenance/alerts?planId=${datePlanId}`);
    expect(byPlan.json).toMatchObject({ total: 1, items: [{ planId: datePlanId }] });
    const byVehicle = await fleet.adminA.get(
      `/api/v1/maintenance/alerts?vehicleId=${vehicleOdometer}`,
    );
    expect(byVehicle.json).toMatchObject({ total: 1, items: [{ planId: planAId }] });
    // Read-only roles see what the plans catalog already shows them; tenant B sees none of A's.
    expect((await fleet.viewerA.get('/api/v1/maintenance/alerts')).json).toMatchObject({
      total: 2,
    });
    expect((await fleet.adminB.get('/api/v1/maintenance/alerts')).json).toMatchObject({
      total: 0,
      items: [],
    });
    expect((await fleet.adminB.get(`/api/v1/maintenance/alerts?planId=${planAId}`)).status).toBe(
      404,
    );
    expect(
      (await fleet.adminB.get(`/api/v1/maintenance/alerts?vehicleId=${vehicleOdometer}`)).json,
    ).toMatchObject({ total: 0 });
    expect((await fleet.adminA.get('/api/v1/maintenance/alerts', { cookies: false })).status).toBe(
      401,
    );
    expect((await fleet.adminA.get('/api/v1/maintenance/alerts?limit=7')).status).toBe(400);
  }, 60_000);

  it('rejects unauthenticated, unauthorized, malformed, and foreign-tenant plan requests without writes', async () => {
    const areaA = await fleet.area(fleet.adminA, 'Mantenimiento HTTP errores');
    const vehicleA = await fleet.vehicle(fleet.adminA, areaA, 'MNTERR');
    const areaB = await fleet.area(fleet.adminB, 'Mantenimiento HTTP errores B');
    const vehicleB = await fleet.vehicle(fleet.adminB, areaB, 'MNTERRB');

    expect((await fleet.adminA.get('/api/v1/maintenance/plans', { cookies: false })).status).toBe(
      401,
    );
    expect(
      (
        await fleet.viewerA.post('/api/v1/maintenance/plans', {
          json: {
            vehicleId: vehicleA,
            intervalDays: 30,
            lastServiceDate: '2026-10-01',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fleet.adminA.post('/api/v1/maintenance/plans', {
          json: { vehicleId: vehicleA, unexpected: true },
        })
      ).status,
    ).toBe(400);

    const before = await database.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${MAINTENANCE_TABLES.plans} WHERE company_id = ?`,
      [fleet.tenantA],
    );
    const foreignVehicle = await fleet.adminA.post('/api/v1/maintenance/plans', {
      json: {
        vehicleId: vehicleB,
        intervalDays: 30,
        lastServiceDate: '2026-10-01',
      },
    });
    const unknownVehicle = await fleet.adminA.post('/api/v1/maintenance/plans', {
      json: {
        vehicleId: planIdMissing(),
        intervalDays: 30,
        lastServiceDate: '2026-10-01',
      },
    });
    // A vehicle of tenant B is indistinguishable from one that does not exist.
    expect(foreignVehicle.status).toBe(404);
    const { correlationId: foreignCorrelation, ...foreignError } = foreignVehicle.json;
    const { correlationId: unknownCorrelation, ...unknownError } = unknownVehicle.json;
    expect(foreignCorrelation).not.toBe(unknownCorrelation);
    expect(foreignError).toEqual(unknownError);
    expect(unknownVehicle.status).toBe(404);
    const after = await database.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${MAINTENANCE_TABLES.plans} WHERE company_id = ?`,
      [fleet.tenantA],
    );
    expect(after).toEqual(before);
    expect((await fleet.adminA.get(`/api/v1/maintenance/plans/${planIdMissing()}`)).status).toBe(
      404,
    );
  }, 60_000);
});

function planIdMissing(): string {
  return '00000000-0000-4000-8000-000000000099';
}
