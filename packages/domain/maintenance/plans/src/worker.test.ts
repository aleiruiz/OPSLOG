import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMaintenancePlanStore,
  MaintenancePlanWorker,
  MaintenancePlanService,
  type PlanScanStore,
} from './index.js';

const stubs = () => ({
  reopenPreventive: vi.fn(async () => undefined),
  cancelPreventive: vi.fn(async () => undefined),
  adoptPreventive: vi.fn(async () => undefined),
  baselineBeforeClosure: vi.fn(async () => null),
});
const input = { vehicleId: 'vehicle-a', intervalDays: 30, lastServiceDate: '2026-01-01' };

describe('MaintenancePlanWorker', () => {
  it('reads the owned vehicle and scan snapshot, and forwards closure events', async () => {
    const plans = new InMemoryMaintenancePlanStore();
    const service = new MaintenancePlanService(plans, { newId: () => 'plan-a' });
    await service.create('tenant-a', 'actor-a', input);
    const scans: PlanScanStore = {
      scan: vi.fn(async (_tenantId, _planId, _now, _odometer) => []),
      closePreventive: vi.fn(async () => undefined),
      ...stubs(),
    };
    const worker = new MaintenancePlanWorker(
      plans,
      scans,
      {
        read: async () => ({
          id: 'vehicle-a',
          odometer: { km: 123, updatedAt: '2026-01-30T00:00:00Z' },
        }),
      },
      () => new Date('2026-01-31T00:00:00Z'),
    );
    expect(await worker.scan('tenant-a', 'plan-a')).toEqual([]);
    expect(scans.scan).toHaveBeenCalledWith(
      'tenant-a',
      'plan-a',
      new Date('2026-01-31T00:00:00Z'),
      { km: 123, updatedAt: '2026-01-30T00:00:00Z' },
      'UTC',
    );
    // The scan judges calendar days in the zone of the company (SPECS:184).
    const zoned = new MaintenancePlanWorker(
      plans,
      scans,
      { read: async () => ({ id: 'vehicle-a', odometer: { km: 1, updatedAt: null } }) },
      () => new Date('2026-01-31T00:00:00Z'),
      async (tenantId) => (tenantId === 'tenant-a' ? 'America/Mexico_City' : 'UTC'),
    );
    await zoned.scan('tenant-a', 'plan-a');
    expect(scans.scan).toHaveBeenLastCalledWith(
      'tenant-a',
      'plan-a',
      new Date('2026-01-31T00:00:00Z'),
      { km: 1, updatedAt: null },
      'America/Mexico_City',
    );
    const event = {
      tenantId: 'tenant-a',
      planId: 'plan-a',
      occurrenceId: 'occurrence-a',
      orderId: 'order-a',
      kind: 'preventive' as const,
      eventId: 'event-a',
      completedAt: '2026-01-31T00:00:00Z',
      actualDate: '2026-01-31',
      actualKm: 123,
    };
    await worker.consumeClosure(event);
    expect(scans.closePreventive).toHaveBeenCalledWith(event);
    const lifecycle = {
      tenantId: 'tenant-a',
      planId: 'plan-a',
      occurrenceId: 'occurrence-a',
      orderId: 'order-a',
      eventId: 'event-b',
      version: 7,
    };
    await worker.consumeReopened(lifecycle);
    await worker.consumeCancelled(lifecycle);
    await worker.consumeAdopted(lifecycle);
    expect(scans.reopenPreventive).toHaveBeenCalledWith(lifecycle);
    expect(scans.cancelPreventive).toHaveBeenCalledWith(lifecycle);
    expect(scans.adoptPreventive).toHaveBeenCalledWith(lifecycle);
  });

  it('rejects missing plans, missing vehicles and mismatched vehicle identity uniformly', async () => {
    const plans = new InMemoryMaintenancePlanStore();
    const service = new MaintenancePlanService(plans, { newId: () => 'plan-a' });
    await service.create('tenant-a', 'actor-a', input);
    const noVehicle = new MaintenancePlanWorker(
      plans,
      { scan: vi.fn(), closePreventive: vi.fn(), ...stubs() },
      {
        read: async () => null,
      },
    );
    await expect(noVehicle.scan('tenant-a', 'plan-a')).rejects.toMatchObject({ code: 'not_found' });
    const wrongVehicle = new MaintenancePlanWorker(
      plans,
      { scan: vi.fn(), closePreventive: vi.fn(), ...stubs() },
      { read: async () => ({ id: 'vehicle-b', odometer: { km: 1, updatedAt: null } }) },
    );
    await expect(wrongVehicle.scan('tenant-a', 'plan-a')).rejects.toMatchObject({
      code: 'not_found',
    });
    const missingPlan = new MaintenancePlanWorker(
      plans,
      { scan: vi.fn(), closePreventive: vi.fn(), ...stubs() },
      { read: async () => null },
    );
    await expect(missingPlan.scan('tenant-b', 'plan-a')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
