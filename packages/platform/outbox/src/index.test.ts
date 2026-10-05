import { describe, expect, it } from 'vitest';
import { InMemoryOutboxStore, OutboxConflictError, backoffMs } from './index.js';

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
    const store = new InMemoryOutboxStore(Date.now, () => 0.5);
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
    const store = new InMemoryOutboxStore(Date.now, () => 0.5);
    store.transaction((tx) => tx.enqueue(input('e1')));
    const now = Date.now();
    const claim = store.claim(now, 10, 'w')!;
    expect(store.retry('tenant-a', 'e1', claim.fencing, 'temporary', now, 5)).toBe('retry');
    expect(store.retry('tenant-a', 'e1', claim.fencing, 'temporary', now, 5)).toBe('retry');
    const next = store.claim(now + backoffMs(1), 10, 'w')!;
    store.markHandlerCompleted('tenant-a', 'e1', next.fencing);
    store.acknowledge('tenant-a', 'e1', next.fencing);
    expect(() => store.acknowledge('tenant-a', 'e1', next.fencing)).not.toThrow();
  });
  it('rejects async transaction work instead of committing before it settles', async () => {
    const store = new InMemoryOutboxStore();
    expect(() =>
      store.transaction(async (tx) => {
        tx.enqueue(input('async-e'));
        await Promise.resolve();
        throw new Error('late failure');
      }),
    ).toThrow('synchronous');
    await Promise.resolve();
    expect(store.all()).toHaveLength(0);
  });
  it('closes the transaction handle after commit or rollback', () => {
    const store = new InMemoryOutboxStore();
    let leaked: Parameters<Parameters<typeof store.transaction>[0]>[0] | undefined;
    store.transaction((tx) => {
      leaked = tx;
    });
    expect(() => leaked?.enqueue(input('late'))).toThrow('closed');
    expect(store.all()).toHaveLength(0);
  });
  it('uses the injected clock for availability', () => {
    const store = new InMemoryOutboxStore(() => 5_000);
    store.transaction((tx) => tx.enqueue(input('clocked')));
    expect(store.claim(4_999, 10, 'w')).toBeUndefined();
    expect(store.claim(5_000, 10, 'w')?.record.eventId).toBe('clocked');
  });
  it('rejects event and tenant ids that are not opaque identifiers', () => {
    const store = new InMemoryOutboxStore();
    for (const eventId of ['order/1', 'jane@example.test', '', 'x'.repeat(200)])
      expect(() => store.transaction((tx) => tx.enqueue(input(eventId)))).toThrow('opaque');
    expect(() => store.transaction((tx) => tx.enqueue(input('ok', ' ')))).toThrow('opaque');
    expect(store.all()).toHaveLength(0);
  });
  it('rejects reusing an event id for a different type or payload', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) => tx.enqueue(input('e1')));
    expect(() =>
      store.transaction((tx) => tx.enqueue({ ...input('e1'), payload: { value: 'other' } })),
    ).toThrow(OutboxConflictError);
    expect(() => store.transaction((tx) => tx.enqueue({ ...input('e1'), type: 'other' }))).toThrow(
      OutboxConflictError,
    );
    expect(() => store.transaction((tx) => tx.enqueue(input('e1')))).not.toThrow();
    expect(store.all()).toHaveLength(1);
  });
  it('treats an identical replay with a non-plain payload as the same event', () => {
    const store = new InMemoryOutboxStore();
    const payload = Object.assign(Object.create(null) as object, { value: 'e1' });
    store.transaction((tx) => tx.enqueue({ ...input('e1'), payload }));
    expect(() => store.transaction((tx) => tx.enqueue({ ...input('e1'), payload }))).not.toThrow();
  });
  it('rejects nested transactions so an inner commit cannot outlive an outer rollback', () => {
    const store = new InMemoryOutboxStore();
    expect(() =>
      store.transaction((tx) => {
        tx.enqueue(input('outer'));
        store.transaction((inner) => inner.enqueue(input('inner')));
      }),
    ).toThrow('nested');
    expect(store.all()).toHaveLength(0);
    expect(() => store.transaction((tx) => tx.enqueue(input('after')))).not.toThrow();
  });
  it('carries correlation and actor references through the record', () => {
    const store = new InMemoryOutboxStore();
    store.transaction((tx) =>
      tx.enqueue({
        ...input('e1'),
        correlationId: 'corr-1',
        actorRef: { subject: 'user-1', kind: 'user' },
      }),
    );
    expect(store.get('tenant-a', 'e1')).toMatchObject({
      correlationId: 'corr-1',
      actorRef: { subject: 'user-1', kind: 'user' },
    });
  });
  it('follows the 1m/5m/30m/2h/12h schedule with bounded jitter', () => {
    const exact = [1, 2, 3, 4, 5, 6].map((attempt) => backoffMs(attempt));
    expect(exact).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 43_200_000]);
    expect(backoffMs(1, () => 0)).toBe(48_000);
    expect(backoffMs(1, () => 0.999999)).toBeLessThanOrEqual(72_000);
  });
});

describe('outbox store edge cases', () => {
  it('rejects invalid lease or worker on claim', () => {
    const store = new InMemoryOutboxStore();
    expect(() => store.claim(0, 0, 'w1')).toThrow('valid lease and worker');
    expect(() => store.claim(0, -5, 'w1')).toThrow('valid lease and worker');
    expect(() => store.claim(0, 10, '   ')).toThrow('valid lease and worker');
  });
  it('rejects mutations for unknown events and for non-processing records', () => {
    const store = new InMemoryOutboxStore(() => 0);
    expect(() => store.markHandlerCompleted('tenant-a', 'nope', 1)).toThrow(
      'outbox event not found',
    );
    store.transaction((tx) => tx.enqueue(input('e1')));
    const claim = store.claim(0, 10, 'w1')!;
    expect(() => store.acknowledge('tenant-a', 'e1', claim.fencing)).toThrow(
      'handler not completed',
    );
    store.reconcile(10);
    expect(store.get('tenant-a', 'e1')).toMatchObject({
      status: 'retry',
      lastError: 'lease expired',
    });
    expect(() => store.markHandlerCompleted('tenant-a', 'e1', claim.fencing)).toThrow(
      'stale fencing',
    );
    expect(() => store.acknowledge('tenant-a', 'e1', claim.fencing)).toThrow('stale fencing');
    expect(store.retry('tenant-a', 'e1', claim.fencing, 'again', 10, 3)).toBe('retry');
  });
  it('does not reclaim a processing record before its lease expires or before availableAt', () => {
    const store = new InMemoryOutboxStore(() => 100);
    store.transaction((tx) => tx.enqueue(input('e1')));
    expect(store.claim(99, 10, 'w1')).toBeUndefined();
    const first = store.claim(100, 10, 'w1')!;
    expect(first.leaseUntil).toBe(110);
    expect(store.claim(109, 10, 'w2')).toBeUndefined();
    expect(store.claim(110, 10, 'w2')?.record.attempts).toBe(2);
  });
  it('reconcile only touches processing records with an expired lease', () => {
    const store = new InMemoryOutboxStore(() => 0);
    store.transaction((tx) => {
      tx.enqueue(input('e1'));
      tx.enqueue(input('e2'));
      tx.enqueue(input('e3'));
    });
    store.claim(0, 100, 'w1');
    store.claim(0, 5, 'w1');
    expect(store.reconcile(10)).toBe(1);
    expect(store.reconcile(10)).toBe(0);
    expect(store.all().map((r) => r.status)).toEqual(['processing', 'retry', 'pending']);
  });
  it('truncates stored errors to 500 characters and keeps dead letters terminal', () => {
    const store = new InMemoryOutboxStore(() => 0);
    store.transaction((tx) => tx.enqueue(input('e1')));
    const claim = store.claim(0, 10, 'w1')!;
    expect(store.retry('tenant-a', 'e1', claim.fencing, 'x'.repeat(900), 0, 1)).toBe('dead_letter');
    expect(store.get('tenant-a', 'e1')?.lastError).toHaveLength(500);
    expect(store.retry('tenant-a', 'e1', claim.fencing, 'other', 0, 5)).toBe('dead_letter');
    expect(store.get('tenant-a', 'e1')?.lastError).toHaveLength(500);
  });
  it('returns undefined for unknown events and isolated clones from get and all', () => {
    const store = new InMemoryOutboxStore(() => 0);
    expect(store.get('tenant-a', 'missing')).toBeUndefined();
    store.transaction((tx) => tx.enqueue(input('e1')));
    store.get('tenant-a', 'e1')!.status = 'delivered';
    store.all()[0]!.attempts = 99;
    expect(store.get('tenant-a', 'e1')).toMatchObject({ status: 'pending', attempts: 0 });
  });
  it('clamps backoff attempts below one and above the schedule length', () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-3)).toBe(60_000);
    expect(backoffMs(99)).toBe(43_200_000);
    expect(backoffMs(1, () => 0)).toBe(48_000);
  });
});
