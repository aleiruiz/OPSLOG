import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore } from '../../../../packages/platform/audit/src/index.js';
import { InMemoryOutboxStore } from '../../../../packages/platform/outbox/src/index.js';
import { Worker } from './index.js';

const setup = (status: 'active' | 'missing' | 'suspended') => {
  const store = new InMemoryOutboxStore();
  store.transaction((tx) =>
    tx.enqueue({
      eventId: 'e1',
      tenantId: 'tenant-a',
      type: 'demo',
      payload: { secret: 'not-for-dlq' },
      occurredAt: '2026-10-04T00:00:00.000Z',
      idempotencyKey: 'k1',
    }),
  );
  const audit = new InMemoryAuditStore();
  const worker = new Worker(store, { status: () => status }, audit, 'worker-a', 10, 1);
  return { store, audit, worker };
};
describe('worker tenant, handler and DLQ controls', () => {
  it.each(['missing', 'suspended'] as const)(
    'rejects %s tenants without invoking a handler',
    async (status) => {
      const { worker, store } = setup(status);
      let called = false;
      worker.register('demo', () => {
        called = true;
      });
      await worker.process(Date.now());
      expect(called).toBe(false);
      expect(store.get('e1')?.status).toBe('dead_letter');
      expect(worker.dlq.receive()?.body).toEqual({
        eventId: 'e1',
        tenantId: 'tenant-a',
        reason: 'tenant unavailable',
      });
    },
  );
  it('redacts handler errors and audits successful delivery', async () => {
    const first = setup('active');
    first.worker.register('demo', () => {
      throw new Error('token=Bearer secret-value');
    });
    await first.worker.process(Date.now());
    expect(first.store.get('e1')?.lastError).not.toContain('secret-value');
    const second = setup('active');
    second.worker.register('demo', () => undefined);
    await second.worker.process(Date.now());
    expect(second.store.get('e1')?.status).toBe('delivered');
    expect(second.audit.list('tenant-a')).toHaveLength(1);
  });
});
