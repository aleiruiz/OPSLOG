import { describe, expect, it } from 'vitest';
import {
  EVENTS,
  NOTIFICATIONS_DISPATCH_JOB,
  NOTIFICATIONS_SCAN_INTERVAL_MS,
  NOTIFICATIONS_SCAN_JOB,
  notificationHandlers,
  notificationJobs,
  registerNotificationHandlers,
  thresholdOf,
  withSlaNotice,
} from './index.js';
import { setup } from './test-support.js';
import type { Handler } from '../../base/src/index.js';

const meta = (tenantId: string, type: string) => ({ eventId: 'e1', tenantId, type });

async function run(
  deps: ReturnType<typeof setup>['deps'],
  type: string,
  payload: unknown,
  tenantId = 'A',
) {
  const handler = notificationHandlers(deps)[type] as Handler;
  await handler(payload, meta(tenantId, type));
}

const listFor = async (s: ReturnType<typeof setup>, who: string, tenantId = 'A') =>
  (await s.h.service.list(s.h.actor(tenantId, who))).items;

describe('outbox handlers', () => {
  it('tells the responsible, the creator and the followers of a new incident, once', async () => {
    const s = setup();
    s.sources.incidents.set('A|i1', { folio: 'SIN-0001', responsibleId: 'ana', createdBy: 'luis' });
    await s.h.service.subscribe(s.h.actor('A', 'root'), 'incident', 'i1');
    const payload = { incidentId: 'i1', vehicleId: 'v1', version: 1 };
    await run(s.deps, EVENTS.incidentCreated, payload);
    await run(s.deps, EVENTS.incidentCreated, payload);
    for (const who of ['ana', 'luis', 'root'])
      expect(await listFor(s, who)).toEqual([
        expect.objectContaining({
          eventKind: 'incident_created',
          title: 'Siniestro nuevo · SIN-0001',
          link: '/incidents/i1',
        }),
      ]);
    expect(await listFor(s, 'vera')).toEqual([]);
  });

  it('notices each change of status once per version and drops an unknown incident', async () => {
    const s = setup();
    s.sources.incidents.set('A|i1', { folio: 'SIN-0001', responsibleId: 'ana', createdBy: null });
    const change = (version: number, status: string) => ({
      incidentId: 'i1',
      vehicleId: 'v1',
      version,
      status,
    });
    await run(s.deps, EVENTS.incidentStatus, change(2, 'under_review'));
    await run(s.deps, EVENTS.incidentStatus, change(2, 'under_review'));
    await run(s.deps, EVENTS.incidentStatus, change(3, 'closed'));
    const items = await listFor(s, 'ana');
    expect(items.map((n) => [n.title, n.severity])).toEqual([
      ['Siniestro Cerrado · SIN-0001', 'info'],
      ['Siniestro En revisión · SIN-0001', 'attention'],
    ]);
    await run(s.deps, EVENTS.incidentStatus, { ...change(4, 'repair'), incidentId: 'gone' });
    expect(await listFor(s, 'ana')).toHaveLength(2);
  });

  it('announces a maintenance plan to the fleet, and an overdue one also to supervisors, once a day', async () => {
    const s = setup();
    s.sources.plans.set('A|p1', 'v1');
    const alert = (eventType: string, alertId: string) => ({
      alertId,
      planId: 'p1',
      eventType,
      schemaVersion: 1,
    });
    await run(s.deps, EVENTS.planAlert, alert('upcoming', 'al-1'));
    await run(s.deps, EVENTS.planAlert, alert('due', 'al-2'));
    await run(s.deps, EVENTS.planAlert, alert('overdue', 'al-3'));
    await run(s.deps, EVENTS.planAlert, alert('overdue', 'al-4'));
    expect((await listFor(s, 'ana')).map((n) => n.title).sort()).toEqual([
      'Mantenimiento próximo · ECO-1',
      'Mantenimiento próximo · ECO-1',
      'Mantenimiento vencido · ECO-1',
    ]);
    expect((await listFor(s, 'root')).map((n) => n.eventKind)).toEqual(['maintenance_overdue']);
    await run(s.deps, EVENTS.planAlert, { ...alert('overdue', 'al-5'), occurrenceId: 'o1' });
    s.h.advance(24 * 3_600_000);
    await run(s.deps, EVENTS.planAlert, alert('overdue', 'al-6'));
    expect((await listFor(s, 'root')).length).toBe(2);
  });

  it('refuses an unknown kind of plan alert so the outbox retries it', async () => {
    const s = setup();
    await expect(
      run(s.deps, EVENTS.planAlert, {
        alertId: 'a',
        planId: 'p1',
        eventType: 'weird',
        schemaVersion: 1,
      }),
    ).rejects.toThrow('invalid notification event');
  });

  it('tells the mechanic of an order only when it is assigned to a member', async () => {
    const s = setup();
    s.h.directory.add('A', 'mec', ['view']);
    const order = (status: string, mechanicMemberId: string | null) =>
      s.sources.orders.set('A|o1', { vehicleId: 'v1', status, mechanicMemberId });
    const payload = (version: number) => ({ orderId: 'o1', vehicleId: 'v1', version });
    order('scheduled', 'mec');
    await run(s.deps, EVENTS.orderStatus, payload(1));
    order('assigned', null);
    await run(s.deps, EVENTS.orderStatus, payload(2));
    await run(s.deps, EVENTS.orderStatus, { ...payload(2), orderId: 'gone' });
    order('assigned', 'mec');
    await run(s.deps, EVENTS.orderStatus, payload(3));
    await run(s.deps, EVENTS.orderStatus, payload(3));
    expect(await s.h.service.list(s.h.actor('A', 'mec'))).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          eventKind: 'work_order_assigned',
          link: '/flota/mantenimiento/ordenes/o1',
          title: 'Orden de mantenimiento asignada · ECO-1',
        }),
      ],
    });
  });

  it('announces a vehicle out of service to the fleet and its followers, and ignores other statuses', async () => {
    const s = setup();
    await s.h.service.subscribe(s.h.actor('A', 'vera'), 'vehicle', 'v1');
    await run(s.deps, EVENTS.vehicleStatus, { vehicleId: 'v1', status: 'active', version: 2 });
    await run(s.deps, EVENTS.vehicleStatus, {
      vehicleId: 'v1',
      status: 'out_of_service',
      version: 3,
    });
    for (const who of ['ana', 'luis', 'vera'])
      expect((await listFor(s, who)).map((n) => n.title)).toEqual([
        'Vehículo fuera de servicio · ECO-1',
      ]);
  });

  it('tells the requester that an export is ready or failed, and nobody else', async () => {
    const s = setup();
    s.sources.exportJobs.set('A|j1', { requesterId: 'vera', reportTitle: 'Conductores' });
    const base = { jobId: 'j1', reportId: 'drivers', format: 'csv' };
    await run(s.deps, EVENTS.exportDone, { ...base, rowCount: 3 });
    await run(s.deps, EVENTS.exportFailed, { ...base, code: 'too_many_rows' });
    await run(s.deps, EVENTS.exportDone, { ...base, jobId: 'gone', rowCount: 3 });
    expect((await listFor(s, 'vera')).map((n) => n.title).sort()).toEqual([
      'Exportación fallida · Conductores',
      'Exportación lista · Conductores',
    ]);
    expect(await listFor(s, 'ana')).toEqual([]);
  });

  it('tells the person and the administrators of a new member or a role change', async () => {
    const s = setup();
    await run(s.deps, EVENTS.membershipCreated, { memberId: 'vera', role: 'viewer', version: 1 });
    await run(s.deps, EVENTS.membershipRole, { memberId: 'vera', role: 'editor', version: 2 });
    expect((await listFor(s, 'vera')).map((n) => n.eventKind).sort()).toEqual([
      'membership_created',
      'membership_role_changed',
    ]);
    expect(await listFor(s, 'root')).toHaveLength(2);
    expect(await listFor(s, 'ana')).toEqual([]);
  });

  it('keeps the companies apart for equal ids', async () => {
    const s = setup();
    s.sources.incidents.set('A|i1', { folio: 'SIN-A', responsibleId: 'ana', createdBy: null });
    s.sources.incidents.set('B|i1', { folio: 'SIN-B', responsibleId: 'ana', createdBy: null });
    s.h.directory.add('B', 'ana', ['view', 'incidents:view']);
    s.h.directory.add('A', 'ana', ['view', 'incidents:view']);
    const payload = { incidentId: 'i1', vehicleId: 'v1', version: 1 };
    await run(s.deps, EVENTS.incidentCreated, payload, 'B');
    expect((await listFor(s, 'ana')).length).toBe(0);
    expect((await listFor(s, 'ana', 'B')).map((n) => n.title)).toEqual(['Siniestro nuevo · SIN-B']);
  });

  it('refuses a payload with anything else in it', async () => {
    const s = setup();
    const bad: unknown[] = [
      null,
      [],
      { incidentId: 'i1', vehicleId: 'v1', version: 1, extra: 'x' },
      { incidentId: 'i1', vehicleId: 'v1' },
      { incidentId: 'bad id', vehicleId: 'v1', version: 1 },
      { incidentId: 'i1', vehicleId: 'v1', version: -1 },
    ];
    for (const payload of bad)
      await expect(run(s.deps, EVENTS.incidentCreated, payload)).rejects.toThrow(
        'invalid notification event',
      );
  });

  it('registers one handler per event on a worker', () => {
    const s = setup();
    const seen: string[] = [];
    registerNotificationHandlers({ register: (type) => void seen.push(type) }, s.deps);
    expect(seen.sort()).toEqual(
      Object.values(EVENTS)
        .filter((type) => type !== EVENTS.slaAlert)
        .sort(),
    );
  });
});

describe('INC-SLA notices', () => {
  const alert = { incidentId: 'i1', alertId: 'sla-1', kind: 'sla_breach', cycle: 1 };
  function tee() {
    const s = setup();
    s.sources.sla.set('A|sla-1', {
      incidentId: 'i1',
      folio: 'SIN-0001',
      label: 'El SLA del siniestro venció',
      severity: 'critical',
      recipients: ['ana'],
    });
    const order: string[] = [];
    const registered = new Map<string, Handler>();
    const worker = withSlaNotice({ register: (type, h) => void registered.set(type, h) }, s.deps);
    return { s, order, registered, worker };
  }

  it('writes the in-app notice and still runs the e-mail handler', async () => {
    const { s, order, registered, worker } = tee();
    worker.register(EVENTS.slaAlert, async () => void order.push('mail'));
    worker.register('other.event', async () => undefined);
    await (registered.get(EVENTS.slaAlert) as Handler)(alert, meta('A', EVENTS.slaAlert));
    await (registered.get(EVENTS.slaAlert) as Handler)(alert, meta('A', EVENTS.slaAlert));
    expect(order).toEqual(['mail', 'mail']);
    expect(registered.has('other.event')).toBe(true);
    expect(await listFor(s, 'ana')).toEqual([
      expect.objectContaining({
        eventKind: 'incident_sla',
        title: 'El SLA del siniestro venció · SIN-0001',
        severity: 'critical',
      }),
    ]);
    // The e-mail of INC-SLA is the only one: this module sends none for the kind.
    expect(await s.h.dispatcher.runDue('A')).toMatchObject({ sent: 0 });
    expect(s.h.sink.messages).toHaveLength(0);
  });

  it('never holds back the e-mail when the notice fails, and retries afterwards', async () => {
    const { order, registered, worker } = tee();
    worker.register(EVENTS.slaAlert, async () => void order.push('mail'));
    await expect(
      (registered.get(EVENTS.slaAlert) as Handler)(
        { ...alert, extra: 1 },
        meta('A', EVENTS.slaAlert),
      ),
    ).rejects.toThrow('invalid notification event');
    expect(order).toEqual(['mail']);
  });

  it('lets the mail handler fail without hiding its error and ignores an alert it cannot find', async () => {
    const { s, registered, worker } = tee();
    worker.register(EVENTS.slaAlert, async () => {
      throw new Error('pending');
    });
    const handler = registered.get(EVENTS.slaAlert) as Handler;
    await expect(handler(alert, meta('A', EVENTS.slaAlert))).rejects.toThrow('pending');
    await expect(
      handler({ ...alert, alertId: 'unknown' }, meta('A', EVENTS.slaAlert)),
    ).rejects.toThrow('pending');
    await expect(
      handler({ ...alert, incidentId: 'other' }, meta('A', EVENTS.slaAlert)),
    ).rejects.toThrow('pending');
    expect(await listFor(s, 'ana')).toHaveLength(1);
  });
});

describe('jobs', () => {
  it('maps days to the threshold they reached', () => {
    expect([40, 31, 30, 20, 15, 10, 7, 3, 1, 0, -1, -3, -4].map(thresholdOf)).toEqual([
      null,
      null,
      30,
      30,
      15,
      15,
      7,
      7,
      7,
      0,
      0,
      0,
      null,
    ]);
  });

  function jobs(s: ReturnType<typeof setup>, tenants: readonly string[] = ['A']) {
    let clock = s.h.now().getTime();
    const list = notificationJobs({
      dispatcher: s.h.dispatcher,
      ingest: s.h.ingest,
      sources: s.sources,
      activeTenantIds: () => tenants,
      clock: () => clock,
    });
    return {
      scan: list.find((job) => job.name === NOTIFICATIONS_SCAN_JOB) as (typeof list)[number],
      dispatch: list.find(
        (job) => job.name === NOTIFICATIONS_DISPATCH_JOB,
      ) as (typeof list)[number],
      advance: (ms: number) => void (clock += ms),
    };
  }
  const item = (over: object = {}) => ({
    source: 'insurance_policy' as const,
    subjectId: 'pol-1',
    vehicleId: 'v1',
    dueOn: '2026-10-26',
    daysToExpiry: 7,
    ...over,
  });

  it('scans once per thread of days: twice the same day writes one notice per person and threshold', async () => {
    const s = setup();
    s.sources.due.set('A', [item(), item({ subjectId: 'doc-9', daysToExpiry: 40 })]);
    const j = jobs(s);
    expect(await j.scan.run()).toBe(2);
    j.advance(NOTIFICATIONS_SCAN_INTERVAL_MS);
    expect(await j.scan.run()).toBe(0);
    expect(await listFor(s, 'ana')).toEqual([
      expect.objectContaining({ title: 'Seguro vence en 7 días · ECO-1', severity: 'important' }),
    ]);
    // The same scan inside the hour does not even look.
    s.sources.due.set('A', [item({ subjectId: 'pol-2', dueOn: '2026-10-27', daysToExpiry: 8 })]);
    expect(await j.scan.run()).toBe(0);
    j.advance(NOTIFICATIONS_SCAN_INTERVAL_MS);
    expect(await j.scan.run()).toBe(2);
  });

  it('starts the cycle again when the due date changes, and moves to the next threshold', async () => {
    const s = setup();
    const j = jobs(s);
    s.sources.due.set('A', [item()]);
    await j.scan.run();
    j.advance(NOTIFICATIONS_SCAN_INTERVAL_MS);
    s.sources.due.set('A', [item({ dueOn: '2027-10-26', daysToExpiry: 7 })]);
    expect(await j.scan.run()).toBe(2);
    j.advance(NOTIFICATIONS_SCAN_INTERVAL_MS);
    s.sources.due.set('A', [item({ dueOn: '2027-10-26', daysToExpiry: 0 })]);
    expect(await j.scan.run()).toBe(2);
    expect(await listFor(s, 'ana')).toHaveLength(3);
  });

  it('announces a licence on the employee and a document on its vehicle, with the right link', async () => {
    const s = setup();
    s.sources.due.set('A', [
      item({ source: 'employee_license', subjectId: 'emp-1', vehicleId: null, daysToExpiry: 15 }),
      item({ source: 'vehicle_document', subjectId: 'doc-1', daysToExpiry: 0 }),
    ]);
    await jobs(s).scan.run();
    const items = await listFor(s, 'luis');
    expect(items.map((n) => [n.entityType, n.entityId, n.link, n.title]).sort()).toEqual([
      ['employee', 'emp-1', '/plantilla/empleados/emp-1', 'Licencia de conductor vence en 15 días'],
      ['vehicle', 'v1', '/flota/vehiculos/v1', 'Documento vence hoy o ya venció · ECO-1'],
    ]);
  });

  it('dispatches the due e-mails of every active company and reports the work done', async () => {
    const s = setup();
    await s.h.ingest.ingest(s.h.event());
    await s.h.ingest.ingest(s.h.event({ tenantId: 'B', recipients: ['ana'] }));
    const j = jobs(s, ['A', 'B']);
    expect(await j.dispatch.run()).toBe(2);
    expect(s.h.sink.messages.map((m) => m.companyId).sort()).toEqual(['A', 'B']);
    expect(await j.dispatch.run()).toBe(0);
  });

  it('tries every company and rethrows the first failure afterwards', async () => {
    const s = setup();
    await s.h.ingest.ingest(s.h.event({ tenantId: 'B', recipients: ['ana'] }));
    const failing = {
      runDue: async (tenantId: string) => {
        if (tenantId === 'A') throw new Error('boom');
        return s.h.dispatcher.runDue(tenantId);
      },
    };
    const list = notificationJobs({
      dispatcher: failing,
      ingest: s.h.ingest,
      sources: s.sources,
      activeTenantIds: () => ['A', 'B'],
      clock: () => 0,
    });
    await expect(list[0]!.run()).rejects.toThrow('boom');
    expect(s.h.sink.messages).toHaveLength(1);
  });
});
