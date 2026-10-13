import { describe, expect, it } from 'vitest';
import { IncidentError } from '../../cases/src/index.js';
import { IncidentAlertDelivery } from './delivery.js';
import { parseAlertQuery } from './query.js';
import { IncidentSlaReader } from './reader.js';
import { IncidentSlaScanner } from './scan.js';
import { InMemoryIncidentSlaStore } from './store.js';
import { AUDIENCE, kindsWhere, recipientsOf, visibleTo } from './recipients.js';
import {
  ADMIN,
  DAY,
  MANAGER,
  REPORTED_AT,
  TENANT_A,
  TENANT_B,
  VIEWER,
  actorOf,
  at,
  entry,
  put,
  reportedCase,
  slaWorld,
  type SlaWorld,
} from './test-support.js';

const sla = async (world: SlaWorld, id: string) => {
  const incident = (await world.store.get(TENANT_A, id))!;
  return (await world.reader.forIncidents(TENANT_A, [incident])).get(id);
};
const tick = (world: SlaWorld, offset: number) => {
  world.clock.current = at(REPORTED_AT, offset);
};

describe('calculated SLA block', () => {
  it('walks a case from on track to warning to breached with the whole percent used', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, { responsibleId: MANAGER.id });
    expect(await sla(world, incident.id)).toEqual({
      cycle: 1,
      state: 'on_track',
      startedAt: REPORTED_AT,
      deadline: '2026-11-16T16:00:00.000Z',
      targetDays: 15,
      elapsedPercent: 0,
      resolvedAt: null,
      previousCycles: [],
    });
    tick(world, 12 * DAY);
    expect(await sla(world, incident.id)).toMatchObject({ state: 'warning', elapsedPercent: 80 });
    tick(world, 16 * DAY);
    expect(await sla(world, incident.id)).toMatchObject({ state: 'breached', elapsedPercent: 106 });
  });

  it('gives the same local hour in a zone with daylight saving, not a multiple of 24 hours', async () => {
    const world = slaWorld();
    world.slaSettings.byTenant.set(TENANT_A, {
      timeZone: 'America/New_York',
      targetDays: { critical: 7, high: 15, medium: 30, low: 45 },
      inactivityDays: 5,
    });
    const incident = await reportedCase(world, {}, '2026-03-01T15:00:00.000Z');
    tick(world, 0);
    expect((await sla(world, incident.id))?.deadline).toBe('2026-03-16T14:00:00.000Z');
  });

  it('says met or missed for a resolved cycle and freezes it', async () => {
    const world = slaWorld();
    const met = await reportedCase(world);
    const day10 = at(REPORTED_AT, 10 * DAY).toISOString();
    await put(world, met, { status: 'resolved', resolvedAt: day10 });
    tick(world, 60 * DAY);
    expect(await sla(world, met.id)).toMatchObject({
      state: 'met',
      elapsedPercent: 66,
      resolvedAt: day10,
    });
    const missed = await reportedCase(world, {});
    const day20 = at(REPORTED_AT, 20 * DAY).toISOString();
    await put(world, missed, { status: 'resolved', resolvedAt: day20 });
    expect(await sla(world, missed.id)).toMatchObject({ state: 'missed' });
  });

  it('shows not_started for a draft and no block for a cancelled case that never resolved', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world);
    await put(world, incident, { status: 'draft', reportedAt: null });
    expect(await sla(world, incident.id)).toMatchObject({
      state: 'not_started',
      startedAt: null,
      deadline: null,
      targetDays: null,
      elapsedPercent: 0,
    });
    await put(world, (await world.store.get(TENANT_A, incident.id))!, {
      status: 'cancelled',
      reportedAt: REPORTED_AT,
    });
    expect(await sla(world, incident.id)).toBeUndefined();
    // A case cancelled after it was resolved keeps its result.
    await put(world, (await world.store.get(TENANT_A, incident.id))!, {
      resolvedAt: at(REPORTED_AT, DAY).toISOString(),
    });
    expect(await sla(world, incident.id)).toMatchObject({ state: 'met' });
  });

  it('keeps the first cycle and measures the reopened one apart (acceptance 6)', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, { responsibleId: MANAGER.id });
    await world.scanner.scan(TENANT_A);
    const day10 = at(REPORTED_AT, 10 * DAY).toISOString();
    const day20 = at(REPORTED_AT, 20 * DAY).toISOString();
    await put(
      world,
      (await world.store.get(TENANT_A, incident.id))!,
      { status: 'reopened', cycle: 2, reopenCount: 1, resolvedAt: day10, updatedAt: day20 },
      [entry('resolve', day10), entry('close', day10), entry('reopen', day20)],
    );
    tick(world, 25 * DAY);
    expect(await sla(world, incident.id)).toEqual({
      cycle: 2,
      state: 'on_track',
      startedAt: day20,
      deadline: at(REPORTED_AT, 35 * DAY).toISOString(),
      targetDays: 15,
      elapsedPercent: 33,
      resolvedAt: null,
      previousCycles: [{ cycle: 1, startedAt: REPORTED_AT, resolvedAt: day10, met: true }],
    });
    // Resolved again on day 40: the second cycle missed, the first is still met.
    const day40 = at(REPORTED_AT, 40 * DAY).toISOString();
    await put(world, (await world.store.get(TENANT_A, incident.id))!, {
      status: 'resolved',
      resolvedAt: day40,
    });
    tick(world, 60 * DAY);
    expect(await sla(world, incident.id)).toMatchObject({
      cycle: 2,
      state: 'missed',
      resolvedAt: day40,
      previousCycles: [{ cycle: 1, met: true }],
    });
  });

  it('marks a past cycle missed when it ended after its deadline, and reads nothing for no cases', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world);
    const day16 = at(REPORTED_AT, 16 * DAY).toISOString();
    const day30 = at(REPORTED_AT, 30 * DAY).toISOString();
    await put(
      world,
      (await world.store.get(TENANT_A, incident.id))!,
      { status: 'reopened', cycle: 2, resolvedAt: day16, updatedAt: day30 },
      [entry('resolve', day16), entry('reopen', day30)],
    );
    expect((await sla(world, incident.id))?.previousCycles).toEqual([
      { cycle: 1, startedAt: REPORTED_AT, resolvedAt: day16, met: false },
    ]);
    expect((await world.reader.forIncidents(TENANT_A, [])).size).toBe(0);
  });
});

describe('notices visible to a member (acceptance 8 and 10)', () => {
  const list = (world: SlaWorld, actor = MANAGER, input: unknown = {}, tenantId = TENANT_A) =>
    world.reader.alerts(tenantId, actor, input);

  it('shows the responsible their notices, the supervisor the escalations, the viewer nothing', async () => {
    const world = slaWorld();
    // Responsible: a third member who only reads and is responsible.
    const owner = actorOf('00000000-0000-4000-8000-0000000000b1', ['incidents:view']);
    await reportedCase(world, { responsibleId: owner.id });
    tick(world, 15 * DAY);
    await world.scanner.scan(TENANT_A);
    const kinds = async (actor: typeof owner) =>
      (await list(world, actor)).items.map((item) => item.kind).sort();
    expect(await kinds(owner)).toEqual([
      'inactive',
      'inactive_escalation',
      'sla_breach',
      'sla_warning',
    ]);
    // The supervisor sees the escalation and the breach, not the responsible-only warning.
    expect(await kinds(ADMIN)).toEqual(['inactive_escalation', 'sla_breach']);
    // The case manager sees nothing here: they are not responsible and the case has one.
    expect(await kinds(MANAGER)).toEqual([]);
    expect(await kinds(VIEWER)).toEqual([]);
  });

  it('shows case managers the notices of a case without responsible', async () => {
    const world = slaWorld();
    await reportedCase(world);
    tick(world, 30 * 3_600_000);
    await world.scanner.scan(TENANT_A);
    expect((await list(world, MANAGER)).items.map((item) => item.kind).sort()).toEqual([
      'unassigned',
      'unassigned_escalation',
    ]);
    expect((await list(world, VIEWER)).items).toEqual([]);
  });

  it('shows the assignment only to the member it was written for, while they are responsible', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, { responsibleId: MANAGER.id });
    await world.scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 3 });
    expect((await list(world, MANAGER)).items.map((i) => i.kind)).toEqual(['assigned']);
    expect((await list(world, ADMIN)).items).toEqual([]);
    await put(world, (await world.store.get(TENANT_A, incident.id))!, { responsibleId: ADMIN.id });
    expect((await list(world, MANAGER)).items).toEqual([]);
    expect((await list(world, ADMIN)).items).toEqual([]);
  });

  it('filters, pages, refuses and isolates', async () => {
    const world = slaWorld();
    const a = await reportedCase(world, { responsibleId: MANAGER.id });
    const b = await reportedCase(world, { responsibleId: MANAGER.id });
    tick(world, 12 * DAY);
    await world.scanner.scan(TENANT_A);
    const all = await list(world, MANAGER, { limit: 25 });
    // Per case: the 80 % notice, the quiet period (N and 2N) -- three for the responsible.
    expect(all.total).toBe(6);
    expect(new Set(all.items.map((item) => item.folio))).toEqual(new Set([a.folio, b.folio]));
    expect((await list(world, MANAGER, { kind: 'sla_warning' })).total).toBe(2);
    expect(
      (await list(world, MANAGER, { incidentId: a.id })).items.every((i) => i.incidentId === a.id),
    ).toBe(true);
    const page = await list(world, MANAGER, { limit: 25, offset: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(6);
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([
      'createdAt',
      'cycle',
      'deadline',
      'folio',
      'id',
      'incidentId',
      'kind',
      'severity',
    ]);
    // Another tenant sees none of it.
    expect((await list(world, MANAGER, {}, TENANT_B)).total).toBe(0);
    // Without incidents:view, or mechanic-scoped, nothing is shown.
    await expect(list(world, actorOf('x', ['view', 'edit']))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await list(world, actorOf('m', ['incidents:view'], true))).items).toEqual([]);
  });

  it('rejects an unknown key or a bad value naming only the field', () => {
    for (const input of [
      { tenantId: TENANT_B },
      { kind: 'nope' },
      { incidentId: '' },
      { limit: 30 },
      { offset: -1 },
      { offset: 1.5 },
    ])
      expect(() => parseAlertQuery(input)).toThrow(IncidentError);
    expect(() => parseAlertQuery(null)).toThrow(IncidentError);
    expect(() => parseAlertQuery({ tenantId: 'x' })).toThrow(
      expect.objectContaining({ fieldErrors: [{ field: 'tenantId', code: 'unknown_property' }] }),
    );
    expect(parseAlertQuery({})).toEqual({ limit: 25, offset: 0 });
  });
});

describe('audience rules', () => {
  it('keeps one table the list and the mail both follow', async () => {
    expect(kindsWhere((a) => a.approve)).toEqual([
      'sla_breach',
      'unassigned_escalation',
      'inactive_escalation',
    ]);
    expect(AUDIENCE.assigned.assignee).toBe(true);
    const world = slaWorld();
    const alert = { tenantId: TENANT_A, kind: 'sla_breach', subjectId: null } as const;
    expect(await recipientsOf(alert, MANAGER.id, world.directory)).toEqual(
      [ADMIN.id, MANAGER.id].sort(),
    );
    expect(await recipientsOf(alert, null, world.directory)).toEqual([ADMIN.id, MANAGER.id].sort());
    expect(
      await recipientsOf({ ...alert, kind: 'sla_warning' }, 'user-gone', world.directory),
    ).toEqual(['user-gone']);
    expect(
      visibleTo({ kind: 'unassigned', subjectId: null }, null, {
        id: 'x',
        edit: false,
        approve: true,
      }),
    ).toBe(false);
  });
});

describe('real clock', () => {
  it('uses the system clock and a silent event sink unless told otherwise', async () => {
    const world = slaWorld(new Date());
    const store = new InMemoryIncidentSlaStore(world.store);
    const reader = new IncidentSlaReader(world.store, store, world.slaSettings);
    const scanner = new IncidentSlaScanner(world.store, store, world.slaSettings);
    const delivery = new IncidentAlertDelivery(
      world.store,
      store,
      world.directory,
      world.addresses,
      world.mailer,
    );
    const incident = await reportedCase(
      world,
      { reportedAt: new Date().toISOString() },
      new Date().toISOString(),
    );
    expect((await reader.forIncidents(TENANT_A, [incident])).get(incident.id)?.state).toBe(
      'on_track',
    );
    expect(await scanner.scan(TENANT_A, incident.id)).toEqual({ examined: 1, created: 0 });
    expect(await scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 1 })).toBe(false);
    const made = await store.createAlert({
      tenantId: TENANT_A,
      incidentId: incident.id,
      folio: incident.folio,
      cycle: 1,
      kind: 'inactive',
      dedupeRef: 'u1',
      severity: null,
      deadline: null,
      subjectId: null,
      createdAt: new Date().toISOString(),
    });
    expect(made).not.toBeNull();
    const payload = { incidentId: incident.id, alertId: made!.id, kind: 'inactive', cycle: 1 };
    expect(await delivery.deliver(TENANT_A, payload)).toMatchObject({ sent: 2 });
  });
});
