import { describe, expect, it } from 'vitest';
import {
  InMemoryMechanicStore,
  type Mechanic,
} from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { createMechanicScope } from './mechanic-scope.js';

const mechanic = (values: Partial<Mechanic>): Mechanic => ({
  id: 'm1',
  tenantId: 't',
  name: 'M',
  specialties: [],
  contact: null,
  kind: 'internal',
  workshopId: null,
  memberId: 'mem',
  registeredBy: 'user-admin',
  active: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...values,
});

describe('createMechanicScope', () => {
  it('keeps a member scoped (linked, no active ids) after the mechanic is deactivated', async () => {
    const store = new InMemoryMechanicStore();
    await store.create(mechanic({}), 'a');
    await store.create(mechanic({ id: 'ext', kind: 'external', memberId: null }), 'a');
    const scope = createMechanicScope(store);
    expect(await scope.mechanicIdsOfMember('t', 'mem')).toEqual(['m1']);
    expect(await scope.mechanicLinked('t', 'mem')).toBe(true);
    await store.update(mechanic({ active: false }), 'a');
    expect(await scope.mechanicIdsOfMember('t', 'mem')).toEqual([]);
    expect(await scope.mechanicLinked('t', 'mem')).toBe(true);
    expect(await scope.mechanicLinked('t', 'nobody')).toBe(false);
    expect(await scope.mechanicLinked('other-tenant', 'mem')).toBe(false);
  });
});
