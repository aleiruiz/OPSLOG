import { describe, expect, it } from 'vitest';
import {
  calendarDay,
  evaluatePlan,
  MaintenancePlanService,
  InMemoryMaintenancePlanStore,
  type MaintenancePlan,
} from './index.js';

const plan = (overrides: Partial<MaintenancePlan> = {}): MaintenancePlan => ({
  id: 'plan-a',
  tenantId: 'tenant-a',
  vehicleId: 'vehicle-a',
  state: 'active',
  version: 1,
  intervalDays: 180,
  lastServiceDate: '2025-01-01',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...overrides,
});

describe('tenant calendar day (G3 M4)', () => {
  // Target date 2026-10-13: lastServiceDate 2026-09-13 plus 30 days.
  const p = plan({ intervalDays: 30, lastServiceDate: '2026-09-13' });
  const scan = (now: string, timeZone?: string) =>
    evaluatePlan(p, {
      now: new Date(now),
      odometer: { km: 0, updatedAt: null },
      occurrence: 1,
      ...(timeZone ? { timeZone } : {}),
    }).map((event) => [event.kind, event.threshold]);

  it('computes the calendar day in the IANA zone and defaults to UTC', () => {
    const instant = new Date('2026-10-13T00:30:00Z');
    expect(calendarDay(instant)).toBe('2026-10-13');
    expect(calendarDay(instant, 'UTC')).toBe('2026-10-13');
    expect(calendarDay(instant, 'America/Mexico_City')).toBe('2026-10-12');
    expect(calendarDay(new Date('2026-10-12T12:00:00Z'), 'Pacific/Auckland')).toBe('2026-10-13');
    // 18:30 local on the 12th, the instant the audit named, and 18:00 local exactly.
    expect(calendarDay(new Date('2026-10-13T00:00:00Z'), 'America/Mexico_City')).toBe('2026-10-12');
    expect(calendarDay(new Date('2026-10-13T06:00:00Z'), 'America/Mexico_City')).toBe('2026-10-13');
  });

  it('does not report a due date a day early for a zone behind UTC (America/Mexico_City 18:30)', () => {
    expect(scan('2026-10-13T00:30:00Z')).toEqual([['due', 'target']]);
    expect(scan('2026-10-13T00:30:00Z', 'America/Mexico_City')).toEqual([['upcoming', '15_days']]);
    expect(scan('2026-10-13T06:00:00Z', 'America/Mexico_City')).toEqual([['due', 'target']]);
  });

  it('reports a due date on the local day for a zone ahead of UTC', () => {
    expect(scan('2026-10-12T12:00:00Z')).toEqual([['upcoming', '15_days']]);
    expect(scan('2026-10-12T12:00:00Z', 'Pacific/Auckland')).toEqual([['due', 'target']]);
  });

  it('keeps the overdue boundary on the local calendar too', () => {
    const overdue = (now: string, timeZone?: string) =>
      evaluatePlan(p, {
        now: new Date(now),
        odometer: { km: 0, updatedAt: null },
        occurrence: 1,
        orderIncomplete: true,
        ...(timeZone ? { timeZone } : {}),
      }).map((event) => event.kind);
    expect(overdue('2026-10-14T00:30:00Z')).toEqual(['due', 'overdue']);
    expect(overdue('2026-10-14T00:30:00Z', 'America/Mexico_City')).toEqual(['due']);
  });
});

describe('maintenance plan rules', () => {
  it('uses UTC calendar days and creates upcoming at the inclusive threshold only', () => {
    const p = plan();
    const before = evaluatePlan(p, {
      now: new Date('2025-06-14T23:59:59Z'),
      odometer: { km: 0, updatedAt: '2025-06-14T00:00:00Z' },
      occurrence: 1,
    });
    expect(before).toEqual([]);
    const at = evaluatePlan(p, {
      now: new Date('2025-06-15T00:00:00Z'),
      odometer: { km: 0, updatedAt: '2025-06-15T00:00:00Z' },
      occurrence: 1,
    });
    expect(at.map((event) => [event.kind, event.threshold])).toEqual([['upcoming', '15_days']]);
  });
  it('emits due on first scan at target and overdue only after target passed', () => {
    const p = plan();
    const due = evaluatePlan(p, {
      now: new Date('2025-06-30T00:00:00Z'),
      odometer: { km: 0, updatedAt: '2025-06-30T00:00:00Z' },
      occurrence: 1,
      orderIncomplete: true,
    });
    expect(due.map((event) => event.kind)).toEqual(['due']);
    const overdue = evaluatePlan(p, {
      now: new Date('2025-07-01T00:00:00Z'),
      odometer: { km: 0, updatedAt: '2025-07-01T00:00:00Z' },
      occurrence: 1,
      orderIncomplete: true,
    });
    expect(overdue.map((event) => event.kind)).toEqual(['due', 'overdue']);
  });
  it('fires due at the first reached dimension and suppresses later upcoming', () => {
    const p = plan({ intervalKm: 10000, lastServiceKm: 50000 });
    const events = evaluatePlan(p, {
      now: new Date('2025-06-30T00:00:00Z'),
      odometer: { km: 59500, updatedAt: '2025-06-29T00:00:00Z' },
      occurrence: 2,
    });
    expect(events.map((event) => event.kind)).toEqual(['due']);
    expect(events[0]?.trigger).toBe('date');
    expect(events[0]?.odometerAgeSeconds).toBeUndefined();
  });
  it('does not treat an untimestamped M2 odometer as a km reading but still evaluates date targets', () => {
    const { intervalDays, lastServiceDate, ...base } = plan();
    expect(intervalDays).toBe(180);
    expect(lastServiceDate).toBe('2025-01-01');
    const kmOnly: MaintenancePlan = { ...base, intervalKm: 10000, lastServiceKm: 50000 };
    expect(
      evaluatePlan(kmOnly, {
        now: new Date('2025-06-30T00:00:00Z'),
        odometer: { km: 60000, updatedAt: null },
        occurrence: 1,
      }),
    ).toEqual([]);
    const datePlan = plan();
    const events = evaluatePlan(datePlan, {
      now: new Date('2025-06-30T00:00:00Z'),
      odometer: { km: 60000, updatedAt: null },
      occurrence: 1,
    });
    expect(events.map((event) => event.kind)).toEqual(['due']);
    expect(events[0]).not.toHaveProperty('odometerLastUpdatedAt');
    expect(events[0]).not.toHaveProperty('odometerAgeSeconds');
  });
  it('uses the inclusive 500 km window, records odometer age and emits km overdue only when requested', () => {
    const { intervalDays, lastServiceDate, ...dateFields } = plan();
    expect(intervalDays).toBe(180);
    expect(lastServiceDate).toBe('2025-01-01');
    const kmOnly: MaintenancePlan = {
      ...dateFields,
      intervalKm: 10000,
      lastServiceKm: 50000,
    };
    const snapshot = {
      now: new Date('2025-06-01T00:00:00Z'),
      occurrence: 3,
    };
    expect(
      evaluatePlan(kmOnly, {
        ...snapshot,
        odometer: { km: 59499, updatedAt: '2025-05-31T23:00:00Z' },
      }),
    ).toEqual([]);
    const upcoming = evaluatePlan(kmOnly, {
      ...snapshot,
      odometer: { km: 59500, updatedAt: '2025-05-31T23:00:00Z' },
    });
    expect(upcoming).toMatchObject([
      { kind: 'upcoming', trigger: 'odometer', threshold: '500_km', odometerAgeSeconds: 3600 },
    ]);
    const exactlyDue = evaluatePlan(kmOnly, {
      ...snapshot,
      odometer: { km: 60000, updatedAt: '2025-05-31T23:00:00Z' },
      orderIncomplete: true,
    });
    expect(exactlyDue.map((event) => event.kind)).toEqual(['due']);
    const overdue = evaluatePlan(kmOnly, {
      ...snapshot,
      odometer: { km: 60001, updatedAt: '2025-05-31T23:00:00Z' },
      orderIncomplete: true,
    });
    expect(overdue.map((event) => event.kind)).toEqual(['due', 'overdue']);
    expect(overdue[0]).toMatchObject({ trigger: 'odometer', odometerAgeSeconds: 3600 });
    expect(
      evaluatePlan(kmOnly, {
        ...snapshot,
        odometer: { km: 60001, updatedAt: '2025-05-31T23:00:00Z' },
      }).map((event) => event.kind),
    ).toEqual(['due']);
  });
  it('does not evaluate paused plans and can emit both upcoming thresholds for a dual plan', () => {
    const dual = plan({ intervalKm: 10000, lastServiceKm: 50000 });
    expect(
      evaluatePlan(
        { ...dual, state: 'paused' },
        {
          now: new Date('2025-06-15T00:00:00Z'),
          odometer: { km: 59500, updatedAt: '2025-06-14T00:00:00Z' },
          occurrence: 1,
        },
      ),
    ).toEqual([]);
    expect(
      evaluatePlan(dual, {
        now: new Date('2025-06-15T00:00:00Z'),
        odometer: { km: 59500, updatedAt: '2025-06-14T00:00:00Z' },
        occurrence: 1,
      }).map((event) => [event.kind, event.threshold]),
    ).toEqual([
      ['upcoming', '15_days'],
      ['upcoming', '500_km'],
    ]);
  });
  it('persists versioned tenant-scoped CRUD with optimistic concurrency', async () => {
    const store = new InMemoryMaintenancePlanStore();
    const service = new MaintenancePlanService(store, {
      now: () => new Date('2025-01-01T00:00:00Z'),
      newId: () => 'plan-id',
    });
    const created = await service.create('tenant-a', 'actor-a', {
      vehicleId: 'vehicle-a',
      intervalDays: 180,
      lastServiceDate: '2025-01-01',
    });
    expect(
      await service.get('tenant-b', created.id).catch((error: unknown) => (error as Error).message),
    ).toContain('not_found');
    const paused = await service.pause('tenant-a', 'actor-a', created.id, 1);
    expect(paused.state).toBe('paused');
    await expect(service.resume('tenant-a', 'actor-a', created.id, 1)).rejects.toMatchObject({
      code: 'stale_version',
    });
    const updated = await service.update('tenant-a', 'actor-a', created.id, 2, {
      intervalDays: 90,
    });
    expect(updated).toMatchObject({
      intervalDays: 90,
      lastServiceDate: '2025-01-01',
      state: 'paused',
      version: 3,
    });
    await expect(
      service.update('tenant-a', 'actor-a', created.id, 3, { vehicleId: 'vehicle-b' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
