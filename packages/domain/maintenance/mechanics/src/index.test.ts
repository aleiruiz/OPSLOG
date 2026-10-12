import { describe, expect, it } from 'vitest';
import { InMemoryMechanicStore, MechanicService } from './index.js';

describe('mechanic catalogue', () => {
  it('requires tenant membership for internal mechanics and records delegated external actor', async () => {
    const workshops = { get: async () => null };
    const service = new MechanicService(
      new InMemoryMechanicStore(),
      {
        workshops,
        isTenantMember: async (tenant, member) => tenant === 'tenant-a' && member === 'member-a',
      },
      () => new Date('2025-01-01Z'),
      () => 'mechanic-a',
    );
    await expect(
      service.create('tenant-a', 'actor-a', {
        name: 'Internal',
        specialties: [],
        kind: 'internal',
        memberId: 'member-b',
      }),
    ).rejects.toThrow('invalid_association');
    const external = await service.create('tenant-a', 'actor-a', {
      name: 'External',
      specialties: [],
      kind: 'external',
    });
    expect(external.registeredBy).toBe('actor-a');
    expect(external.memberId).toBeNull();
  });
});
