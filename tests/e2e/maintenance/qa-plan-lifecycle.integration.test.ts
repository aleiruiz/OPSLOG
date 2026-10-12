import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { MAINTENANCE_TABLES } from '../../../packages/persistence/maintenance/plans/src/index.js';
import type { WorkOrder } from '../../../packages/domain/maintenance/orders/src/index.js';
import type { MaintenancePlan } from '../../../packages/domain/maintenance/plans/src/index.js';
import { ACTORS, adminUrl, at, startMaintenanceWorld, type MaintenanceWorld } from './qa-world.js';

const suite = adminUrl ? describe : describe.skip;
const PREFIX = 'maintenance.order.preventive_';

interface OutboxRow {
  event_id: string;
  type: string;
  payload: Record<string, string | number>;
}
interface OccurrenceRow {
  sequence: number;
  state: string;
  target_date: string | null;
  adopted_at: Date | null;
  order_status: string;
}

// G3 audit H1/M1/L3: plan lifecycle after cancel and reopen, on real MySQL 8.4. The outbox rows
// written by the order service are handed to the plans consumers exactly like the worker does.
suite('plan lifecycle (cancel, reopen, late close) on MySQL 8.4', () => {
  let world: MaintenanceWorld;
  beforeAll(async () => {
    world = await startMaintenanceWorld('qa_plan_lifecycle');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  }, 60_000);

  let tick = 0;
  const service = () =>
    world.service({
      clock: () => new Date(Date.parse('2026-10-12T12:00:00Z') + (tick += 1) * 1000),
    });

  /** Delivers the lifecycle events of the tenant; `again` replays what was already delivered. */
  const seen = new Set<string>();
  async function relay(
    options: { again?: boolean; reverse?: boolean; skip?: (row: OutboxRow) => boolean } = {},
  ): Promise<number> {
    const t = world.tenantA;
    const rows = await world.db.rows<OutboxRow>(
      `SELECT event_id, type, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND type LIKE '${PREFIX}%' ORDER BY occurred_at ${options.reverse ? 'DESC' : 'ASC'}, event_id`,
      [t],
    );
    let delivered = 0;
    for (const row of rows) {
      if (options.skip?.(row)) continue;
      if (seen.has(row.event_id) && !options.again) continue;
      seen.add(row.event_id);
      delivered += 1;
      const p = row.payload;
      const base = {
        tenantId: t,
        eventId: row.event_id,
        planId: String(p['planId']),
        occurrenceId: String(p['occurrenceId']),
        orderId: String(p['orderId']),
      };
      const version = Number(p['version']);
      if (row.type === `${PREFIX}closed`)
        await world.plansA.closePreventive({
          ...base,
          kind: 'preventive',
          completedAt: String(p['completedAt']),
          actualDate: String(p['actualDate']),
          actualKm: Number(p['actualKm']),
          version,
        });
      else if (row.type === `${PREFIX}reopened`)
        await world.plansA.reopenPreventive({ ...base, version });
      else if (row.type === `${PREFIX}cancelled`)
        await world.plansA.cancelPreventive({ ...base, version });
      else if (row.type === `${PREFIX}adopted`)
        await world.plansA.adoptPreventive({ ...base, version });
    }
    return delivered;
  }

  const occurrences = (planId: string) =>
    world.db.rows<OccurrenceRow>(
      `SELECT o.sequence, o.state, o.target_date, o.adopted_at, s.status AS order_status FROM ${MAINTENANCE_TABLES.occurrences} o JOIN ${MAINTENANCE_TABLES.orders} s ON s.company_id=o.company_id AND s.occurrence_id=o.id WHERE o.company_id=? AND o.plan_id=? ORDER BY o.sequence`,
      [world.tenantA, planId],
    );
  const scan = (store: typeof world.plansA, planId: string, iso: string, km = 0) =>
    store.scan(world.tenantA, planId, at(iso), { km, updatedAt: iso });
  const newPlan = (values: Partial<MaintenancePlan>) =>
    world.plan(world.plansA, world.tenantA, values);

  async function adopt(planId: string, n = 0): Promise<WorkOrder> {
    const t = world.tenantA;
    const orders = [...(await world.plansA.listScheduledOrders(t, planId))].reverse();
    const scheduled = orders.filter((o) => o.status === 'scheduled')[n];
    return service().adoptPreventive(t, ACTORS.editor, {
      planId,
      scheduledOrderId: scheduled?.id,
    });
  }
  async function start(order: WorkOrder): Promise<WorkOrder> {
    const t = world.tenantA;
    const s = service();
    let next = await s.assign(t, ACTORS.editor, order.id, {
      version: order.version,
      responsibleId: 'editor',
      mechanicId: 'mechanic-a',
      scheduledDate: '2026-10-12',
    });
    next = await s.start(t, world.mechanic, next.id, { version: next.version });
    return s.updateWork(t, world.mechanic, next.id, {
      version: next.version,
      tasks: [{ description: 'Servicio' }],
    });
  }
  const complete = (order: WorkOrder, actualDate: string, actualKm: number) =>
    service().complete(world.tenantA, world.mechanic, order.id, {
      version: order.version,
      actualDate,
      actualKm,
    });
  const close = (order: WorkOrder) =>
    service().close(world.tenantA, ACTORS.admin, order.id, {
      version: order.version,
      vehicleStatus: 'active',
    });
  const reopen = (order: WorkOrder) =>
    service().reopen(world.tenantA, ACTORS.admin, order.id, {
      version: order.version,
      reason: 'Corrección de captura',
    });
  const cancel = (order: WorkOrder) =>
    service().cancel(world.tenantA, ACTORS.editor, order.id, {
      version: order.version,
      reason: 'Vehículo en otra sede',
    });
  const planOf = async (id: string) =>
    (await world.plansA.get(world.tenantA, id)) as MaintenancePlan;

  async function closedFirstService(planId: string): Promise<WorkOrder> {
    let order = await adopt(planId);
    order = await start(order);
    order = await complete(order, '2026-10-11', 900);
    return close(order);
  }

  it('H1: cancelling an adopted preventive order frees the plan; the next scan schedules the pending service exactly once', async () => {
    const t = world.tenantA;
    const plan = await newPlan({ intervalDays: 30, lastServiceDate: '2026-09-01' });
    await scan(world.plansA, plan.id, '2026-10-12T00:00:00Z');
    expect(await world.plansA.listScheduledOrders(t, plan.id)).toHaveLength(1);
    const order = await adopt(plan.id);
    await relay();
    expect((await occurrences(plan.id))[0]?.adopted_at).not.toBeNull();
    const cancelled = await cancel(order);
    // Before the consumer runs the occurrence still blocks the plan (no event, no side effect).
    await scan(world.plansA, plan.id, '2026-10-13T00:00:00Z');
    expect(await occurrences(plan.id)).toHaveLength(1);
    await relay();
    expect(await relay({ again: true })).toBeGreaterThan(0);
    expect(cancelled.status).toBe('cancelled');
    for (const day of ['2026-11-15', '2026-12-20', '2027-03-01'])
      await Promise.all([
        scan(world.plansA, plan.id, `${day}T00:00:00Z`),
        scan(world.plansA2, plan.id, `${day}T00:00:00Z`),
      ]);
    const rows = await occurrences(plan.id);
    expect(rows.map((r) => [r.sequence, r.state, r.order_status, r.target_date])).toEqual([
      [1, 'cancelled', 'cancelled', '2026-10-01'],
      [2, 'scheduled', 'scheduled', '2026-10-01'],
    ]);
    const overdue = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${MAINTENANCE_TABLES.alerts} WHERE company_id=? AND plan_id=? AND occurrence=2 AND kind='overdue'`,
      [t, plan.id],
    );
    expect(Number(overdue[0]?.total)).toBe(1);
    // The rescheduled order is a fresh scheduled order that can be adopted again.
    const again = await adopt(plan.id);
    expect(again.id).not.toBe(order.id);
    expect(again.planId).toBe(plan.id);
  });

  it('M1: reopen restores the baseline, a corrected re-close applies once and a lower km can be fixed', async () => {
    const t = world.tenantA;
    const plan = await newPlan({
      intervalDays: 30,
      intervalKm: 5000,
      lastServiceDate: '2026-09-01',
      lastServiceKm: 0,
    });
    await scan(world.plansA, plan.id, '2026-10-12T00:00:00Z', 6000);
    const closed = await closedFirstService(plan.id);
    await relay();
    expect(await planOf(plan.id)).toMatchObject({
      version: 2,
      lastServiceDate: '2026-10-11',
      lastServiceKm: 900,
    });
    await scan(world.plansA, plan.id, '2026-11-10T00:00:00Z', 900);
    expect(await occurrences(plan.id)).toHaveLength(2);
    const reopened = await reopen(closed);
    // The order side validates against the baseline before its own closure (km 90 < 900 is allowed).
    expect(
      await world.plansA.baselineBeforeClosure(t, plan.id, await firstOccurrence(plan.id)),
    ).toEqual({
      lastServiceDate: '2026-09-01',
      lastServiceKm: 0,
    });
    const corrected = await complete(reopened, '2026-10-10', 90);
    const recloseOrder = await close(corrected);
    expect(recloseOrder.status).toBe('closed');
    await relay();
    await relay({ again: true });
    expect(await planOf(plan.id)).toMatchObject({
      lastServiceDate: '2026-10-10',
      lastServiceKm: 90,
    });
    const rows = await occurrences(plan.id);
    expect(rows.map((r) => [r.sequence, r.state])).toEqual([
      [1, 'completed'],
      [2, 'cancelled'],
    ]);
    // The superseded unadopted successor is replaced, never duplicated, by one correctly targeted order.
    await scan(world.plansA, plan.id, '2026-11-09T00:00:00Z', 90);
    await scan(world.plansA2, plan.id, '2026-11-09T01:00:00Z', 90);
    const after = await occurrences(plan.id);
    expect(after.map((r) => [r.sequence, r.state, r.target_date])).toEqual([
      [1, 'completed', '2026-10-01'],
      [2, 'cancelled', '2026-11-10'],
      [3, 'scheduled', '2026-11-09'],
    ]);
    // Replaying every event keeps the plan at the same version (idempotent by order version).
    const version = (await planOf(plan.id)).version;
    await relay({ again: true });
    expect((await planOf(plan.id)).version).toBe(version);
  });

  async function firstOccurrence(planId: string): Promise<string> {
    const rows = await world.db.rows<{ id: string }>(
      `SELECT id FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id=? AND plan_id=? AND sequence=1`,
      [world.tenantA, planId],
    );
    return String(rows[0]?.id);
  }

  it('M1: events delivered out of order (close before reopen) converge on the corrected closure', async () => {
    const plan = await newPlan({ intervalDays: 30, lastServiceDate: '2026-09-01' });
    await scan(world.plansA, plan.id, '2026-10-12T00:00:00Z');
    const closed = await closedFirstService(plan.id);
    await relay();
    const reopened = await reopen(closed);
    await close(await complete(reopened, '2026-10-09', 40));
    // Newest first: the second close is applied over the first closure, the stale reopen is ignored.
    await relay({ reverse: true });
    await relay({ again: true });
    expect(await planOf(plan.id)).toMatchObject({
      lastServiceDate: '2026-10-09',
      lastServiceKm: 40,
    });
    expect((await occurrences(plan.id)).map((r) => r.state)).toEqual(['completed']);
  });

  it('M1: reopen then cancel ends with a restored baseline and a rescheduled service (H1 state)', async () => {
    const plan = await newPlan({ intervalDays: 30, lastServiceDate: '2026-09-01' });
    await scan(world.plansA, plan.id, '2026-10-12T00:00:00Z');
    const closed = await closedFirstService(plan.id);
    await relay();
    expect((await planOf(plan.id)).lastServiceDate).toBe('2026-10-11');
    await cancel(await reopen(closed));
    await relay();
    expect(await planOf(plan.id)).toMatchObject({ lastServiceDate: '2026-09-01' });
    await scan(world.plansA, plan.id, '2026-10-20T00:00:00Z');
    await scan(world.plansA2, plan.id, '2026-10-20T00:00:00Z');
    expect((await occurrences(plan.id)).map((r) => [r.sequence, r.state, r.target_date])).toEqual([
      [1, 'cancelled', '2026-10-01'],
      [2, 'scheduled', '2026-10-01'],
    ]);
  });

  it('M1: an adopted successor survives a reopen; only scheduled successors are superseded', async () => {
    const plan = await newPlan({ intervalDays: 30, lastServiceDate: '2026-09-01' });
    await scan(world.plansA, plan.id, '2026-10-12T00:00:00Z');
    const closed = await closedFirstService(plan.id);
    await relay();
    await scan(world.plansA, plan.id, '2026-11-20T00:00:00Z');
    const successor = await adopt(plan.id);
    await relay();
    await reopen(closed);
    await relay();
    const rows = await occurrences(plan.id);
    expect(rows.map((r) => [r.sequence, r.state])).toEqual([
      [1, 'scheduled'],
      [2, 'scheduled'],
    ]);
    expect(rows[1]?.adopted_at).not.toBeNull();
    expect(successor.occurrenceId).toBeTruthy();
    // No third order appears while the reopened and the adopted ones are open.
    await scan(world.plansA, plan.id, '2026-12-30T00:00:00Z');
    expect(await occurrences(plan.id)).toHaveLength(2);
  });

  it('L3: a plan edit between completion and close no longer dead-letters the closure', async () => {
    const t = world.tenantA;
    const plan = await newPlan({
      intervalDays: 30,
      lastServiceDate: '2026-09-01',
      lastServiceKm: 0,
    });
    await scan(world.plansA, plan.id, '2026-10-12T00:00:00Z');
    let order = await adopt(plan.id);
    order = await start(order);
    order = await complete(order, '2026-10-11', 900);
    const current = await planOf(plan.id);
    expect(
      await world.plansA.update(
        {
          ...current,
          lastServiceKm: 2000,
          version: current.version + 1,
          updatedAt: '2026-10-12T12:30:00.000Z',
        },
        current.version,
        'user-admin',
      ),
    ).toBe(true);
    await close(order);
    await expect(relay()).resolves.toBeGreaterThan(0);
    expect(await planOf(plan.id)).toMatchObject({
      lastServiceDate: '2026-10-11',
      lastServiceKm: 2000,
    });
    expect((await occurrences(plan.id)).map((r) => r.state)).toEqual(['completed']);
    // Never moved backwards: a second delivery is a no-op.
    const version = (await planOf(plan.id)).version;
    await relay({ again: true });
    expect((await planOf(plan.id)).version).toBe(version);
    expect(t).toBeTruthy();
  });
});
