import { describe, expect, it } from 'vitest';
import { InMemoryOutboxStore, backoffMs } from './index.js';

const input = (eventId: string, tenantId = 'tenant-a', key = eventId) => ({
  eventId,
  tenantId,
  type: 'demo',
  payload: { value: eventId },
  occurredAt: '2026-10-04T00:00:00.000Z',
  idempotencyKey: key,
});
describe('outbox atomicity and fencing', () => {
  it('rolls back callback failures and deduplicates event and idempotency keys', () => {
    const store = new InMemoryOutboxStore();
    expect(() =>
      store.transaction((tx) => {
        tx.enqueue(input('e1'));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(store.all()).toHaveLength(0);
    store.transaction((tx) => {
      tx.enqueue(input('e1'));
      tx.enqueue(input('e1'));
      tx.enqueue(input('e2', 'tenant-b', 'e1'));
    });
    expect(store.all()).toHaveLength(1);
  });
  it('claims each event once, reclaims expired leases, and rejects stale fences', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) => tx.enqueue(input('e1')));
    const now = Date.now();
    const first = store.claim(now, 10, 'w1')!;
    expect(store.claim(now, 10, 'w2')).toBeUndefined();
    expect(() => store.acknowledge('e1', first.fencing - 1)).toThrow('stale fencing');
    expect(store.reconcile(now + 11)).toBe(1);
    const second = store.claim(now + 11, 10, 'w2')!;
    expect(second.fencing).toBeGreaterThan(first.fencing);
    expect(() => store.retry('e1', first.fencing, 'old', now + 11, 3)).toThrow('stale fencing');
    store.acknowledge('e1', second.fencing);
    expect(store.get('e1')?.status).toBe('delivered');
  });
  it('backs off and moves repeated failures to dead letter', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) => tx.enqueue(input('e1')));
    const now = Date.now();
    const first = store.claim(now, 10, 'w')!;
    expect(store.retry('e1', first.fencing, 'x', now, 2)).toBe('retry');
    expect(store.get('e1')?.availableAt).toBe(now + backoffMs(1));
    const second = store.claim(now + backoffMs(1), 10, 'w')!;
    expect(store.retry('e1', second.fencing, 'x', now + backoffMs(1), 2)).toBe('dead_letter');
  });
});
