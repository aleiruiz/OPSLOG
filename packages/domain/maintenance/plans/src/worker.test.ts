import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMaintenancePlanStore,
  MaintenancePlanWorker,
  MaintenancePlanService,
  type PlanScanStore,
} from './index.js';

const input = { vehicleId: 'vehicle-a', intervalDays: 30, lastServiceDate: '2026-01-01' };

describe('MaintenancePlanWorker', () => {
  it('reads the owned vehicle and scan snapshot, and forwards closure events', async () => {
    const plans = new InMemoryMaintenancePlanStore();
    const service = new MaintenancePlanService(plans, { newId: () => 'plan-a' });
    await service.create('tenant-a', 'actor-a', input);
    const scans: PlanScanStore = {
      scan: vi.fn(async (_tenantId, _planId, _now, _odometer) => []),
      closePreventive: vi.fn(async () => undefined),
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
  });

  it('rejects missing plans, missing vehicles and mismatched vehicle identity uniformly', async () => {
    const plans = new InMemoryMaintenancePlanStore();
    const service = new MaintenancePlanService(plans, { newId: () => 'plan-a' });
    await service.create('tenant-a', 'actor-a', input);
    const noVehicle = new MaintenancePlanWorker(
      plans,
      { scan: vi.fn(), closePreventive: vi.fn() },
      {
        read: async () => null,
      },
    );
    await expect(noVehicle.scan('tenant-a', 'plan-a')).rejects.toMatchObject({ code: 'not_found' });
    const wrongVehicle = new MaintenancePlanWorker(
      plans,
      { scan: vi.fn(), closePreventive: vi.fn() },
      { read: async () => ({ id: 'vehicle-b', odometer: { km: 1, updatedAt: null } }) },
    );
    await expect(wrongVehicle.scan('tenant-a', 'plan-a')).rejects.toMatchObject({
      code: 'not_found',
    });
    const missingPlan = new MaintenancePlanWorker(
      plans,
      { scan: vi.fn(), closePreventive: vi.fn() },
      { read: async () => null },
    );
    await expect(missingPlan.scan('tenant-b', 'plan-a')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
