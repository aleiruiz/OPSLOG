import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMaintenancePlanStore,
  MaintenancePlanError,
  MaintenancePlanService,
  type PlanScheduleReader,
} from './index.js';

const input = { vehicleId: 'vehicle-a', intervalDays: 30, lastServiceDate: '2026-01-01' };
const fixedNow = () => new Date('2026-02-01T00:00:00.000Z');
const service = (
  store = new InMemoryMaintenancePlanStore(),
  extra: ConstructorParameters<typeof MaintenancePlanService>[1] = {},
) =>
  new MaintenancePlanService(store, {
    now: fixedNow,
    newId: () => 'plan-a',
    ...extra,
  });

describe('MaintenancePlanService', () => {
  it('validates identifiers, references and actor before creating the plan', async () => {
    const vehicleExists = vi.fn(async () => true);
    const validateAssignments = vi.fn(async () => undefined);
    const plans = service(undefined, { references: { vehicleExists, validateAssignments } });
    const created = await plans.create('tenant-a', 'actor-a', input);
    expect(created).toMatchObject({ id: 'plan-a', tenantId: 'tenant-a', vehicleId: 'vehicle-a' });
    expect(vehicleExists).toHaveBeenCalledWith('tenant-a', 'vehicle-a');
    expect(validateAssignments).toHaveBeenCalledWith('tenant-a', null, null);
    await expect(plans.create('tenant-a', 'actor with spaces', input)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const missingVehicle = service(undefined, {
      references: { vehicleExists: async () => false, validateAssignments },
    });
    await expect(missingVehicle.create('tenant-a', 'actor-a', input)).rejects.toMatchObject({
      code: 'not_found',
    });
    const invalidAssignment = service(undefined, {
      references: {
        vehicleExists: async () => true,
        validateAssignments: async () => {
          throw new MaintenancePlanError('invalid_association');
        },
      },
    });
    await expect(invalidAssignment.create('tenant-a', 'actor-a', input)).rejects.toMatchObject({
      code: 'invalid_association',
    });
  });

  it('gets and lists only the tenant plan, with a uniform not-found error', async () => {
    const plans = service();
    const created = await plans.create('tenant-a', 'actor-a', input);
    expect(await plans.get('tenant-a', created.id)).toEqual(created);
    expect(await plans.list('tenant-a')).toEqual([created]);
    expect(await plans.list('tenant-b')).toEqual([]);
    await expect(plans.get('tenant-b', created.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(plans.get('tenant-a', 'bad id')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('returns derived schedule and empty orders without a schedule reader', async () => {
    const plans = service();
    const created = await plans.create('tenant-a', 'actor-a', input);
    expect(await plans.getSchedule('tenant-a', created.id)).toEqual({
      planId: created.id,
      nextTargetDate: '2026-01-31',
      nextTargetKm: null,
      occurrence: null,
      order: null,
    });
    expect(await plans.listScheduledOrders('tenant-a', created.id)).toEqual([]);
  });

  it('uses the injected schedule reader only after resolving the tenant-owned plan', async () => {
    const reader: PlanScheduleReader = {
      readSchedule: async (tenantId, planId) => ({
        planId: `${tenantId}:${planId}`,
        nextTargetDate: null,
        nextTargetKm: null,
        occurrence: null,
        order: null,
      }),
      listScheduledOrders: async (tenantId, planId) => [
        {
          tenantId,
          id: 'order-a',
          occurrenceId: 'occurrence-a',
          planId,
          vehicleId: 'vehicle-a',
          status: 'scheduled',
          kind: 'preventive',
          snapshot: {},
          createdAt: fixedNow().toISOString(),
        },
      ],
    };
    const plans = service(undefined, { scheduleReader: reader });
    await plans.create('tenant-a', 'actor-a', input);
    expect(await plans.getSchedule('tenant-a', 'plan-a')).toMatchObject({
      planId: 'tenant-a:plan-a',
    });
    expect(await plans.listScheduledOrders('tenant-a', 'plan-a')).toMatchObject([
      { tenantId: 'tenant-a', planId: 'plan-a' },
    ]);
    await expect(plans.getSchedule('tenant-b', 'plan-a')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('updates with optimistic concurrency and rejects invalid patches before storage', async () => {
    const store = new InMemoryMaintenancePlanStore();
    const plans = service(store);
    const created = await plans.create('tenant-a', 'actor-a', input);
    await expect(
      plans.update('tenant-a', 'actor-a', created.id, 0, { intervalDays: 60 }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(plans.update('tenant-a', 'actor-a', created.id, 1, null)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      plans.update('tenant-a', 'actor-a', created.id, 1, { vehicleId: 'vehicle-b' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const updated = await plans.update('tenant-a', 'actor-a', created.id, 1, { intervalDays: 60 });
    expect(updated).toMatchObject({
      intervalDays: 60,
      version: 2,
      updatedAt: fixedNow().toISOString(),
    });
    await expect(
      plans.update('tenant-a', 'actor-a', created.id, 1, { intervalDays: 90 }),
    ).rejects.toMatchObject({
      code: 'stale_version',
    });
  });

  it('pauses and resumes using the current version and handles stale, missing and invalid requests', async () => {
    const plans = service();
    const created = await plans.create('tenant-a', 'actor-a', input);
    await expect(plans.pause('tenant-a', 'actor-a', created.id, 0)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(plans.pause('tenant-a', 'actor-a', created.id, 2)).rejects.toMatchObject({
      code: 'stale_version',
    });
    const paused = await plans.pause('tenant-a', 'actor-a', created.id, 1);
    expect(paused).toMatchObject({ state: 'paused', version: 2 });
    const active = await plans.resume('tenant-a', 'actor-a', created.id, 2);
    expect(active).toMatchObject({ state: 'active', version: 3 });
    await expect(plans.resume('tenant-a', 'actor-a', 'missing', 3)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reports a compare-and-swap conflict returned by the store', async () => {
    const store = new InMemoryMaintenancePlanStore();
    const update = vi.spyOn(store, 'update').mockResolvedValue(false);
    const plans = service(store);
    const created = await plans.create('tenant-a', 'actor-a', input);
    await expect(plans.pause('tenant-a', 'actor-a', created.id, 1)).rejects.toMatchObject({
      code: 'stale_version',
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('lists alert records per tenant with validated paging and filters', async () => {
    const store = new InMemoryMaintenancePlanStore();
    const base = {
      planId: 'plan-a',
      occurrence: 1,
      planVersion: 1,
      kind: 'due' as const,
      trigger: 'date' as const,
      threshold: 'target' as const,
      targetDate: '2026-02-01',
      targetKm: null,
      odometerLastUpdatedAt: null,
      odometerAgeSeconds: null,
    };
    for (let i = 0; i < 3; i += 1)
      store.seedAlert({
        ...base,
        id: `alert-${i}`,
        tenantId: 'tenant-a',
        vehicleId: 'vehicle-a',
        occurredAt: `2026-02-0${i + 1}T00:00:00.000Z`,
      });
    store.seedAlert({
      ...base,
      id: 'alert-b',
      tenantId: 'tenant-b',
      planId: 'plan-b',
      vehicleId: 'vehicle-a',
      occurredAt: '2026-03-01T00:00:00.000Z',
    });
    const plans = service(store, { alertReader: store });
    await plans.create('tenant-a', 'actor-a', input);
    const page = await plans.listAlerts('tenant-a', { limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items.map((alert) => alert.id)).toEqual(['alert-2', 'alert-1']);
    expect((await plans.listAlerts('tenant-a', { limit: 2, offset: 2 })).items).toHaveLength(1);
    expect((await plans.listAlerts('tenant-a', { vehicleId: 'vehicle-z' })).total).toBe(0);
    expect((await plans.listAlerts('tenant-a', { planId: 'plan-a' })).total).toBe(3);
    expect((await plans.listAlerts('tenant-b', { vehicleId: 'vehicle-a' })).total).toBe(1);
    await expect(plans.listAlerts('tenant-b', { planId: 'plan-a' })).rejects.toMatchObject({
      code: 'not_found',
    });
    for (const bad of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: 1.5 }, { planId: 7 }])
      await expect(plans.listAlerts('tenant-a', bad)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    expect(await service().listAlerts('tenant-a', {})).toEqual({ items: [], total: 0 });
  });
});
