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
      tx.enqueue(input('e1', 'tenant-a', 'different-idempotency-key'));
      tx.enqueue(input('e1', 'tenant-b', 'e1'));
      tx.enqueue(input('e2', 'tenant-a', 'e1'));
    });
    expect(store.all()).toHaveLength(3);
    expect(
      store
        .all()
        .map((record) => record.tenantId)
        .sort(),
    ).toEqual(['tenant-a', 'tenant-a', 'tenant-b']);
    expect(store.get('tenant-a', 'e1')?.tenantId).toBe('tenant-a');
    expect(store.get('tenant-b', 'e1')?.tenantId).toBe('tenant-b');
  });
  it('claims each event once, reclaims expired leases, and rejects stale fences', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) => tx.enqueue(input('e1')));
    const now = Date.now();
    const first = store.claim(now, 10, 'w1')!;
    expect(store.claim(now, 10, 'w2')).toBeUndefined();
    expect(() => store.acknowledge('tenant-a', 'e1', first.fencing - 1)).toThrow('stale fencing');
    expect(store.reconcile(now + 11)).toBe(1);
    const second = store.claim(now + 11, 10, 'w2')!;
    expect(second.fencing).toBeGreaterThan(first.fencing);
    expect(() => store.retry('tenant-a', 'e1', first.fencing, 'old', now + 11, 3)).toThrow(
      'stale fencing',
    );
    store.markHandlerCompleted('tenant-a', 'e1', second.fencing);
    store.acknowledge('tenant-a', 'e1', second.fencing);
    expect(store.get('tenant-a', 'e1')?.status).toBe('delivered');
  });
  it('ignores caller supplied delivery, lease and fencing fields during enqueue', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) =>
      tx.enqueue({
        ...input('forged'),
        status: 'delivered',
        attempts: 99,
        availableAt: 0,
        leaseUntil: Number.MAX_SAFE_INTEGER,
        fencing: 900,
        handlerCompleted: true,
      } as never),
    );
    const claimed = store.claim(Date.now(), 100, 'worker');
    expect(claimed?.record.status).toBe('processing');
    expect(claimed?.record.attempts).toBe(1);
    expect(claimed?.record.fencing).toBe(1);
    expect(claimed?.record).not.toHaveProperty('handlerCompleted');
    expect(claimed?.record.leaseUntil).toBe(claimed?.leaseUntil);
  });
  it('backs off and moves repeated failures to dead letter', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) => tx.enqueue(input('e1')));
    const now = Date.now();
    const first = store.claim(now, 10, 'w')!;
    expect(store.retry('tenant-a', 'e1', first.fencing, 'x', now, 2)).toBe('retry');
    expect(store.get('tenant-a', 'e1')?.availableAt).toBe(now + backoffMs(1));
    const second = store.claim(now + backoffMs(1), 10, 'w')!;
    expect(store.retry('tenant-a', 'e1', second.fencing, 'x', now + backoffMs(1), 2)).toBe(
      'dead_letter',
    );
  });
  it('makes acknowledgement and retry idempotent for the same fencing token', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) => tx.enqueue(input('e1')));
    const now = Date.now();
    const claim = store.claim(now, 10, 'w')!;
    expect(store.retry('tenant-a', 'e1', claim.fencing, 'temporary', now, 5)).toBe('retry');
    expect(store.retry('tenant-a', 'e1', claim.fencing, 'temporary', now, 5)).toBe('retry');
    const next = store.claim(now + 1000, 10, 'w')!;
    store.markHandlerCompleted('tenant-a', 'e1', next.fencing);
    store.acknowledge('tenant-a', 'e1', next.fencing);
    expect(() => store.acknowledge('tenant-a', 'e1', next.fencing)).not.toThrow();
  });
});
