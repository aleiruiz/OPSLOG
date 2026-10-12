import { describe, expect, it } from 'vitest';
import { WorkOrderError } from './errors.js';
import { validateWorkOrderEvent } from './events.js';
import { transitionView, workOrderView } from './views.js';
import { TRANSITIONS, isMechanicScoped } from './workflow.js';
import {
  ADMIN,
  EDITOR,
  FLEET,
  MECHANIC,
  OTHER_MECHANIC,
  TENANT,
  VIEWER,
  harness,
} from './test-support.js';
import { WORK_ORDER_STATUSES, type WorkOrder, type WorkOrderCommand } from './types.js';

const code = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof WorkOrderError)
      return error.missingRequirements.length
        ? `${error.code}:${error.missingRequirements.join(',')}`
        : error.code;
    throw error;
  }
  return 'ok';
};

async function assigned(h = harness(), mechanicId = 'mechanic-1') {
  const order = await h.service.createCorrective(TENANT, FLEET, {
    vehicleId: 'vehicle-1',
    description: 'Frenos',
  });
  const next = await h.service.assign(TENANT, FLEET, order.id, {
    version: 1,
    responsibleId: 'fleet',
    workshopId: 'workshop-1',
    mechanicId,
    scheduledDate: '2026-10-13',
  });
  return { h, order: next };
}

async function completed() {
  const { h, order } = await assigned();
  const started = await h.service.start(TENANT, MECHANIC, order.id, { version: 2 });
  const worked = await h.service.updateWork(TENANT, MECHANIC, order.id, {
    version: started.version,
    tasks: [{ description: 'Cambio de balatas' }],
    parts: [{ name: 'Balata', quantity: '2' }],
  });
  const done = await h.service.complete(TENANT, MECHANIC, order.id, {
    version: worked.version,
    actualDate: '2026-10-12',
    actualKm: 1500,
  });
  return { h, order: done };
}

describe('work order workflow', () => {
  it('creates corrective orders with an audit entry and an allowlisted created event', async () => {
    const h = harness();
    const order = await h.service.createCorrective(TENANT, FLEET, {
      vehicleId: 'vehicle-1',
      description: ' Ruido en suspensión ',
    });
    expect(order).toMatchObject({ status: 'scheduled', kind: 'corrective', version: 1 });
    expect(order.description).toBe('Ruido en suspensión');
    expect(h.store.audit).toEqual([{ tenantId: TENANT, action: 'maintenance.work_order.created' }]);
    expect(h.store.events[0]?.event.payload).toEqual({
      orderId: order.id,
      vehicleId: 'vehicle-1',
      version: 1,
    });
    expect(await h.service.history(TENANT, FLEET, order.id)).toMatchObject([
      { command: 'create', from: null, to: 'scheduled', before: null },
    ]);
    expect(await code(h.service.createCorrective(TENANT, VIEWER, {}))).toBe('forbidden');
    expect(await code(h.service.createCorrective(TENANT, FLEET, { vehicleId: 'x' }))).toBe(
      'invalid_input',
    );
    expect(
      await code(
        h.service.createCorrective(TENANT, FLEET, { vehicleId: 'vehicle-9', description: 'x' }),
      ),
    ).toBe('not_found');
    expect(
      await code(
        h.service.createCorrective('tenant-b', FLEET, { vehicleId: 'vehicle-1', description: 'x' }),
      ),
    ).toBe('not_found');
  });

  it('adopts a scheduled MNT-PLANS order once, keeping its identity and default assignment', async () => {
    const h = harness();
    h.refs.scheduled.push(
      {
        id: 'sched-1',
        occurrenceId: 'occ-1',
        planId: 'plan-1',
        vehicleId: 'vehicle-1',
        status: 'scheduled',
        workshopId: 'workshop-1',
        mechanicId: 'mechanic-1',
      },
      {
        id: 'sched-2',
        occurrenceId: 'occ-2',
        planId: 'plan-1',
        vehicleId: 'vehicle-1',
        status: 'completed',
        workshopId: null,
        mechanicId: null,
      },
    );
    const order = await h.service.adoptPreventive(TENANT, FLEET, {
      planId: 'plan-1',
      scheduledOrderId: 'sched-1',
    });
    expect(order).toMatchObject({
      id: 'sched-1',
      kind: 'preventive',
      planId: 'plan-1',
      occurrenceId: 'occ-1',
      mechanicId: 'mechanic-1',
    });
    expect(
      await code(
        h.service.adoptPreventive(TENANT, FLEET, { planId: 'plan-1', scheduledOrderId: 'sched-1' }),
      ),
    ).toBe('duplicate');
    expect(
      await code(
        h.service.adoptPreventive(TENANT, FLEET, { planId: 'plan-1', scheduledOrderId: 'sched-2' }),
      ),
    ).toBe('invalid_transition');
    expect(
      await code(
        h.service.adoptPreventive(TENANT, FLEET, { planId: 'plan-1', scheduledOrderId: 'nope' }),
      ),
    ).toBe('not_found');
    expect(
      await code(
        h.service.adoptPreventive('tenant-b', FLEET, {
          planId: 'plan-1',
          scheduledOrderId: 'sched-1',
        }),
      ),
    ).toBe('not_found');
    expect(await code(h.service.adoptPreventive(TENANT, EDITOR, { planId: 'plan-1' }))).toBe(
      'invalid_input',
    );
    expect(await code(h.service.adoptPreventive(TENANT, VIEWER, {}))).toBe('forbidden');
  });

  it('accepts only the SPECS §6.1 transitions and reports structured missing requirements', async () => {
    const h = harness();
    const order = await h.service.createCorrective(TENANT, FLEET, {
      vehicleId: 'vehicle-1',
      description: 'x',
    });
    expect(await code(h.service.assign(TENANT, FLEET, order.id, { version: 1 }))).toBe(
      'missing_requirements:responsibleId,scheduledDate,workshopOrMechanic',
    );
    expect(await code(h.service.start(TENANT, FLEET, order.id, { version: 1 }))).toBe(
      'invalid_transition',
    );
    expect(await code(h.service.assign(TENANT, FLEET, order.id, { responsibleId: 'fleet' }))).toBe(
      'invalid_input',
    );
    expect(
      await code(
        h.service.assign(TENANT, FLEET, order.id, {
          version: 1,
          responsibleId: 'ghost',
          mechanicId: 'mechanic-1',
          scheduledDate: '2026-10-13',
        }),
      ),
    ).toBe('invalid_association');
    expect(
      await code(
        h.service.assign(TENANT, FLEET, order.id, {
          version: 1,
          responsibleId: 'fleet',
          workshopId: 'workshop-off',
          scheduledDate: '2026-10-13',
        }),
      ),
    ).toBe('invalid_association');
    expect(
      await code(
        h.service.assign(TENANT, FLEET, order.id, {
          version: 1,
          responsibleId: 'fleet',
          workshopId: 'workshop-1',
          mechanicId: 'mechanic-2',
          scheduledDate: '2026-10-13',
        }),
      ),
    ).toBe('invalid_association');
    expect(
      await code(
        h.service.assign(TENANT, FLEET, order.id, {
          version: 1,
          responsibleId: 'fleet',
          mechanicId: 'missing',
          scheduledDate: '2026-10-13',
        }),
      ),
    ).toBe('invalid_association');
    expect(
      await code(
        h.service.assign(TENANT, FLEET, order.id, {
          version: 1,
          responsibleId: 'fleet',
          workshopId: 'workshop-1',
          scheduledDate: '2026-02-31',
        }),
      ),
    ).toBe('invalid_input');
    const ok = await h.service.assign(TENANT, FLEET, order.id, {
      version: 1,
      responsibleId: 'fleet',
      workshopId: 'workshop-1',
      scheduledDate: '2026-10-13',
    });
    expect(ok).toMatchObject({ status: 'assigned', version: 2, mechanicId: null });
    expect(
      await code(
        h.service.assign(TENANT, FLEET, order.id, {
          version: 2,
          responsibleId: 'fleet',
          workshopId: 'workshop-1',
          scheduledDate: '2026-10-13',
        }),
      ),
    ).toBe('invalid_transition');
    expect(await code(h.service.start(TENANT, FLEET, order.id, { version: 1 }))).toBe(
      'stale_version',
    );
    expect(
      await code(h.service.start(TENANT, FLEET, order.id, { version: 2, requiresWorkshop: 'yes' })),
    ).toBe('invalid_input');
  });

  it('declares every command against every status in the transition table', () => {
    const sources = Object.fromEntries(
      (Object.keys(TRANSITIONS) as WorkOrderCommand[]).map((command) => [
        command,
        TRANSITIONS[command].from,
      ]),
    );
    expect(sources).toEqual({
      assign: ['scheduled'],
      start: ['assigned'],
      complete: ['in_progress'],
      approve_close: ['completed'],
      close: ['completed'],
      cancel: ['scheduled', 'assigned', 'in_progress'],
      reopen: ['closed'],
    });
    expect(WORK_ORDER_STATUSES).toHaveLength(6);
  });

  it('lets only the assigned mechanic act on and see their order', async () => {
    const { h, order } = await assigned();
    expect(await code(h.service.get(TENANT, OTHER_MECHANIC, order.id))).toBe('not_found');
    expect(await code(h.service.start(TENANT, OTHER_MECHANIC, order.id, { version: 2 }))).toBe(
      'not_found',
    );
    expect(await h.service.list(TENANT, OTHER_MECHANIC)).toEqual([]);
    expect((await h.service.list(TENANT, MECHANIC)).map((o) => o.id)).toEqual([order.id]);
    expect(await code(h.service.start(TENANT, VIEWER, order.id, { version: 2 }))).toBe('forbidden');
    expect(
      await code(h.service.cancel(TENANT, MECHANIC, order.id, { version: 2, reason: 'x' })),
    ).toBe('forbidden');
    expect(await code(h.service.updateWork(TENANT, MECHANIC, order.id, { version: 2 }))).toBe(
      'forbidden',
    );
    const started = await h.service.start(TENANT, MECHANIC, order.id, { version: 2 });
    expect(started).toMatchObject({
      status: 'in_progress',
      requiresWorkshop: true,
      startedAt: '2026-10-12T12:00:00.000Z',
    });
    expect(workOrderView(started, false).vehicleProposal).toEqual({
      suggestedStatus: 'in_maintenance',
      eligibilityBlocked: true,
    });
    expect(await code(h.service.updateCosts(TENANT, MECHANIC, order.id, { version: 3 }))).toBe(
      'forbidden',
    );
    expect(await code(h.service.list(TENANT, { ...VIEWER, permissions: [] }))).toBe('forbidden');
    expect(await code(h.service.get(TENANT, { ...VIEWER, permissions: [] }, order.id))).toBe(
      'not_found',
    );
  });

  it('completes with real facts and validates the preventive baseline', async () => {
    const { h, order } = await assigned();
    const started = await h.service.start(TENANT, FLEET, order.id, {
      version: 2,
      requiresWorkshop: false,
    });
    expect(await code(h.service.complete(TENANT, FLEET, order.id, { version: 3 }))).toBe(
      'missing_requirements:actualDate,actualKm,tasks',
    );
    const worked = await h.service.updateWork(TENANT, FLEET, order.id, {
      version: started.version,
      description: 'Revisión',
      tasks: [{ description: 'Ajuste' }],
    });
    expect(
      await code(
        h.service.complete(TENANT, FLEET, order.id, {
          version: worked.version,
          actualDate: '2026-10-13',
          actualKm: 10,
        }),
      ),
    ).toBe('invalid_input');
    const preventive = harness();
    preventive.refs.scheduled.push({
      id: 'sched-1',
      occurrenceId: 'occ-1',
      planId: 'plan-1',
      vehicleId: 'vehicle-1',
      status: 'scheduled',
      workshopId: null,
      mechanicId: 'mechanic-1',
    });
    await preventive.service.adoptPreventive(TENANT, FLEET, {
      planId: 'plan-1',
      scheduledOrderId: 'sched-1',
    });
    await preventive.service.assign(TENANT, FLEET, 'sched-1', {
      version: 1,
      responsibleId: 'fleet',
      scheduledDate: '2026-10-12',
    });
    await preventive.service.start(TENANT, FLEET, 'sched-1', { version: 2 });
    await preventive.service.updateWork(TENANT, FLEET, 'sched-1', {
      version: 3,
      tasks: [{ description: 'Servicio' }],
    });
    expect(
      await code(
        preventive.service.complete(TENANT, FLEET, 'sched-1', {
          version: 4,
          actualDate: '2026-08-31',
          actualKm: 2000,
        }),
      ),
    ).toBe('invalid_input');
    expect(
      await code(
        preventive.service.complete(TENANT, FLEET, 'sched-1', {
          version: 4,
          actualDate: '2026-10-01',
          actualKm: 999,
        }),
      ),
    ).toBe('invalid_input');
    preventive.refs.planBaseline = async () => null;
    expect(
      await code(
        preventive.service.complete(TENANT, FLEET, 'sched-1', {
          version: 4,
          actualDate: '2026-10-01',
          actualKm: 1200,
        }),
      ),
    ).toBe('not_found');
  });

  it('hides every amount without view_costs and keeps unit costs across work edits', async () => {
    const { h, order } = await assigned();
    const started = await h.service.start(TENANT, FLEET, order.id, { version: 2 });
    const worked = await h.service.updateWork(TENANT, FLEET, order.id, {
      version: started.version,
      parts: [{ name: 'Filtro', quantity: '1.5' }],
    });
    const partId = worked.parts[0]?.id as string;
    const costed = await h.service.updateCosts(TENANT, FLEET, order.id, {
      version: worked.version,
      costs: [{ category: 'labor', amount: { amountMinor: '125000', currency: 'MXN' } }],
      partCosts: [{ partId, unitCost: { amountMinor: '45050', currency: 'MXN' } }],
    });
    const rewritten = await h.service.updateWork(TENANT, MECHANIC, order.id, {
      version: costed.version,
      parts: [{ id: partId, name: 'Filtro de aceite', quantity: '2' }],
    });
    expect(rewritten.parts[0]?.unitCost).toEqual({ amountMinor: '45050', currency: 'MXN' });
    const hidden = workOrderView(rewritten, false);
    expect(hidden).not.toHaveProperty('costs');
    expect(hidden).not.toHaveProperty('tenantId');
    expect(JSON.stringify(hidden)).not.toMatch(/45050|125000|MXN/);
    expect(workOrderView(rewritten, true).costs?.[0]?.amount.amountMinor).toBe('125000');
    expect(
      await code(
        h.service.updateCosts(TENANT, FLEET, order.id, {
          version: rewritten.version,
          partCosts: [{ partId: 'ghost', unitCost: null }],
        }),
      ),
    ).toBe('invalid_input');
    expect(
      await code(
        h.service.updateCosts(TENANT, FLEET, order.id, {
          version: rewritten.version,
          costs: [{ category: 'labor', amount: { amountMinor: '1.5', currency: 'MXN' } }],
        }),
      ),
    ).toBe('invalid_input');
    expect(
      await code(
        h.service.updateCosts(TENANT, FLEET, order.id, {
          version: rewritten.version,
          costs: [{ category: 'tips', amount: { amountMinor: '1', currency: 'MXN' } }],
        }),
      ),
    ).toBe('invalid_input');
    expect(
      await code(
        h.service.updateWork(TENANT, FLEET, order.id, {
          version: rewritten.version,
          tasks: [{ id: 'ghost', description: 'x' }],
        }),
      ),
    ).toBe('invalid_input');
    expect(
      await code(
        h.service.updateWork(TENANT, FLEET, order.id, {
          version: rewritten.version,
          parts: [{ name: 'x', quantity: '0' }],
        }),
      ),
    ).toBe('invalid_input');
    expect(
      await code(h.service.updateWork(TENANT, FLEET, order.id, { version: 1, tasks: [] })),
    ).toBe('stale_version');
    const cleared = await h.service.updateCosts(TENANT, FLEET, order.id, {
      version: rewritten.version,
      partCosts: [{ partId, unitCost: null }],
    });
    expect(cleared.parts[0]?.unitCost).toBeNull();
  });

  it('requires the D20 supervisor approval only when the tenant configured it', async () => {
    const { h, order } = await completed();
    expect(
      await code(h.service.approveClose(TENANT, ADMIN, order.id, { version: order.version })),
    ).toBe('invalid_transition');
    h.refs.approval = true;
    expect(
      await code(
        h.service.close(TENANT, ADMIN, order.id, {
          version: order.version,
          vehicleStatus: 'active',
        }),
      ),
    ).toBe('missing_requirements:closeApproval');
    expect(
      await code(h.service.approveClose(TENANT, FLEET, order.id, { version: order.version })),
    ).toBe('forbidden');
    // SPECS:79: only `incidents:approve` approves; the generic `approve` grant does not (G3 M5).
    const genericApprover = { ...ADMIN, permissions: ['view', 'edit', 'view_costs', 'approve'] };
    expect(
      await code(
        h.service.approveClose(TENANT, genericApprover, order.id, { version: order.version }),
      ),
    ).toBe('forbidden');
    const approved = await h.service.approveClose(TENANT, ADMIN, order.id, {
      version: order.version,
    });
    expect(approved.closeApproval).toEqual({
      approvedBy: 'user-admin',
      approvedAt: '2026-10-12T12:00:00.000Z',
    });
    expect(
      await code(h.service.approveClose(TENANT, ADMIN, order.id, { version: approved.version })),
    ).toBe('duplicate');
    expect(
      await code(
        h.service.close(TENANT, EDITOR, order.id, {
          version: approved.version,
          vehicleStatus: 'active',
        }),
      ),
    ).toBe('forbidden');
    expect(
      await code(h.service.close(TENANT, ADMIN, order.id, { version: approved.version })),
    ).toBe('missing_requirements:vehicleStatus');
    expect(
      await code(
        h.service.close(TENANT, ADMIN, order.id, {
          version: approved.version,
          vehicleStatus: 'decommissioned',
        }),
      ),
    ).toBe('invalid_input');
    const closed = await h.service.close(TENANT, ADMIN, order.id, {
      version: approved.version,
      vehicleStatus: 'active',
      comment: 'Listo',
    });
    expect(closed).toMatchObject({
      status: 'closed',
      closedBy: 'user-admin',
      vehicleStatusDecision: 'active',
    });
    expect(
      await code(
        h.service.updateWork(TENANT, ADMIN, order.id, { version: closed.version, tasks: [] }),
      ),
    ).toBe('invalid_transition');
  });

  it('never returns the vehicle to active while another workshop order is open', async () => {
    const { h, order } = await completed();
    const other = await assigned(h);
    await h.service.start(TENANT, FLEET, other.order.id, { version: 2, requiresWorkshop: true });
    expect(
      await code(
        h.service.close(TENANT, ADMIN, order.id, {
          version: order.version,
          vehicleStatus: 'active',
        }),
      ),
    ).toBe('missing_requirements:noOtherOpenWorkshopOrders');
    const closed = await h.service.close(TENANT, ADMIN, order.id, {
      version: order.version,
      vehicleStatus: 'in_maintenance',
    });
    expect(closed.vehicleStatusDecision).toBe('in_maintenance');
  });

  it('emits the preventive closure once per close and preserves the closed facts on reopen', async () => {
    const h = harness();
    h.refs.scheduled.push({
      id: 'sched-1',
      occurrenceId: 'occ-1',
      planId: 'plan-1',
      vehicleId: 'vehicle-1',
      status: 'scheduled',
      workshopId: null,
      mechanicId: null,
    });
    await h.service.adoptPreventive(TENANT, FLEET, {
      planId: 'plan-1',
      scheduledOrderId: 'sched-1',
    });
    await h.service.assign(TENANT, FLEET, 'sched-1', {
      version: 1,
      responsibleId: 'fleet',
      workshopId: 'workshop-1',
      scheduledDate: '2026-10-12',
    });
    await h.service.start(TENANT, FLEET, 'sched-1', { version: 2 });
    await h.service.updateWork(TENANT, FLEET, 'sched-1', {
      version: 3,
      tasks: [{ description: 'Servicio 10k' }],
    });
    await h.service.complete(TENANT, FLEET, 'sched-1', {
      version: 4,
      actualDate: '2026-10-10',
      actualKm: 10400,
    });
    const closed = await h.service.close(TENANT, ADMIN, 'sched-1', {
      version: 5,
      vehicleStatus: 'active',
    });
    const closures = h.store.events.filter(
      (e) => e.event.type === 'maintenance.order.preventive_closed',
    );
    expect(closures.map((e) => e.event.payload)).toEqual([
      {
        planId: 'plan-1',
        occurrenceId: 'occ-1',
        orderId: 'sched-1',
        kind: 'preventive',
        completedAt: '2026-10-12T12:00:00.000Z',
        actualDate: '2026-10-10',
        actualKm: 10400,
        version: 6,
      },
    ]);
    const ofType = (type: string) => h.store.events.filter((e) => e.event.type === type);
    // Adoption is announced to the plans side with ids and the order version only.
    expect(ofType('maintenance.order.preventive_adopted').map((e) => e.event.payload)).toEqual([
      { planId: 'plan-1', occurrenceId: 'occ-1', orderId: 'sched-1', version: 1 },
    ]);
    expect(
      await code(
        h.service.reopen(TENANT, FLEET, 'sched-1', { version: closed.version, reason: 'x' }),
      ),
    ).toBe('forbidden');
    expect(
      await code(h.service.reopen(TENANT, ADMIN, 'sched-1', { version: closed.version })),
    ).toBe('missing_requirements:reason');
    const reopened = await h.service.reopen(TENANT, ADMIN, 'sched-1', {
      version: closed.version,
      reason: 'Falta factura',
    });
    expect(reopened).toMatchObject({
      status: 'in_progress',
      closedAt: null,
      closeApproval: null,
      reopenCount: 1,
    });
    expect(ofType('maintenance.order.preventive_reopened').map((e) => e.event.payload)).toEqual([
      { planId: 'plan-1', occurrenceId: 'occ-1', orderId: 'sched-1', version: reopened.version },
    ]);
    const history = await h.service.history(TENANT, ADMIN, 'sched-1');
    expect(history.at(-1)).toMatchObject({
      command: 'reopen',
      from: 'closed',
      to: 'in_progress',
      comment: 'Falta factura',
    });
    expect(history.at(-1)?.before).toMatchObject({
      status: 'closed',
      closedBy: 'user-admin',
      vehicleStatusDecision: 'active',
    });
  });

  it('emits an allowlisted cancel event only for preventive orders', async () => {
    const h = harness();
    h.refs.scheduled.push({
      id: 'sched-1',
      occurrenceId: 'occ-1',
      planId: 'plan-1',
      vehicleId: 'vehicle-1',
      status: 'scheduled',
      workshopId: null,
      mechanicId: null,
    });
    const adopted = await h.service.adoptPreventive(TENANT, FLEET, {
      planId: 'plan-1',
      scheduledOrderId: 'sched-1',
    });
    const cancelled = await h.service.cancel(TENANT, FLEET, adopted.id, {
      version: adopted.version,
      reason: 'Duplicada',
    });
    expect(
      h.store.events
        .filter((e) => e.event.type === 'maintenance.order.preventive_cancelled')
        .map((e) => e.event.payload),
    ).toEqual([
      { planId: 'plan-1', occurrenceId: 'occ-1', orderId: 'sched-1', version: cancelled.version },
    ]);
    const corrective = await h.service.createCorrective(TENANT, FLEET, {
      vehicleId: 'vehicle-1',
      description: 'Ruido',
    });
    await h.service.cancel(TENANT, FLEET, corrective.id, { version: 1, reason: 'Duplicada' });
    expect(
      h.store.events.filter((e) => e.event.type === 'maintenance.order.preventive_cancelled'),
    ).toHaveLength(1);
  });

  it('cancels with a reason, keeping the recorded work', async () => {
    const { h, order } = await assigned();
    const worked = await h.service.updateWork(TENANT, FLEET, order.id, {
      version: 2,
      tasks: [{ description: 'Diagnóstico' }],
    });
    expect(await code(h.service.cancel(TENANT, FLEET, order.id, { version: worked.version }))).toBe(
      'missing_requirements:reason',
    );
    const cancelled = await h.service.cancel(TENANT, FLEET, order.id, {
      version: worked.version,
      reason: 'Duplicada',
    });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Duplicada',
      tasks: worked.tasks,
    });
    expect(
      await code(
        h.service.reopen(TENANT, ADMIN, order.id, { version: cancelled.version, reason: 'x' }),
      ),
    ).toBe('invalid_transition');
  });

  it('refuses outbox payloads outside the allowlist and stale concurrent writes', async () => {
    expect(() =>
      validateWorkOrderEvent({
        type: 'maintenance.created',
        payload: { orderId: 'a', vehicleId: 'b', version: 1, note: 'x' },
      }),
    ).toThrow(WorkOrderError);
    expect(() => validateWorkOrderEvent({ type: 'unknown', payload: {} })).toThrow(WorkOrderError);
    const { h, order } = await assigned();
    const results = await Promise.allSettled([
      h.service.start(TENANT, FLEET, order.id, { version: 2 }),
      h.service.start(TENANT, FLEET, order.id, { version: 2 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const stored = (await h.store.get(TENANT, order.id)) as WorkOrder;
    expect(stored.version).toBe(3);
    expect(
      await h.store.apply({
        order: stored,
        expectedVersion: 1,
        transition: null,
        auditAction: 'x',
        events: [],
      }),
    ).toBe(false);
    expect(
      await h.store.apply({
        order: stored,
        expectedVersion: null,
        transition: null,
        auditAction: 'x',
        events: [],
      }),
    ).toBe(false);
  });

  it('publishes timeline entries without the tenant and rejects invalid kilometers', async () => {
    const { h, order } = await assigned();
    const [created] = await h.service.history(TENANT, FLEET, order.id);
    expect(created && transitionView(created, true)).not.toHaveProperty('tenantId');
    const started = await h.service.start(TENANT, FLEET, order.id, { version: 2 });
    const worked = await h.service.updateWork(TENANT, FLEET, order.id, {
      version: started.version,
      tasks: [{ description: 'x' }],
    });
    for (const actualKm of [-1, 1.5, 10_000_000])
      expect(
        await code(
          h.service.complete(TENANT, FLEET, order.id, {
            version: worked.version,
            actualDate: '2026-10-12',
            actualKm,
          }),
        ),
      ).toBe('invalid_input');
  });

  it('voids the D20 approval when a completed order is edited and re-checks tasks at close', async () => {
    const { h, order } = await completed();
    h.refs.approval = true;
    const approved = await h.service.approveClose(TENANT, ADMIN, order.id, {
      version: order.version,
    });
    const emptied = await h.service.updateWork(TENANT, ADMIN, order.id, {
      version: approved.version,
      tasks: [],
    });
    expect(emptied.closeApproval).toBeNull();
    expect(
      await code(
        h.service.close(TENANT, ADMIN, order.id, {
          version: emptied.version,
          vehicleStatus: 'active',
        }),
      ),
    ).toBe('missing_requirements:tasks,closeApproval');
    const costed = await h.service.updateCosts(TENANT, ADMIN, order.id, {
      version: emptied.version,
      costs: [{ category: 'labor', amount: { amountMinor: '999999999', currency: 'MXN' } }],
    });
    expect(costed.closeApproval).toBeNull();
  });

  it('keeps the closed tasks, parts and costs in the timeline after reopen, redacted without view_costs', async () => {
    const { h, order } = await completed();
    const costed = await h.service.updateCosts(TENANT, ADMIN, order.id, {
      version: order.version,
      costs: [{ category: 'labor', amount: { amountMinor: '100000', currency: 'MXN' } }],
      partCosts: [
        { partId: order.parts[0]?.id, unitCost: { amountMinor: '2500', currency: 'MXN' } },
      ],
    });
    const closed = await h.service.close(TENANT, ADMIN, order.id, {
      version: costed.version,
      vehicleStatus: 'active',
    });
    const reopened = await h.service.reopen(TENANT, ADMIN, order.id, {
      version: closed.version,
      reason: 'Factura incorrecta',
    });
    await h.service.updateCosts(TENANT, ADMIN, order.id, { version: reopened.version, costs: [] });
    const reopen = (await h.service.history(TENANT, ADMIN, order.id)).find(
      (t) => t.command === 'reopen',
    );
    expect(reopen?.before).toMatchObject({
      status: 'closed',
      tasks: costed.tasks,
      costs: costed.costs,
      parts: costed.parts,
    });
    const hidden = transitionView(reopen as NonNullable<typeof reopen>, false);
    expect(JSON.stringify(hidden)).not.toMatch(/100000|2500|MXN|unitCost|"costs"/);
    expect(hidden.before?.['tasks']).toEqual(costed.tasks);
    expect(transitionView(reopen as NonNullable<typeof reopen>, true).before?.['costs']).toEqual(
      costed.costs,
    );
  });
});

describe('mechanic scope (SPECS D9) fails closed', () => {
  it('keeps a linked member scoped with an empty set when no mechanic is active', () => {
    const base = { id: 'u', subject: 'u', permissions: ['view'], mechanicIds: [] as string[] };
    expect(isMechanicScoped({ ...base, mechanicLinked: true })).toBe(true);
    expect(isMechanicScoped({ ...base, mechanicIds: ['m'] })).toBe(true);
    expect(isMechanicScoped(base)).toBe(false);
    expect(isMechanicScoped({ ...base, permissions: ['view', 'edit'], mechanicLinked: true })).toBe(
      false,
    );
  });
});
