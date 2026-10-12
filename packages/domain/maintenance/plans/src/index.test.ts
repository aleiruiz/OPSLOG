import { describe, expect, it } from 'vitest';
import {
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
