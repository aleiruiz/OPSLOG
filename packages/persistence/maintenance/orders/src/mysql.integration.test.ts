import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  permissions: ['view', 'create', 'edit', 'view_costs', 'incidents:approve', 'reopen'],
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
    timeZone: async () => 'UTC',
    fileRequirements: async () => ({ evidence: false, invoice: false }),
    fileRecord: async () => null,
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

  it('pages every order of the company by keyset for reports, past the 500 of the screen list', async () => {
    const store = new TypeOrmWorkOrderStore(sourceA);
    const ids = new Set<string>();
    let after: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page: readonly { id: string; createdAt: string; tenantId: string }[] =
        await store.reportPage(tenantA, after, 2);
      for (const order of page) {
        expect(order.tenantId).toBe(tenantA);
        expect(ids.has(order.id)).toBe(false);
        ids.add(order.id);
      }
      const last = page[page.length - 1];
      if (!last || page.length < 2) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    expect(ids.size).toBe((await store.list(tenantA)).length);
    expect(await store.reportPage(tenantB, null, 5)).toEqual([]);
  });

  it('reads closed-order facts for the dashboard by closure window, with exact money and an index', async () => {
    const svc = service(sourceA);
    const store = new TypeOrmWorkOrderStore(sourceA);
    const everything = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };
    const before = (await store.closedFacts(tenantA, everything)).length;
    const created = await svc.createCorrective(tenantA, ADMIN, {
      vehicleId: 'synthetic-vehicle',
      description: 'Lectura analítica',
    });
    const done = await toCompleted(svc, tenantA, created.id, created.version);
    const closed = await svc.close(tenantA, ADMIN, created.id, {
      version: done.version,
      vehicleStatus: 'active',
    });
    const at = new Date(closed.closedAt ?? '').getTime();
    const around = {
      from: new Date(at - 1000).toISOString(),
      to: new Date(at + 1000).toISOString(),
    };
    const facts = await store.closedFacts(tenantA, around);
    expect(facts).toHaveLength(before + 1);
    expect(facts[0]).toMatchObject({ vehicleId: 'synthetic-vehicle', kind: 'corrective' });
    expect(facts[0]?.costs[0]).toEqual({ amountMinor: '999999999999999', currency: 'MXN' });
    // Window end is exclusive; the start is inclusive.
    expect(
      await store.closedFacts(tenantA, { from: around.from, to: closed.closedAt ?? '' }),
    ).toEqual([]);
    expect(
      await store.closedFacts(tenantA, { from: closed.closedAt ?? '', to: around.to }),
    ).toHaveLength(before + 1);
    expect(await store.closedFacts(tenantB, around)).toEqual([]);
    const plan = await db.rows<{ possible_keys: string | null }>(
      `EXPLAIN SELECT id FROM ${WORK_ORDER_TABLES.orders} WHERE company_id=? AND status='closed' AND closed_at>=? AND closed_at<?`,
      [tenantA, new Date(at - 1000), new Date(at + 1000)],
    );
    expect(plan[0]?.possible_keys).toContain('ix_work_order_closure');
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
    const [reopenRow] = await db.rows<{ before_snapshot: { costs: unknown[]; tasks: unknown[] } }>(
      `SELECT before_snapshot FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? AND command='reopen'`,
      [tenantA, adopted.id],
    );
    expect(reopenRow?.before_snapshot.costs).toEqual(done.costs);
    expect(reopenRow?.before_snapshot.tasks).toEqual(done.tasks);
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

  describe('Idempotency-Key registry (G3 H2)', () => {
    const clock = { now: new Date('2026-10-12T12:00:00.000Z') };
    const ADMIN_2: WorkOrderActor = { ...ADMIN, id: 'user-admin2', subject: 'admin2' };
    const clocked = (source: DataSource) =>
      new WorkOrderService(new TypeOrmWorkOrderStore(source), refs(), { now: () => clock.now });
    let KEY = 'close-key-0001';
    // A key names one command of one order: every test works with its own.
    beforeEach(() => {
      KEY = `close-${randomUUID()}`;
    });
    const keyRows = (tenantId: string, orderId: string) =>
      db.rows<{ actor_id: string; command: string; status: string; response: { version: number } }>(
        `SELECT actor_id, command, status, response FROM ${WORK_ORDER_TABLES.idempotency} WHERE company_id=? AND order_id=?`,
        [tenantId, orderId],
      );
    async function ready(tenantId: string, source = sourceA, actor = ADMIN) {
      const svc = clocked(source);
      const created = await svc.createCorrective(tenantId, actor, {
        vehicleId: 'synthetic-vehicle',
        description: 'Idempotencia',
      });
      const done = await toCompleted(svc, tenantId, created.id, created.version);
      return { svc, id: created.id, done };
    }
    // `restricted`: other synthetic orders of the same vehicle are still open in the workshop.
    const closePayload = (version: number, extra: object = {}) => ({
      version,
      vehicleStatus: 'restricted',
      ...extra,
    });
    const outboxVersions = async (tenantId: string, orderId: string) =>
      (
        await db.rows<{ payload: { version: number } }>(
          `SELECT payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type='maintenance.status_changed'`,
          [tenantId, orderId],
        )
      )
        .map((row) => row.payload.version)
        .sort((a, b) => a - b);

    it('stores the key with the mutation, replays a stable result and rejects a different payload', async () => {
      const { svc, id, done } = await ready(tenantA);
      const first = await svc.execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY);
      const [row] = await keyRows(tenantA, id);
      expect(row).toMatchObject({ actor_id: ADMIN.id, command: 'close', status: 'completed' });
      expect(row?.response.version).toBe(first.version);
      // A new service instance (another node, after a restart) replays the same body.
      const again = await clocked(sourceA2).execute(
        tenantA,
        ADMIN,
        'close',
        id,
        closePayload(done.version),
        KEY,
      );
      expect(again).toEqual(first);
      await expect(
        svc.execute(
          tenantA,
          ADMIN,
          'close',
          id,
          closePayload(done.version, { comment: 'otro' }),
          KEY,
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      // The order moves on; the old key still replays and nothing is re-executed.
      const reopened = await svc.execute(
        tenantA,
        ADMIN,
        'reopen',
        id,
        { version: first.version, reason: 'Revisión' },
        'reopen-key-001',
      );
      expect(reopened.status).toBe('in_progress');
      expect(
        await svc.execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY),
      ).toEqual(first);
      expect((await new TypeOrmWorkOrderStore(sourceA).get(tenantA, id))?.status).toBe(
        'in_progress',
      );
      const commands = await db.rows<{ command: string }>(
        `SELECT command FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? AND command IN ('close','reopen')`,
        [tenantA, id],
      );
      expect(commands.map((c) => c.command)).toEqual(['close', 'reopen']);
      expect(await keyRows(tenantA, id)).toHaveLength(2);
    });

    it('yields exactly one effect, one audit row and one outbox row for concurrent duplicates', async () => {
      const { id, done } = await ready(tenantA);
      const nodes = [sourceA, sourceA2, sourceA, sourceA2, sourceA, sourceA2].map(clocked);
      const results = await Promise.allSettled(
        nodes.map((node) =>
          node.execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY),
        ),
      );
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      const versions = results.map((result) =>
        result.status === 'fulfilled' ? result.value.version : -1,
      );
      expect(new Set(versions)).toEqual(new Set([done.version + 1]));
      expect(await keyRows(tenantA, id)).toHaveLength(1);
      const closes = await db.rows<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? AND command='close'`,
        [tenantA, id],
      );
      expect(Number(closes[0]?.count)).toBe(1);
      const [audit] = await db.rows<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${AUDIT_TABLES.local} WHERE tenant_id=? AND entity_id=? AND action='maintenance.work_order.close'`,
        [tenantA, id],
      );
      expect(Number(audit?.count)).toBe(1);
      expect((await outboxVersions(tenantA, id)).filter((v) => v === done.version + 1)).toEqual([
        done.version + 1,
      ]);
    });

    it('lets concurrent commands that share a key but not a payload resolve to one winner and conflicts', async () => {
      const { id, done } = await ready(tenantA);
      const results = await Promise.allSettled([
        clocked(sourceA).execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY),
        clocked(sourceA2).execute(
          tenantA,
          ADMIN,
          'close',
          id,
          closePayload(done.version, { comment: 'otro' }),
          KEY,
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'idempotency_conflict' },
      });
      expect(await keyRows(tenantA, id)).toHaveLength(1);
    });

    it('treats an expired key as new and replaces the record in the same transaction', async () => {
      clock.now = new Date('2026-10-12T12:00:00.000Z');
      const { svc, id, done } = await ready(tenantA);
      const first = await svc.execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY);
      const reopened = await svc.reopen(tenantA, ADMIN, id, {
        version: first.version,
        reason: 'Revisión',
      });
      const recompleted = await svc.complete(tenantA, ADMIN, id, {
        version: reopened.version,
        actualDate: '2026-10-11',
        actualKm: 10500,
      });
      // Still within 24 h: the stored result is replayed although the order is open again.
      clock.now = new Date('2026-10-13T11:59:00.000Z');
      expect(
        (await svc.execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY)).version,
      ).toBe(first.version);
      clock.now = new Date('2026-10-13T12:00:01.000Z');
      const second = await svc.execute(
        tenantA,
        ADMIN,
        'close',
        id,
        closePayload(recompleted.version, { comment: 'segundo cierre' }),
        KEY,
      );
      expect(second.version).toBe(recompleted.version + 1);
      const rows = await keyRows(tenantA, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.response.version).toBe(second.version);
      clock.now = new Date('2026-10-12T12:00:00.000Z');
    });

    it('isolates keys per actor and per tenant database', async () => {
      const a = await ready(tenantA);
      const b = await ready(tenantB, sourceB);
      const other = await ready(tenantA, sourceA, ADMIN_2);
      // The same key text for another actor (own order), and for the same actor id in tenant B.
      const [forA, forB, forOther] = await Promise.all([
        a.svc.execute(tenantA, ADMIN, 'close', a.id, closePayload(a.done.version), KEY),
        b.svc.execute(tenantB, ADMIN, 'close', b.id, closePayload(b.done.version), KEY),
        other.svc.execute(
          tenantA,
          ADMIN_2,
          'close',
          other.id,
          closePayload(other.done.version),
          KEY,
        ),
      ]);
      expect(forA.id).not.toBe(forB.id);
      expect(forOther.id).not.toBe(forA.id);
      const store = (source: DataSource) => new TypeOrmWorkOrderStore(source);
      expect((await store(sourceA).idempotency(tenantA, ADMIN.id, 'close', KEY))?.orderId).toBe(
        a.id,
      );
      expect((await store(sourceA).idempotency(tenantA, ADMIN_2.id, 'close', KEY))?.orderId).toBe(
        other.id,
      );
      expect((await store(sourceB).idempotency(tenantB, ADMIN.id, 'close', KEY))?.orderId).toBe(
        b.id,
      );
      // Wrong tenant key or wrong database finds nothing.
      expect(await store(sourceA).idempotency(tenantB, ADMIN.id, 'close', KEY)).toBeNull();
      expect(await store(sourceB).idempotency(tenantA, ADMIN.id, 'close', KEY)).toBeNull();
      // Tenant A's key does not replay tenant B's order, nor the reverse.
      await expect(
        a.svc.execute(tenantA, ADMIN, 'close', b.id, closePayload(b.done.version), KEY),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(
        await db.rowsB(`SELECT 1 FROM ${WORK_ORDER_TABLES.idempotency} WHERE company_id=?`, [
          tenantA,
        ]),
      ).toHaveLength(0);
    });

    it('leaves no key behind when the mutation rolls back, so the retry runs', async () => {
      const { svc, id, done } = await ready(tenantA);
      await db.rows(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` FROM '${db.runtimeUserA}'@'%'`,
      );
      try {
        await expect(
          svc.execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY),
        ).rejects.toBeDefined();
      } finally {
        await db.rows(
          `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` TO '${db.runtimeUserA}'@'%'`,
        );
      }
      expect(await keyRows(tenantA, id)).toHaveLength(0);
      expect((await new TypeOrmWorkOrderStore(sourceA).get(tenantA, id))?.status).toBe('completed');
      const retried = await svc.execute(
        tenantA,
        ADMIN,
        'close',
        id,
        closePayload(done.version),
        KEY,
      );
      expect(retried.status).toBe('closed');
      expect(await keyRows(tenantA, id)).toHaveLength(1);
    });

    it('never lets the runtime account rewrite a recorded key', async () => {
      const { svc, id, done } = await ready(tenantA);
      await svc.execute(tenantA, ADMIN, 'close', id, closePayload(done.version), KEY);
      await expect(
        sourceA.query(`UPDATE ${WORK_ORDER_TABLES.idempotency} SET payload_hash = REPEAT('0', 64)`),
      ).rejects.toBeDefined();
    });
  });
});
