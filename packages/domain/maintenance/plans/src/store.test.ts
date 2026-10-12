import { describe, expect, it } from 'vitest';
import {
  InMemoryMaintenancePlanStore,
  MaintenancePlanError,
  type MaintenancePlan,
} from './index.js';

const plan = (tenantId = 'tenant-a', id = 'plan-a', version = 1): MaintenancePlan => ({
  id,
  tenantId,
  vehicleId: 'vehicle-a',
  state: 'active',
  intervalDays: 30,
  lastServiceDate: '2026-01-01',
  version,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('InMemoryMaintenancePlanStore', () => {
  it('clones returned values, rejects duplicate tenant keys and isolates tenant lists', async () => {
    const store = new InMemoryMaintenancePlanStore();
    const created = await store.create(plan(), 'actor-a');
    const returned = await store.get('tenant-a', 'plan-a');
    expect(returned).toEqual(created);
    expect(returned).not.toBe(created);
    await expect(store.create(plan(), 'actor-a')).rejects.toMatchObject({ code: 'duplicate' });
    await store.create(plan('tenant-b'), 'actor-b');
    expect((await store.list('tenant-a')).map((value) => value.tenantId)).toEqual(['tenant-a']);
    expect((await store.list('tenant-b')).map((value) => value.tenantId)).toEqual(['tenant-b']);
    expect(await store.get('tenant-b', 'missing')).toBeNull();
  });

  it('updates only at the expected version and exposes its deterministic sequence port', async () => {
    const store = new InMemoryMaintenancePlanStore();
    await expect(store.nextSequence('tenant-a', 'plan-a')).rejects.toMatchObject({
      code: 'not_found',
    });
    await store.create(plan(), 'actor-a');
    expect(await store.nextSequence('tenant-a', 'plan-a')).toBe(1);
    expect(await store.update(plan('tenant-a', 'plan-a', 2), 1, 'actor-a')).toBe(true);
    expect(await store.update(plan('tenant-a', 'plan-a', 3), 1, 'actor-a')).toBe(false);
    expect((await store.get('tenant-a', 'plan-a'))?.version).toBe(2);
  });

  it('uses an unambiguous tenant and ID compound key', async () => {
    const store = new InMemoryMaintenancePlanStore();
    await store.create(plan('ab', 'c'), 'actor-a');
    await store.create(plan('a', 'bc'), 'actor-b');
    expect(await store.get('ab', 'c')).toMatchObject({ tenantId: 'ab', id: 'c' });
    expect(await store.get('a', 'bc')).toMatchObject({ tenantId: 'a', id: 'bc' });
    expect(new MaintenancePlanError('duplicate').code).toBe('duplicate');
  });
});
