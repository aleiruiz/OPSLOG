import { describe, expect, it } from 'vitest';
import { MaintenancePlanService } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import {
  InMemoryWorkshopStore,
  WorkshopService,
} from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import {
  InMemoryMechanicStore,
  MechanicService,
} from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { InMemoryMaintenancePlanStore } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import { MaintenanceApi } from './index.js';

describe('MaintenanceApi', () => {
  it('derives tenant and actor from the authorized session, hides tenant ids and enforces permissions', async () => {
    const workshops = new WorkshopService(new InMemoryWorkshopStore());
    const api = new MaintenanceApi({
      plans: new MaintenancePlanService(new InMemoryMaintenancePlanStore()),
      workshops,
      mechanics: new MechanicService(new InMemoryMechanicStore(), {
        workshops,
        isTenantMember: async () => true,
      }),
      authorize: async (token, correlationId, required) => {
        if (!['valid', 'view-only'].includes(token)) throw new Error('unauthorized');
        const granted = token === 'valid' ? ['create', 'view', 'edit'] : ['view'];
        if (!required.every((permission) => granted.includes(permission)))
          throw new Error('forbidden');
        return {
          tenantId: 'tenant-a',
          actor: { subject: 'member-a', kind: 'user' },
          authorizationVersion: 1,
          correlationId,
        };
      },
    });
    const result = await api.createPlan('valid', 'corr-a', {
      vehicleId: 'vehicle-a',
      intervalDays: 30,
      lastServiceDate: '2026-01-01',
    });
    expect(result).toMatchObject({ ok: true, value: { vehicleId: 'vehicle-a', version: 1 } });
    expect(result.value).not.toHaveProperty('tenantId');
    expect(
      await api.createPlan('invalid', 'corr-a', {
        vehicleId: 'vehicle-a',
        intervalDays: 30,
        lastServiceDate: '2026-01-01',
      }),
    ).toMatchObject({ ok: false, error: { status: 401, code: 'unauthorized' } });
    expect(
      await api.createPlan('view-only', 'corr-a', {
        vehicleId: 'vehicle-a',
        intervalDays: 30,
        lastServiceDate: '2026-01-01',
      }),
    ).toMatchObject({ ok: false, error: { status: 403, code: 'forbidden' } });
    expect(await api.updatePlan('valid', 'corr-a', 'missing', 1, {})).toMatchObject({
      ok: false,
      error: { status: 404, code: 'not_found' },
    });
    expect(
      await api.createPlan('valid', 'corr-a', {
        tenantId: 'tenant-b',
        vehicleId: 'vehicle-a',
        intervalDays: 30,
        lastServiceDate: '2026-01-01',
      }),
    ).toMatchObject({ ok: false, error: { status: 400, code: 'invalid_input' } });
  });

  it('lists alert records for view-only callers, from the session tenant, without tenant ids', async () => {
    const plans = new InMemoryMaintenancePlanStore();
    const record = {
      planId: 'plan-a',
      vehicleId: 'vehicle-a',
      occurrence: 1,
      planVersion: 1,
      kind: 'upcoming' as const,
      trigger: 'odometer' as const,
      threshold: '500_km' as const,
      targetDate: null,
      targetKm: 10_000,
      odometerLastUpdatedAt: '2026-10-10T00:00:00.000Z',
      odometerAgeSeconds: 172_800,
      occurredAt: '2026-10-12T00:00:00.000Z',
    };
    plans.seedAlert({ ...record, id: 'alert-a', tenantId: 'tenant-a' });
    plans.seedAlert({ ...record, id: 'alert-b', tenantId: 'tenant-b' });
    const workshops = new WorkshopService(new InMemoryWorkshopStore());
    const api = new MaintenanceApi({
      plans: new MaintenancePlanService(plans, { alertReader: plans }),
      workshops,
      mechanics: new MechanicService(new InMemoryMechanicStore(), {
        workshops,
        isTenantMember: async () => true,
      }),
      authorize: async (token, correlationId, required) => {
        if (token === 'none') throw new Error('unauthorized');
        if (token === 'no-view' && required.includes('view')) throw new Error('forbidden');
        return {
          tenantId: 'tenant-a',
          actor: { subject: 'member-a', kind: 'user' },
          authorizationVersion: 1,
          correlationId,
        };
      },
    });
    const listed = await api.listAlerts('view-only', 'corr', { limit: 25, offset: 0 });
    expect(listed).toMatchObject({
      ok: true,
      value: { total: 1, items: [{ id: 'alert-a', odometerAgeSeconds: 172_800 }] },
    });
    expect(JSON.stringify(listed)).not.toContain('tenant');
    expect(await api.listAlerts('none', 'corr', { limit: 25, offset: 0 })).toMatchObject({
      ok: false,
      error: { status: 401 },
    });
    expect(await api.listAlerts('no-view', 'corr', { limit: 25, offset: 0 })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(
      await api.listAlerts('view-only', 'corr', { planId: 'missing', limit: 25, offset: 0 }),
    ).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await api.listAlerts('view-only', 'corr', { limit: 500, offset: 0 })).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
  });
});
