import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { MAINTENANCE_TABLES } from '../../../packages/persistence/maintenance/plans/src/index.js';
import type { MaintenancePlan } from '../../../packages/domain/maintenance/plans/src/index.js';
import { adminUrl, at, startMaintenanceWorld, type MaintenanceWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const ALLOWED_ALERT_PAYLOAD = ['alertId', 'eventType', 'occurrenceId', 'planId', 'schemaVersion'];

// MNT-QA-M3-20261011, SPECS §7 maintenance alerts: upcoming at 15 calendar days / 500 km (inclusive),
// due at the first real target, overdue once that target has strictly passed. Fixed boundaries,
// no tenant setting and no grace period. Real MySQL 8.4 only.
suite('maintenance alert boundaries on MySQL 8.4', () => {
  let world: MaintenanceWorld;
  beforeAll(async () => {
    world = await startMaintenanceWorld('qa_alerts');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  }, 60_000);

  const state = async (plan: MaintenancePlan) => {
    const alerts = await world.db.rows<{
      kind: string;
      trigger_kind: string;
      threshold_kind: string;
      odometer_age_seconds: number | null;
    }>(
      `SELECT kind, trigger_kind, threshold_kind, odometer_age_seconds FROM ${MAINTENANCE_TABLES.alerts} WHERE company_id=? AND plan_id=? ORDER BY occurred_at, kind`,
      [world.tenantA, plan.id],
    );
    const [occurrences] = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id=? AND plan_id=?`,
      [world.tenantA, plan.id],
    );
    const [orders] = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${MAINTENANCE_TABLES.orders} WHERE company_id=? AND plan_id=?`,
      [world.tenantA, plan.id],
    );
    const events = await world.db.rows<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND type='maintenance.plan.alert' AND entity_id=?`,
      [world.tenantA, plan.id],
    );
    return {
      alerts,
      occurrences: Number(occurrences?.total),
      orders: Number(orders?.total),
      events,
    };
  };
  const scan = (plan: MaintenancePlan, iso: string, km = 0) =>
    world.plansA.scan(world.tenantA, plan.id, at(iso), { km, updatedAt: iso });
  const expectMinimalEvents = (events: { payload: Record<string, unknown> }[], count: number) => {
    expect(events).toHaveLength(count);
    for (const { payload } of events) {
      expect(Object.keys(payload).every((key) => ALLOWED_ALERT_PAYLOAD.includes(key))).toBe(true);
      expect(JSON.stringify(payload)).not.toMatch(/odometer|threshold|targetKm|targetDate|age/i);
    }
  };

  it('date plan: nothing before the 15-day boundary, one upcoming at it, one due at the target, then overdue', async () => {
    const plan = await world.plan(world.plansA, world.tenantA, {
      intervalDays: 30,
      lastServiceDate: '2026-10-01',
    });
    expect(await scan(plan, '2026-10-15T23:59:59.000Z')).toEqual([]);
    expect(await state(plan)).toMatchObject({ alerts: [], occurrences: 0, orders: 0 });
    expect(
      (await scan(plan, '2026-10-16T00:00:00.000Z')).map((e) => [e.kind, e.threshold]),
    ).toEqual([['upcoming', '15_days']]);
    await scan(plan, '2026-10-20T08:00:00.000Z');
    await scan(plan, '2026-10-30T23:59:59.000Z');
    let current = await state(plan);
    expect(current.alerts.map((a) => a.kind)).toEqual(['upcoming']);
    expect(current).toMatchObject({ occurrences: 0, orders: 0 });
    expect((await scan(plan, '2026-10-31T00:00:00.000Z')).map((e) => e.kind)).toEqual(['due']);
    await scan(plan, '2026-10-31T06:00:00.000Z');
    current = await state(plan);
    expect(current.alerts.map((a) => a.kind)).toEqual(['upcoming', 'due']);
    expect(current).toMatchObject({ occurrences: 1, orders: 1 });
    expect((await scan(plan, '2026-11-01T00:00:00.000Z')).map((e) => e.kind)).toEqual(['overdue']);
    await scan(plan, '2026-11-02T00:00:00.000Z');
    current = await state(plan);
    expect(current.alerts.map((a) => a.kind)).toEqual(['upcoming', 'due', 'overdue']);
    expect(current).toMatchObject({ occurrences: 1, orders: 1 });
    expectMinimalEvents(current.events, 3);
  });

  it('odometer plan: nothing at 501 km, one upcoming at 500 km, due at the target with odometer age, then overdue', async () => {
    const plan = await world.plan(world.plansA, world.tenantA, {
      intervalKm: 10_000,
      lastServiceKm: 0,
    });
    expect(await scan(plan, '2026-10-12T10:00:00.000Z', 9_499)).toEqual([]);
    expect(
      (await scan(plan, '2026-10-12T11:00:00.000Z', 9_500)).map((e) => [e.kind, e.threshold]),
    ).toEqual([['upcoming', '500_km']]);
    await scan(plan, '2026-10-12T12:00:00.000Z', 9_999);
    expect(await state(plan)).toMatchObject({ occurrences: 0, orders: 0 });
    expect((await scan(plan, '2026-10-12T13:00:00.000Z', 10_000)).map((e) => e.kind)).toEqual([
      'due',
    ]);
    expect((await scan(plan, '2026-10-12T14:00:00.000Z', 10_001)).map((e) => e.kind)).toEqual([
      'overdue',
    ]);
    const current = await state(plan);
    expect(current.alerts.map((a) => [a.kind, a.trigger_kind])).toEqual([
      ['upcoming', 'odometer'],
      ['due', 'odometer'],
      ['overdue', 'odometer'],
    ]);
    expect(current.alerts.every((a) => a.odometer_age_seconds !== null)).toBe(true);
    expect(current).toMatchObject({ occurrences: 1, orders: 1 });
    expectMinimalEvents(current.events, 3);
  });

  it('dual plan: a reached date suppresses the odometer upcoming, and a reached odometer suppresses the date upcoming', async () => {
    const byDate = await world.plan(world.plansA, world.tenantA, {
      intervalDays: 30,
      lastServiceDate: '2026-10-01',
      intervalKm: 10_000,
      lastServiceKm: 0,
    });
    expect(
      (await scan(byDate, '2026-10-31T00:00:00.000Z', 9_800)).map((e) => [e.kind, e.trigger]),
    ).toEqual([['due', 'date']]);
    expect((await state(byDate)).alerts.map((a) => a.kind)).toEqual(['due']);
    const byKm = await world.plan(world.plansA, world.tenantA, {
      intervalDays: 30,
      lastServiceDate: '2026-10-01',
      intervalKm: 10_000,
      lastServiceKm: 0,
    });
    expect(
      (await scan(byKm, '2026-10-20T00:00:00.000Z', 10_000)).map((e) => [e.kind, e.trigger]),
    ).toEqual([['due', 'odometer']]);
    expect((await state(byKm)).alerts.map((a) => a.kind)).toEqual(['due']);
  });

  it('first scan exactly at, or after, the target never synthesizes an upcoming record', async () => {
    const exact = await world.plan(world.plansA, world.tenantA, {
      intervalDays: 30,
      lastServiceDate: '2026-10-01',
    });
    expect((await scan(exact, '2026-10-31T09:00:00.000Z')).map((e) => e.kind)).toEqual(['due']);
    const late = await world.plan(world.plansA, world.tenantA, {
      intervalDays: 30,
      lastServiceDate: '2026-10-01',
    });
    expect((await scan(late, '2026-11-03T09:00:00.000Z')).map((e) => e.kind)).toEqual([
      'due',
      'overdue',
    ]);
    await scan(late, '2026-11-03T10:00:00.000Z');
    const current = await state(late);
    expect(current.alerts.map((a) => a.kind).sort()).toEqual(['due', 'overdue']);
    expect(current).toMatchObject({ occurrences: 1, orders: 1 });
    expectMinimalEvents(current.events, 2);
  });

  it('two concurrent scanners create at most one occurrence, order and due alert', async () => {
    const plan = await world.plan(world.plansA, world.tenantA, {
      intervalDays: 30,
      lastServiceDate: '2026-10-01',
    });
    const iso = '2026-10-31T00:00:00.000Z';
    const results = await Promise.all([
      world.plansA.scan(world.tenantA, plan.id, at(iso), { km: 0, updatedAt: iso }),
      world.plansA2.scan(world.tenantA, plan.id, at(iso), { km: 0, updatedAt: iso }),
    ]);
    expect(results.flat().filter((e) => e.kind === 'due')).toHaveLength(1);
    expect(await state(plan)).toMatchObject({ occurrences: 1, orders: 1 });
  });

  it('keeps tenant B plans invisible to tenant A and answers foreign like unknown', async () => {
    const planB = await world.plan(world.plansB, world.tenantB, {
      intervalDays: 30,
      lastServiceDate: '2026-10-01',
    });
    expect(await world.plansA.get(world.tenantA, planB.id)).toBeNull();
    await expect(
      world.plansA.scan(world.tenantA, planB.id, at('2026-10-31T00:00:00Z'), {
        km: 0,
        updatedAt: null,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      world.plansA.scan(world.tenantA, 'unknown-plan', at('2026-10-31T00:00:00Z'), {
        km: 0,
        updatedAt: null,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
