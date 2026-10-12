import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  WorkOrderService,
  type WorkOrderActor,
  type WorkOrderReferences,
} from '../../../../domain/maintenance/orders/src/index.js';
import { TypeOrmMaintenancePlanStore } from '../../plans/src/index.js';
import { AUDIT_TABLES } from '../../../audit/src/index.js';
import { TypeOrmWorkOrderStore } from './store.js';
import { WORK_ORDER_TABLES } from './entities.js';
import {
  adminUrl,
  startWorkOrderDatabase,
  type WorkOrderTestDatabase,
} from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const now = new Date('2026-10-12T12:00:00.000Z');
const ADMIN: WorkOrderActor = {
  id: 'user-admin',
  subject: 'admin',
  permissions: ['view', 'create', 'edit', 'view_costs', 'approve', 'reopen'],
  mechanicIds: [],
};

suite('work orders on disposable MySQL 8.4', () => {
  let db: WorkOrderTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  let plansA: TypeOrmMaintenancePlanStore;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const refs = (plans?: TypeOrmMaintenancePlanStore): WorkOrderReferences => ({
    vehicleExists: async (_tenant, vehicleId) => vehicleId === 'synthetic-vehicle',
    isTenantMember: async (_tenant, memberId) => memberId === 'admin',
    workshop: async (_tenant, id) => (id === 'workshop-1' ? { active: true } : null),
    mechanic: async () => null,
    mechanicIdsOfMember: async () => [],
    scheduledOrder: async (tenantId, planId, orderId) => {
      const found = (await plans?.listScheduledOrders(tenantId, planId))?.find(
        (o) => o.id === orderId,
      );
      return found
        ? {
            id: found.id,
            occurrenceId: found.occurrenceId,
            planId: found.planId,
            vehicleId: found.vehicleId,
            status: found.status,
            workshopId: null,
            mechanicId: null,
          }
        : null;
    },
    planBaseline: async (tenantId, planId) => {
      const plan = await plans?.get(tenantId, planId);
      return plan
        ? {
            lastServiceDate: plan.lastServiceDate ?? null,
            lastServiceKm: plan.lastServiceKm ?? null,
          }
        : null;
    },
    closeApprovalRequired: async () => false,
  });
  const service = (source: DataSource, plans?: TypeOrmMaintenancePlanStore) =>
    new WorkOrderService(new TypeOrmWorkOrderStore(source), refs(plans), { now: () => now });

  async function toCompleted(svc: WorkOrderService, tenantId: string, id: string, version: number) {
    let order = await svc.assign(tenantId, ADMIN, id, {
      version,
      responsibleId: 'admin',
      workshopId: 'workshop-1',
      scheduledDate: '2026-10-12',
    });
    order = await svc.start(tenantId, ADMIN, id, { version: order.version });
    order = await svc.updateWork(tenantId, ADMIN, id, {
      version: order.version,
      tasks: [{ description: 'Servicio sintético' }],
      parts: [{ name: 'Filtro', quantity: '1.250' }],
    });
    order = await svc.updateCosts(tenantId, ADMIN, id, {
      version: order.version,
      costs: [{ category: 'labor', amount: { amountMinor: '999999999999999', currency: 'MXN' } }],
      partCosts: [
        { partId: order.parts[0]?.id, unitCost: { amountMinor: '45050', currency: 'USD' } },
      ],
    });
    return svc.complete(tenantId, ADMIN, id, {
      version: order.version,
      actualDate: '2026-10-11',
      actualKm: 10400,
    });
  }

  beforeAll(async () => {
    db = await startWorkOrderDatabase('orders');
    sourceA = await db.openOrders('a');
    sourceA2 = await db.openOrders('a');
    sourceB = await db.openOrders('b');
    plansA = new TypeOrmMaintenancePlanStore(await db.openPlans('a'));
    for (const tenant of [tenantA, tenantB])
      await db.rows(
        `INSERT INTO opslog_maintenance_workshops (company_id,id,name,specialties,contact,active,created_at,updated_at) VALUES (?, 'workshop-1', 'Taller sintético', JSON_ARRAY(), NULL, TRUE, NOW(6), NOW(6))`,
        [tenant],
      );
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('commits order, work facts, timeline, audit and allowlisted outbox atomically with exact money', async () => {
    const svc = service(sourceA);
    const created = await svc.createCorrective(tenantA, ADMIN, {
      vehicleId: 'synthetic-vehicle',
      description: 'Ruido sintético',
    });
    const done = await toCompleted(svc, tenantA, created.id, created.version);
    const closed = await svc.close(tenantA, ADMIN, created.id, {
      version: done.version,
      vehicleStatus: 'active',
    });
    const stored = await new TypeOrmWorkOrderStore(sourceA).get(tenantA, created.id);
    expect(stored).toEqual(closed);
    expect(stored?.costs[0]?.amount).toEqual({ amountMinor: '999999999999999', currency: 'MXN' });
    expect(stored?.parts[0]).toMatchObject({
      quantity: '1.25',
      unitCost: { amountMinor: '45050', currency: 'USD' },
    });
    const transitions = await db.rows<{ command: string }>(
      `SELECT command FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? ORDER BY sequence`,
      [tenantA, created.id],
    );
    expect(transitions.map((t) => t.command)).toEqual([
      'create',
      'assign',
      'start',
      'complete',
      'close',
    ]);
    const [audit] = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${AUDIT_TABLES.local} WHERE tenant_id=? AND entity_id=?`,
      [tenantA, created.id],
    );
    expect(Number(audit?.count)).toBe(closed.version);
    const outbox = await db.rows<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? ORDER BY occurred_at, event_id`,
      [tenantA, created.id],
    );
    expect(outbox.length).toBe(5);
    for (const row of outbox)
      expect(Object.keys(row.payload).sort()).toEqual(['orderId', 'vehicleId', 'version']);
    expect(JSON.stringify(outbox)).not.toMatch(/999999999999999|Ruido|Filtro|MXN/);
  });

  it('isolates tenants by database and by tenant key', async () => {
    const svcA = service(sourceA);
    const order = await svcA.createCorrective(tenantA, ADMIN, {
      vehicleId: 'synthetic-vehicle',
      description: 'A',
    });
    expect(await new TypeOrmWorkOrderStore(sourceA).get(tenantB, order.id)).toBeNull();
    expect(await new TypeOrmWorkOrderStore(sourceB).get(tenantA, order.id)).toBeNull();
    await expect(
      sourceA.query(`SELECT id FROM \`${db.otherDatabaseName}\`.\`${WORK_ORDER_TABLES.orders}\``),
    ).rejects.toBeDefined();
    await expect(svcA.get(tenantB, ADMIN, order.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets exactly one of two concurrent closes win and emits one closure', async () => {
    const svc = service(sourceA);
    const created = await svc.createCorrective(tenantA, ADMIN, {
      vehicleId: 'synthetic-vehicle',
      description: 'Carrera',
    });
    const done = await toCompleted(svc, tenantA, created.id, created.version);
    const results = await Promise.allSettled([
      service(sourceA).close(tenantA, ADMIN, created.id, {
        version: done.version,
        vehicleStatus: 'active',
      }),
      service(sourceA2).close(tenantA, ADMIN, created.id, {
        version: done.version,
        vehicleStatus: 'restricted',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'stale_version' },
    });
    const closes = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? AND command='close'`,
      [tenantA, created.id],
    );
    expect(Number(closes[0]?.count)).toBe(1);
  });

  it('rolls back the whole mutation when the outbox write fails', async () => {
    const svc = service(sourceA);
    const created = await svc.createCorrective(tenantA, ADMIN, {
      vehicleId: 'synthetic-vehicle',
      description: 'Rollback',
    });
    await db.rows(
      `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` FROM '${db.runtimeUserA}'@'%'`,
    );
    try {
      await expect(
        svc.assign(tenantA, ADMIN, created.id, {
          version: 1,
          responsibleId: 'admin',
          workshopId: 'workshop-1',
          scheduledDate: '2026-10-12',
        }),
      ).rejects.toBeDefined();
    } finally {
      await db.rows(
        `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` TO '${db.runtimeUserA}'@'%'`,
      );
    }
    const stored = await new TypeOrmWorkOrderStore(sourceA).get(tenantA, created.id);
    expect(stored).toMatchObject({ status: 'scheduled', version: 1 });
    const audit = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${AUDIT_TABLES.local} WHERE tenant_id=? AND entity_id=?`,
      [tenantA, created.id],
    );
    expect(Number(audit[0]?.count)).toBe(1);
    const transitions = await db.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=?`,
      [tenantA, created.id],
    );
    expect(Number(transitions[0]?.count)).toBe(1);
  });

  it('advances the MNT-PLANS occurrence once through the closure event, even after reopen and re-close', async () => {
    const planId = randomUUID();
    await plansA.create(
      {
        tenantId: tenantA,
        id: planId,
        vehicleId: 'synthetic-vehicle',
        state: 'active',
        intervalDays: 30,
        lastServiceDate: '2026-09-01',
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      'synthetic-actor',
    );
    await plansA.scan(tenantA, planId, now, { km: 0, updatedAt: now.toISOString() });
    const [scheduled] = await plansA.listScheduledOrders(tenantA, planId);
    const svc = service(sourceA, plansA);
    const adopted = await svc.adoptPreventive(tenantA, ADMIN, {
      planId,
      scheduledOrderId: scheduled?.id,
    });
    expect(adopted).toMatchObject({
      id: scheduled?.id,
      kind: 'preventive',
      occurrenceId: scheduled?.occurrenceId,
    });
    const done = await toCompleted(svc, tenantA, adopted.id, adopted.version);
    const closed = await svc.close(tenantA, ADMIN, adopted.id, {
      version: done.version,
      vehicleStatus: 'active',
    });
    const reopened = await svc.reopen(tenantA, ADMIN, adopted.id, {
      version: closed.version,
      reason: 'Revisión sintética',
    });
    const recompleted = await svc.complete(tenantA, ADMIN, adopted.id, {
      version: reopened.version,
      actualDate: '2026-10-11',
      actualKm: 10400,
    });
    await svc.close(tenantA, ADMIN, adopted.id, {
      version: recompleted.version,
      vehicleStatus: 'active',
    });
    const closures = await db.rows<{ event_id: string; payload: Record<string, string | number> }>(
      `SELECT event_id, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND type='maintenance.order.preventive_closed' AND entity_id=?`,
      [tenantA, adopted.id],
    );
    expect(closures).toHaveLength(2);
    for (const closure of closures)
      await plansA.closePreventive({
        tenantId: tenantA,
        eventId: closure.event_id,
        planId: String(closure.payload['planId']),
        occurrenceId: String(closure.payload['occurrenceId']),
        orderId: String(closure.payload['orderId']),
        kind: 'preventive',
        completedAt: String(closure.payload['completedAt']),
        actualDate: String(closure.payload['actualDate']),
        actualKm: Number(closure.payload['actualKm']),
      });
    const plan = await plansA.get(tenantA, planId);
    expect(plan).toMatchObject({ version: 2, lastServiceDate: '2026-10-11', lastServiceKm: 10400 });
    expect((await plansA.listScheduledOrders(tenantA, planId)).map((o) => o.status)).toEqual([
      'completed',
    ]);
  });
});
