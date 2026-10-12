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

  it('D9: a mechanic-scoped caller reads only its own mechanic and workshop (no contact) and no plans', async () => {
    const workshopStore = new InMemoryWorkshopStore();
    const workshops = new WorkshopService(workshopStore);
    const mechanics = new MechanicService(new InMemoryMechanicStore(), {
      workshops,
      isTenantMember: async () => true,
    });
    const plans = new MaintenancePlanService(new InMemoryMaintenancePlanStore());
    const sessions: Record<string, { subject: string; perms: string[]; scoped: boolean }> = {
      fleet: { subject: 'fleet', perms: ['view', 'create', 'edit'], scoped: false },
      mech: { subject: 'mech', perms: ['view'], scoped: true },
      other: { subject: 'other', perms: ['view'], scoped: true },
    };
    const api = new MaintenanceApi({
      plans,
      workshops,
      mechanics,
      authorize: async (token, correlationId, required) => {
        const session = sessions[token];
        if (!session || !required.every((p) => session.perms.includes(p)))
          throw new Error('forbidden');
        return {
          tenantId: 'tenant-a',
          actor: { subject: session.subject, kind: 'user' },
          authorizationVersion: 1,
          correlationId,
        };
      },
      scope: async (context) => ({ scoped: sessions[context.actor.subject]?.scoped === true }),
    });
    const shop = await api.createWorkshop('fleet', 'c', {
      name: 'Taller A',
      specialties: [],
      contact: 'tel 555',
    });
    const otherShop = await api.createWorkshop('fleet', 'c', {
      name: 'Taller B',
      specialties: [],
      contact: null,
    });
    const own = await api.createMechanic('fleet', 'c', {
      name: 'Mecánico',
      specialties: [],
      contact: 'tel 777',
      kind: 'internal',
      workshopId: shop.value?.id,
      memberId: 'mech',
    });
    const foreign = await api.createMechanic('fleet', 'c', {
      name: 'Otro',
      specialties: [],
      contact: 'tel 888',
      kind: 'internal',
      workshopId: otherShop.value?.id,
      memberId: 'other',
    });
    const plan = await api.createPlan('fleet', 'c', {
      vehicleId: 'vehicle-a',
      intervalDays: 30,
      lastServiceDate: '2026-01-01',
    });
    const planId = plan.value?.id as string;
    expect((await api.listPlans('fleet', 'c')).value).toHaveLength(1);
    expect((await api.listMechanics('fleet', 'c')).value).toHaveLength(2);
    expect((await api.listWorkshops('fleet', 'c')).value).toHaveLength(2);

    expect((await api.listPlans('mech', 'c')).value).toEqual([]);
    for (const result of [
      await api.getPlan('mech', 'c', planId),
      await api.getPlanSchedule('mech', 'c', planId),
      await api.listScheduledOrders('mech', 'c', planId),
      await api.getMechanic('mech', 'c', foreign.value?.id as string),
      await api.getWorkshop('mech', 'c', otherShop.value?.id as string),
    ])
      expect(result).toMatchObject({ ok: false, error: { status: 404 } });
    expect((await api.listMechanics('mech', 'c')).value?.map((m) => m.id)).toEqual([own.value?.id]);
    expect((await api.getMechanic('mech', 'c', own.value?.id as string)).ok).toBe(true);
    const visible = (await api.listWorkshops('mech', 'c')).value ?? [];
    expect(visible.map((w) => w.id)).toEqual([shop.value?.id]);
    expect(visible[0]?.contact).toBeNull();
    expect(
      (await api.getWorkshop('mech', 'c', shop.value?.id as string)).value?.contact,
    ).toBeNull();
    expect(await api.createPlan('mech', 'c', {})).toMatchObject({ error: { status: 403 } });
  });
});
