import { describe, expect, it } from 'vitest';
import { COMPLETE } from '../../workflow/src/test-support.js';
import type { AlertKind } from './catalog.js';
import {
  DAY,
  HOUR,
  MANAGER,
  REPORTED_AT,
  TENANT_A,
  TENANT_B,
  at,
  entry,
  put,
  reportEntry,
  reportedCase,
  slaWorld,
  type SlaWorld,
} from './test-support.js';

const kindsOf = (world: SlaWorld, tenantId = TENANT_A) =>
  world.slaStore.all(tenantId).map((alert) => `${alert.kind}:${alert.cycle}:${alert.dedupeRef}`);
const count = (world: SlaWorld, kind: AlertKind, tenantId = TENANT_A) =>
  world.slaStore.all(tenantId).filter((alert) => alert.kind === kind).length;
const tick = (world: SlaWorld, offset: number) => {
  world.clock.current = at(REPORTED_AT, offset);
};
const assigned = { responsibleId: MANAGER.id };

describe('SLA thresholds (acceptance 1)', () => {
  it('notices 80 % and 100 % once, at exactly 12 and 15 days, however often it scans', async () => {
    const world = slaWorld();
    await reportedCase(world, assigned);
    tick(world, 12 * DAY - 1000);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_warning') + count(world, 'sla_breach')).toBe(0);
    tick(world, 12 * DAY);
    for (let n = 0; n < 10; n += 1) await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_warning')).toBe(1);
    expect(count(world, 'sla_breach')).toBe(0);
    tick(world, 15 * DAY);
    await Promise.all([world.scanner.scan(TENANT_A), world.scanner.scan(TENANT_A)]);
    for (let n = 0; n < 10; n += 1) await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_warning')).toBe(1);
    expect(count(world, 'sla_breach')).toBe(1);
    const sla = world.slaStore.all(TENANT_A).filter((a) => a.kind.startsWith('sla_'));
    expect(sla.map((a) => a.deadline)).toEqual([
      '2026-11-16T16:00:00.000Z',
      '2026-11-16T16:00:00.000Z',
    ]);
    // One event per notice, and nothing else in them.
    expect(world.events).toHaveLength(world.slaStore.all(TENANT_A).length);
    expect(world.events.every((e) => e.type === 'incident.sla_alert')).toBe(true);
    expect(Object.keys(world.events[0]?.payload ?? {}).sort()).toEqual([
      'alertId',
      'cycle',
      'incidentId',
      'kind',
    ]);
  });

  it('owes both notices to a case it sees for the first time past its deadline', async () => {
    const world = slaWorld();
    await reportedCase(world, assigned);
    tick(world, 20 * DAY);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_warning')).toBe(1);
    expect(count(world, 'sla_breach')).toBe(1);
  });

  it('uses the target of the settings when the cycle is first seen and keeps it afterwards', async () => {
    const world = slaWorld();
    await reportedCase(world, assigned);
    world.slaSettings.byTenant.set(TENANT_A, {
      timeZone: 'America/Mexico_City',
      targetDays: { critical: 7, high: 5, medium: 30, low: 45 },
      inactivityDays: 5,
    });
    tick(world, 4 * DAY);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_warning')).toBe(1);
    // Settings change again: the cycle keeps the 5 days it was given.
    world.slaSettings.byTenant.set(TENANT_A, {
      timeZone: 'America/Mexico_City',
      targetDays: { critical: 7, high: 60, medium: 30, low: 45 },
      inactivityDays: 5,
    });
    tick(world, 5 * DAY);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_breach')).toBe(1);
  });
});

describe('case without a responsible (acceptance 3)', () => {
  it('notices after 4 h and escalates at 24 h, in wall-clock time', async () => {
    const world = slaWorld();
    await reportedCase(world);
    tick(world, 4 * HOUR);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'unassigned')).toBe(0);
    tick(world, 4 * HOUR + 1000);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'unassigned')).toBe(1);
    expect(count(world, 'unassigned_escalation')).toBe(0);
    tick(world, 24 * HOUR);
    await world.scanner.scan(TENANT_A);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'unassigned')).toBe(1);
    expect(count(world, 'unassigned_escalation')).toBe(1);
  });

  it('asks for nothing when the case was assigned before 4 h', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world);
    await put(world, incident, assigned);
    tick(world, 30 * HOUR);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'unassigned') + count(world, 'unassigned_escalation')).toBe(0);
  });
});

describe('inactivity (acceptance 4)', () => {
  it('notices at N days, escalates at 2N, and a change starts a new period noticed once more', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, { ...assigned, status: 'under_review' });
    tick(world, 5 * DAY);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'inactive')).toBe(1);
    expect(count(world, 'inactive_escalation')).toBe(0);
    tick(world, 10 * DAY);
    await world.scanner.scan(TENANT_A);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'inactive')).toBe(1);
    expect(count(world, 'inactive_escalation')).toBe(1);
    // An edit on day 11 restarts the reference.
    const current = await world.store.get(TENANT_A, incident.id);
    await put(world, current!, { updatedAt: at(REPORTED_AT, 11 * DAY).toISOString() });
    tick(world, 15 * DAY);
    await world.scanner.scan(TENANT_A);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'inactive')).toBe(1);
    tick(world, 16 * DAY);
    await world.scanner.scan(TENANT_A);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'inactive')).toBe(2);
    expect(count(world, 'inactive_escalation')).toBe(1);
  });

  it('reads N from the settings when the scan runs', async () => {
    const world = slaWorld();
    await reportedCase(world, { ...assigned, status: 'under_review' });
    world.slaSettings.byTenant.set(TENANT_A, {
      timeZone: 'UTC',
      targetDays: { critical: 7, high: 150, medium: 30, low: 45 },
      inactivityDays: 1,
    });
    tick(world, DAY);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'inactive')).toBe(1);
  });
});

describe('severity change (acceptance 5)', () => {
  it('recalculates from the start of the cycle, notices both thresholds of the new target once', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, {
      ...assigned,
      severity: 'low',
      status: 'under_review',
    });
    await world.scanner.scan(TENANT_A);
    expect(world.slaStore.all(TENANT_A)).toHaveLength(0);
    tick(world, 8 * DAY);
    // The change goes through the case service: audited and in the timeline (INC-CASES).
    const current = (await world.store.get(TENANT_A, incident.id))!;
    await world.cases.update(TENANT_A, MANAGER, incident.id, {
      version: current.version,
      severity: 'critical',
    });
    const history = await world.store.history(TENANT_A, incident.id);
    expect(history.at(-1)?.changedFields).toContain('severity');
    expect(world.store.audit.some((entryOf) => entryOf.action.includes('update'))).toBe(true);
    for (let n = 0; n < 3; n += 1) await world.scanner.scan(TENANT_A);
    const sla = world.slaStore.all(TENANT_A).filter((a) => a.kind.startsWith('sla_'));
    expect(sla.map((a) => `${a.kind}:${a.dedupeRef}:${a.severity}`).sort()).toEqual([
      'sla_breach:t2:critical',
      'sla_warning:t2:critical',
    ]);
    expect(sla[0]?.deadline).toBe('2026-11-08T16:00:00.000Z');
    const [row] = await world.slaStore.cycles(TENANT_A, [incident.id]);
    expect(row).toMatchObject({ severity: 'critical', targetDays: 7, targetVersion: 2 });
  });

  it('judges on what another worker wrote when it loses the retarget', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, {
      ...assigned,
      severity: 'low',
      status: 'under_review',
    });
    await world.scanner.scan(TENANT_A);
    tick(world, 8 * DAY);
    const current = (await world.store.get(TENANT_A, incident.id))!;
    await put(world, current, { severity: 'critical' });
    const real = world.slaStore.retarget.bind(world.slaStore);
    world.slaStore.retarget = async (row, expected) => {
      // The other worker gets there first.
      await real(row, expected);
      return real(row, expected);
    };
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_breach')).toBe(1);
    expect(kindsOf(world).filter((k) => k.startsWith('sla_breach'))).toEqual(['sla_breach:1:t2']);
  });
});

describe('reopening (acceptance 6)', () => {
  it('keeps cycle 1 as it ended and measures cycle 2 from the reopening with its own keys', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, { ...assigned, status: 'under_review' });
    await world.scanner.scan(TENANT_A);
    const day10 = at(REPORTED_AT, 10 * DAY).toISOString();
    const day20 = at(REPORTED_AT, 20 * DAY).toISOString();
    await put(
      world,
      (await world.store.get(TENANT_A, incident.id))!,
      {
        status: 'reopened',
        cycle: 2,
        reopenCount: 1,
        resolvedAt: day10,
        updatedAt: day20,
      },
      [entry('resolve', day10), entry('close', day10), entry('reopen', day20)],
    );
    tick(world, 32 * DAY);
    await world.scanner.scan(TENANT_A);
    await world.scanner.scan(TENANT_A);
    const sla = world.slaStore.all(TENANT_A).filter((a) => a.kind.startsWith('sla_'));
    expect(sla.map((a) => `${a.kind}:${a.cycle}`)).toEqual(['sla_warning:2']);
    const rows = await world.slaStore.cycles(TENANT_A, [incident.id]);
    expect(rows.map((row) => [row.cycle, row.startedAt])).toEqual([
      [1, REPORTED_AT],
      [2, day20],
    ]);
  });
});

describe('end of the SLA (acceptance 7)', () => {
  it('asks for no SLA notice once the cycle is resolved', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, { ...assigned, status: 'under_review' });
    const day10 = at(REPORTED_AT, 10 * DAY).toISOString();
    await put(world, incident, { status: 'resolved', resolvedAt: day10, updatedAt: day10 });
    tick(world, 40 * DAY);
    await world.scanner.scan(TENANT_A);
    expect(world.slaStore.all(TENANT_A).filter((a) => a.kind.startsWith('sla_'))).toHaveLength(0);
  });

  it.each(['closed', 'cancelled', 'draft'] as const)(
    'asks for no notice at all in %s',
    async (status) => {
      const world = slaWorld();
      const incident = await reportedCase(world);
      await put(world, incident, { status });
      tick(world, 60 * DAY);
      expect(await world.scanner.scan(TENANT_A)).toEqual({ examined: 0, created: 0 });
      expect(await world.scanner.scan(TENANT_A, incident.id)).toEqual({ examined: 0, created: 0 });
      expect(world.slaStore.all(TENANT_A)).toHaveLength(0);
    },
  );
});

describe('assignment notice', () => {
  it('writes one notice per case version for the new responsible', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, assigned);
    expect(await world.scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 4 })).toBe(
      true,
    );
    expect(await world.scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 4 })).toBe(
      false,
    );
    expect(await world.scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 5 })).toBe(
      true,
    );
    expect(world.slaStore.all(TENANT_A).map((a) => [a.kind, a.dedupeRef, a.subjectId])).toEqual([
      ['assigned', 'v4', MANAGER.id],
      ['assigned', 'v5', MANAGER.id],
    ]);
  });

  it('writes nothing for a missing, foreign, draft, terminal or unassigned case', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world);
    expect(await world.scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 1 })).toBe(
      false,
    );
    expect(await world.scanner.onAssigned(TENANT_A, { incidentId: 'nope', version: 1 })).toBe(
      false,
    );
    expect(await world.scanner.onAssigned(TENANT_B, { incidentId: incident.id, version: 1 })).toBe(
      false,
    );
    const current = (await world.store.get(TENANT_A, incident.id))!;
    for (const status of ['draft', 'closed', 'cancelled'] as const) {
      await put(world, (await world.store.get(TENANT_A, incident.id)) ?? current, {
        status,
        ...assigned,
      });
      expect(
        await world.scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 1 }),
      ).toBe(false);
    }
    expect(world.slaStore.all(TENANT_A)).toHaveLength(0);
  });
});

describe('isolation and atomicity (acceptance 10 and 12)', () => {
  it('never reads or writes another tenant', async () => {
    const world = slaWorld();
    await reportedCase(world);
    const foreign = await world.cases.create(TENANT_B, MANAGER, {
      ...COMPLETE,
      driverId: 'driver-b',
    });
    await put(world, foreign, { status: 'reported', reportedAt: REPORTED_AT, severity: 'high' }, [
      reportEntry(REPORTED_AT),
    ]);
    tick(world, 30 * DAY);
    await world.scanner.scan(TENANT_A);
    expect(world.slaStore.all(TENANT_B)).toHaveLength(0);
    expect(world.slaStore.all(TENANT_A).length).toBeGreaterThan(0);
    // A scan of A cannot be pointed at the case of B by id.
    expect(await world.scanner.scan(TENANT_A, foreign.id)).toEqual({ examined: 0, created: 0 });
    await world.scanner.scan(TENANT_B);
    expect(world.slaStore.all(TENANT_B).length).toBeGreaterThan(0);
    expect(world.slaStore.all(TENANT_A).every((a) => a.tenantId === TENANT_A)).toBe(true);
  });

  it('keeps no notice when the event cannot be written, and writes it once on the next scan', async () => {
    const world = slaWorld();
    await reportedCase(world, assigned);
    tick(world, 12 * DAY);
    world.flags.failEmit = true;
    await expect(world.scanner.scan(TENANT_A)).rejects.toThrow('outbox down');
    expect(world.slaStore.all(TENANT_A)).toHaveLength(0);
    world.flags.failEmit = false;
    await world.scanner.scan(TENANT_A);
    await world.scanner.scan(TENANT_A);
    expect(count(world, 'sla_warning')).toBe(1);
    expect(world.events.filter((e) => e.payload['kind'] === 'sla_warning')).toHaveLength(1);
  });

  it('fails closed when the settings cannot be read', async () => {
    const world = slaWorld();
    await reportedCase(world);
    world.slaSettings.fail = true;
    await expect(world.scanner.scan(TENANT_A)).rejects.toThrow('settings unavailable');
  });

  it('pages through the tenant without loading every case at once', async () => {
    const world = slaWorld();
    for (let n = 0; n < 205; n += 1) await reportedCase(world, assigned);
    tick(world, 12 * DAY);
    const seen: number[] = [];
    const list = world.store.list.bind(world.store);
    world.store.list = async (tenantId, query) => {
      const page = await list(tenantId, query);
      seen.push(page.items.length);
      return page;
    };
    const summary = await world.scanner.scan(TENANT_A);
    expect(summary.examined).toBe(205);
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    expect(seen).toEqual([100, 100, 5]);
    expect(count(world, 'sla_warning')).toBe(205);
  });
});

describe('scan job queue', () => {
  it('hands the store the scan job as an event with its own id, for one case or for all', async () => {
    const world = slaWorld();
    await world.slaStore.enqueueScan({ tenantId: TENANT_A, jobId: 'job-1', at: REPORTED_AT });
    await world.slaStore.enqueueScan({
      tenantId: TENANT_A,
      jobId: 'job-2',
      incidentId: 'inc-1',
      at: REPORTED_AT,
    });
    expect(world.events).toEqual([
      {
        tenantId: TENANT_A,
        type: 'incident.sla.scan',
        payload: {},
        eventId: 'scan-job-1',
        entityId: TENANT_A,
        occurredAt: REPORTED_AT,
      },
      {
        tenantId: TENANT_A,
        type: 'incident.sla.scan',
        payload: { incidentId: 'inc-1' },
        eventId: 'scan-job-2',
        entityId: 'inc-1',
        occurredAt: REPORTED_AT,
      },
    ]);
  });
  it('refuses a job that is not made of opaque ids', async () => {
    const world = slaWorld();
    for (const job of [{ jobId: '' }, { jobId: 'job 1' }, { jobId: 'job-1', incidentId: '../x' }])
      await expect(
        world.slaStore.enqueueScan({ tenantId: TENANT_A, at: REPORTED_AT, ...job }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(world.events).toEqual([]);
  });
});
