import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { MAINTENANCE_TABLES } from '../../../packages/persistence/maintenance/plans/src/index.js';
import { WORK_ORDER_TABLES } from '../../../packages/persistence/maintenance/orders/src/index.js';
import {
  transitionView,
  workOrderView,
  type WorkOrder,
  type WorkOrderService,
} from '../../../packages/domain/maintenance/orders/src/index.js';
import {
  ACTORS,
  VEHICLE,
  adminUrl,
  at,
  startMaintenanceWorld,
  type MaintenanceWorld,
} from './qa-world.js';

const suite = adminUrl ? describe : describe.skip;
const code = async (work: Promise<unknown>) =>
  work.then(
    () => 'ok',
    (error: { code?: string; missingRequirements?: string[] }) =>
      error.missingRequirements?.length
        ? `${error.code}:${error.missingRequirements.join(',')}`
        : String(error.code),
  );

// MNT-QA-M3-20261011 independent acceptance suite for work orders (FR-102–106, SPECS §6.1, D9,
// D11, D14, D20) on real MySQL 8.4 with synthetic tenants A and B.
suite('work order acceptance on MySQL 8.4', () => {
  let world: MaintenanceWorld;
  beforeAll(async () => {
    world = await startMaintenanceWorld('qa_orders');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  }, 60_000);

  async function completed(
    service: WorkOrderService,
    amountMinor = '1000',
    description = 'Orden sintética',
  ): Promise<WorkOrder> {
    const t = world.tenantA;
    let order = await service.createCorrective(t, ACTORS.editor, {
      vehicleId: VEHICLE,
      description,
    });
    order = await service.assign(t, ACTORS.editor, order.id, {
      version: order.version,
      responsibleId: 'editor',
      workshopId: 'workshop-1',
      mechanicId: 'mechanic-a',
      scheduledDate: '2026-10-12',
    });
    order = await service.start(t, ACTORS.mechanic, order.id, { version: order.version });
    order = await service.updateWork(t, ACTORS.mechanic, order.id, {
      version: order.version,
      tasks: [{ description: 'Diagnóstico y reparación' }],
      parts: [{ name: 'Balata', quantity: '2' }],
    });
    order = await service.updateCosts(t, ACTORS.admin, order.id, {
      version: order.version,
      costs: [{ category: 'labor', amount: { amountMinor, currency: 'MXN' } }],
    });
    return service.complete(t, ACTORS.mechanic, order.id, {
      version: order.version,
      actualDate: '2026-10-12',
      actualKm: 1200,
    });
  }

  it('enforces the §6.1 table, required data, cancel reason and immutable closed records with full history and audit', async () => {
    const service = world.service();
    const t = world.tenantA;
    const order = await service.createCorrective(t, ACTORS.editor, {
      vehicleId: VEHICLE,
      description: 'Tabla de transiciones',
    });
    expect(await code(service.start(t, ACTORS.editor, order.id, { version: 1 }))).toBe(
      'invalid_transition',
    );
    expect(
      await code(service.close(t, ACTORS.admin, order.id, { version: 1, vehicleStatus: 'active' })),
    ).toBe('invalid_transition');
    expect(await code(service.assign(t, ACTORS.editor, order.id, { version: 1 }))).toBe(
      'missing_requirements:responsibleId,scheduledDate,workshopOrMechanic',
    );
    expect(await code(service.cancel(t, ACTORS.editor, order.id, { version: 1 }))).toBe(
      'missing_requirements:reason',
    );
    const done = await completed(service);
    expect(
      await code(service.cancel(t, ACTORS.editor, done.id, { version: done.version, reason: 'x' })),
    ).toBe('invalid_transition');
    const closed = await service.close(t, ACTORS.admin, done.id, {
      version: done.version,
      vehicleStatus: 'active',
    });
    expect(
      await code(
        service.updateWork(t, ACTORS.admin, done.id, { version: closed.version, tasks: [] }),
      ),
    ).toBe('invalid_transition');
    expect(
      await code(
        service.updateCosts(t, ACTORS.admin, done.id, { version: closed.version, costs: [] }),
      ),
    ).toBe('invalid_transition');
    const history = await world.db.rows<{ command: string }>(
      `SELECT command FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? ORDER BY sequence`,
      [t, done.id],
    );
    expect(history.map((h) => h.command)).toEqual([
      'create',
      'assign',
      'start',
      'complete',
      'close',
    ]);
    const [audit] = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${AUDIT_TABLES.local} WHERE tenant_id=? AND entity_id=?`,
      [t, done.id],
    );
    expect(Number(audit?.total)).toBe(closed.version);
  });

  it('lets exactly one of two concurrent closes win, and reopen with permission and reason never duplicates the next occurrence', async () => {
    const t = world.tenantA;
    const plan = await world.plan(world.plansA, t, {
      intervalDays: 30,
      lastServiceDate: '2026-09-01',
    });
    await world.plansA.scan(t, plan.id, at('2026-10-12T00:00:00Z'), {
      km: 0,
      updatedAt: '2026-10-12T00:00:00Z',
    });
    const [scheduled] = await world.plansA.listScheduledOrders(t, plan.id);
    const service = world.service();
    let order = await service.adoptPreventive(t, ACTORS.editor, {
      planId: plan.id,
      scheduledOrderId: scheduled?.id,
    });
    order = await service.assign(t, ACTORS.editor, order.id, {
      version: order.version,
      responsibleId: 'editor',
      mechanicId: 'mechanic-a',
      scheduledDate: '2026-10-12',
    });
    order = await service.start(t, ACTORS.mechanic, order.id, { version: order.version });
    order = await service.updateWork(t, ACTORS.mechanic, order.id, {
      version: order.version,
      tasks: [{ description: 'Servicio' }],
    });
    order = await service.complete(t, ACTORS.mechanic, order.id, {
      version: order.version,
      actualDate: '2026-10-11',
      actualKm: 900,
    });
    const results = await Promise.allSettled([
      world
        .service({ side: 'a' })
        .close(t, ACTORS.admin, order.id, { version: order.version, vehicleStatus: 'active' }),
      world
        .service({ side: 'a2' })
        .close(t, ACTORS.admin, order.id, { version: order.version, vehicleStatus: 'restricted' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'stale_version' },
    });
    const closed = (await service.get(t, ACTORS.admin, order.id)) as WorkOrder;
    expect(
      await code(
        service.reopen(t, ACTORS.editor, order.id, { version: closed.version, reason: 'x' }),
      ),
    ).toBe('forbidden');
    expect(await code(service.reopen(t, ACTORS.admin, order.id, { version: closed.version }))).toBe(
      'missing_requirements:reason',
    );
    const reopened = await service.reopen(t, ACTORS.admin, order.id, {
      version: closed.version,
      reason: 'Corrección de factura',
    });
    // M1: the corrected re-close (earlier date, lower km than the first closure) is accepted.
    const again = await service.complete(t, ACTORS.admin, order.id, {
      version: reopened.version,
      actualDate: '2026-10-10',
      actualKm: 800,
    });
    await service.close(t, ACTORS.admin, order.id, {
      version: again.version,
      vehicleStatus: 'active',
    });
    const events = await world.db.rows<{
      event_id: string;
      type: string;
      payload: Record<string, string | number>;
    }>(
      `SELECT event_id, type, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND type IN ('maintenance.order.preventive_closed','maintenance.order.preventive_reopened') AND entity_id=? ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.version')) AS UNSIGNED)`,
      [t, order.id],
    );
    expect(events.map((e) => e.type.split('_').pop())).toEqual(['closed', 'reopened', 'closed']);
    for (const event of [...events, ...events]) {
      const p = event.payload;
      const base = {
        tenantId: t,
        eventId: event.event_id,
        planId: String(p['planId']),
        occurrenceId: String(p['occurrenceId']),
        orderId: String(p['orderId']),
        version: Number(p['version']),
      };
      if (event.type.endsWith('_reopened')) await world.plansA.reopenPreventive(base);
      else
        await world.plansA.closePreventive({
          ...base,
          kind: 'preventive',
          completedAt: String(p['completedAt']),
          actualDate: String(p['actualDate']),
          actualKm: Number(p['actualKm']),
        });
    }
    // closure (v2) -> reopen restores the baseline (v3) -> corrected re-close (v4), applied once.
    expect(await world.plansA.get(t, plan.id)).toMatchObject({
      version: 4,
      lastServiceDate: '2026-10-10',
      lastServiceKm: 800,
    });
    await world.plansA.scan(t, plan.id, at('2026-11-10T00:00:00Z'), {
      km: 800,
      updatedAt: '2026-11-10T00:00:00Z',
    });
    await world.plansA.scan(t, plan.id, at('2026-11-10T01:00:00Z'), {
      km: 800,
      updatedAt: '2026-11-10T01:00:00Z',
    });
    const occurrences = await world.db.rows<{ sequence: number; target_date: string }>(
      `SELECT sequence, target_date FROM ${MAINTENANCE_TABLES.occurrences} WHERE company_id=? AND plan_id=? ORDER BY sequence`,
      [t, plan.id],
    );
    // The next target moved from 2026-11-10 (first closure) to 2026-11-09 (corrected closure).
    expect(occurrences.map((o) => [o.sequence, o.target_date])).toEqual([
      [1, '2026-10-01'],
      [2, '2026-11-09'],
    ]);
  });

  it('D20: when configured every close needs a prior approval regardless of cost; without it a high cost closes', async () => {
    const t = world.tenantA;
    const reviewed = world.service({ approval: true });
    for (const amountMinor of ['100', '999999999999']) {
      const order = await completed(reviewed, amountMinor, `D20 ${amountMinor}`);
      expect(
        await code(
          reviewed.close(t, ACTORS.admin, order.id, {
            version: order.version,
            vehicleStatus: 'active',
          }),
        ),
      ).toBe('missing_requirements:closeApproval');
      expect(
        await code(reviewed.approveClose(t, ACTORS.editor, order.id, { version: order.version })),
      ).toBe('forbidden');
      const approved = await reviewed.approveClose(t, ACTORS.supervisor, order.id, {
        version: order.version,
      });
      expect(
        (
          await reviewed.close(t, ACTORS.admin, order.id, {
            version: approved.version,
            vehicleStatus: 'active',
          })
        ).status,
      ).toBe('closed');
    }
    const plain = world.service();
    const costly = await completed(plain, '999999999999', 'Sin umbral');
    expect(
      await code(plain.approveClose(t, ACTORS.supervisor, costly.id, { version: costly.version })),
    ).toBe('invalid_transition');
    expect(
      (
        await plain.close(t, ACTORS.admin, costly.id, {
          version: costly.version,
          vehicleStatus: 'active',
        })
      ).status,
    ).toBe('closed');
  });

  it('D11/§5.3: two open workshop episodes coexist; closing one cannot return the vehicle to active', async () => {
    const t = world.tenantA;
    const service = world.service();
    const first = await completed(service, '1000', 'Bloqueo 1');
    const second = await completed(service, '1000', 'Bloqueo 2');
    expect(first.requiresWorkshop && second.requiresWorkshop).toBe(true);
    expect(workOrderView(first, false).vehicleProposal).toBeNull();
    expect(
      await code(
        service.close(t, ACTORS.admin, first.id, {
          version: first.version,
          vehicleStatus: 'active',
        }),
      ),
    ).toBe('missing_requirements:noOtherOpenWorkshopOrders');
    const kept = await service.close(t, ACTORS.admin, first.id, {
      version: first.version,
      vehicleStatus: 'in_maintenance',
    });
    expect(kept.vehicleStatusDecision).toBe('in_maintenance');
    expect(
      (
        await service.close(t, ACTORS.admin, second.id, {
          version: second.version,
          vehicleStatus: 'active',
        })
      ).vehicleStatusDecision,
    ).toBe('active');
  });

  it('costs: exact amounts with view_costs, none in reads, history or errors without it', async () => {
    const t = world.tenantA;
    const service = world.service();
    const order = await completed(service, '999999999999999', 'Costos');
    const stored = (await service.get(t, ACTORS.editor, order.id)) as WorkOrder;
    expect(workOrderView(stored, true).costs?.[0]?.amount).toEqual({
      amountMinor: '999999999999999',
      currency: 'MXN',
    });
    const hidden = JSON.stringify([
      workOrderView(stored, false),
      ...(await service.list(t, ACTORS.editor)).map((o) => workOrderView(o, false)),
    ]);
    expect(hidden).not.toMatch(/999999999999999|"costs"|unitCost|MXN/);
    // The timeline keeps the facts before each command (before_snapshot), amounts included.
    const closed = await service.close(t, ACTORS.admin, order.id, {
      version: order.version,
      vehicleStatus: 'active',
    });
    await service.reopen(t, ACTORS.admin, order.id, {
      version: closed.version,
      reason: 'Revisión de costos',
    });
    const history = await service.history(t, ACTORS.editor, order.id);
    const reopen = history.find((entry) => entry.command === 'reopen');
    expect(reopen?.before?.['costs']).toEqual(stored.costs);
    expect(JSON.stringify(history.map((entry) => transitionView(entry, false)))).not.toMatch(
      /999999999999999|"costs"|unitCost|MXN/,
    );
    expect(transitionView(reopen as NonNullable<typeof reopen>, true).before?.['costs']).toEqual(
      stored.costs,
    );
    const [row] = await world.db.rows<{ before_snapshot: { costs: unknown[] } }>(
      `SELECT before_snapshot FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? AND command='reopen'`,
      [t, order.id],
    );
    expect(row?.before_snapshot.costs).toEqual(stored.costs);
    const current = (await service.get(t, ACTORS.editor, order.id)) as WorkOrder;
    expect(
      await code(
        service.updateCosts(t, ACTORS.editor, order.id, { version: current.version, costs: [] }),
      ),
    ).toBe('forbidden');
  });

  it('D9 and tenant isolation: assigned mechanic only, foreign equals unknown, actor from context, no cross-tenant association', async () => {
    const service = world.service();
    const order = await completed(service, '1000', 'Aislamiento');
    const other = {
      ...ACTORS.mechanic,
      id: 'user-other',
      subject: 'other',
      mechanicIds: ['mechanic-z'],
    };
    expect(await code(service.get(world.tenantA, other, order.id))).toBe('not_found');
    expect(await code(service.get(world.tenantB, ACTORS.admin, order.id))).toBe(
      await code(service.get(world.tenantA, ACTORS.admin, 'unknown-order')),
    );
    const serviceB = world.service({ side: 'b' });
    expect(await code(serviceB.get(world.tenantB, ACTORS.admin, order.id))).toBe('not_found');
    const orderB = await serviceB.createCorrective(world.tenantB, ACTORS.editor, {
      vehicleId: VEHICLE,
      description: 'Orden B',
    });
    expect(
      await code(
        serviceB.assign(world.tenantB, ACTORS.editor, orderB.id, {
          version: 1,
          responsibleId: 'editor',
          mechanicId: 'mechanic-a',
          scheduledDate: '2026-10-12',
        }),
      ),
    ).toBe('invalid_association');
    expect(orderB.createdBy).toBe('user-editor');
    const [leak] = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${WORK_ORDER_TABLES.orders} WHERE id=?`,
      [orderB.id],
    );
    expect(Number(leak?.total)).toBe(0);
    expect(
      (await service.list(world.tenantA, ACTORS.mechanic)).every(
        (o) => o.mechanicId === 'mechanic-a',
      ),
    ).toBe(true);
  });

  it('rolls back business row, history and audit when the outbox write fails, emitting nothing', async () => {
    const t = world.tenantA;
    const service = world.service();
    const order = await service.createCorrective(t, ACTORS.editor, {
      vehicleId: VEHICLE,
      description: 'Rollback QA',
    });
    const user = world.db.runtimeUserA;
    await world.db.rows(
      `REVOKE EXECUTE ON PROCEDURE \`${world.db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` FROM '${user}'@'%'`,
    );
    try {
      expect(
        await code(
          service.cancel(t, ACTORS.editor, order.id, { version: 1, reason: 'Falla inyectada' }),
        ),
      ).not.toBe('ok');
    } finally {
      await world.db.rows(
        `GRANT EXECUTE ON PROCEDURE \`${world.db.databaseName}\`.\`opslog_enqueue_tenant_outbox\` TO '${user}'@'%'`,
      );
    }
    expect(await service.get(t, ACTORS.editor, order.id)).toMatchObject({
      status: 'scheduled',
      version: 1,
    });
    const [events] = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=?`,
      [t, order.id],
    );
    const [audit] = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${AUDIT_TABLES.local} WHERE tenant_id=? AND entity_id=?`,
      [t, order.id],
    );
    expect([Number(events?.total), Number(audit?.total)]).toEqual([1, 1]);
  });

  it('D14: starting work never requires a budget approval', async () => {
    const t = world.tenantA;
    const service = world.service({ approval: true });
    let order = await service.createCorrective(t, ACTORS.editor, {
      vehicleId: VEHICLE,
      description: 'Sin presupuesto previo',
    });
    order = await service.assign(t, ACTORS.editor, order.id, {
      version: 1,
      responsibleId: 'editor',
      workshopId: 'workshop-1',
      scheduledDate: '2026-10-12',
    });
    order = await service.updateCosts(t, ACTORS.admin, order.id, {
      version: order.version,
      costs: [
        { category: 'external_service', amount: { amountMinor: '999999999999', currency: 'MXN' } },
      ],
    });
    expect(
      (await service.start(t, ACTORS.editor, order.id, { version: order.version })).status,
    ).toBe('in_progress');
  });
});
