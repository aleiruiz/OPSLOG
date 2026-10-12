import { describe, expect, it } from 'vitest';
import { InMemoryWorkshopStore, WorkshopService } from './index.js';

describe('workshop catalogue', () => {
  it('keeps records tenant scoped and deactivates without deleting history', async () => {
    const service = new WorkshopService(
      new InMemoryWorkshopStore(),
      () => new Date('2025-01-01Z'),
      () => 'shop-a',
    );
    const created = await service.create('tenant-a', 'actor-a', {
      name: 'Central',
      specialties: ['Engine'],
      contact: null,
    });
    expect(
      await service.get('tenant-b', created.id).catch((error: unknown) => (error as Error).message),
    ).toBe('not_found');
    expect((await service.deactivate('tenant-a', 'actor-a', created.id)).active).toBe(false);
    expect(await service.list('tenant-a')).toHaveLength(1);
  });
});
