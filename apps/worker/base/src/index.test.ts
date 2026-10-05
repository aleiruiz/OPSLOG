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
      payload: { secret: 'not-for-dlq', email: 'private@example.test' },
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
      expect(store.get('tenant-a', 'e1')?.status).toBe('dead_letter');
      expect(worker.dlq.receive()?.body).toEqual({
        eventId: 'e1',
        tenantId: 'tenant-a',
        reason: 'tenant unavailable',
      });
      expect(worker.metrics.deadLettered).toBe(1);
    },
  );
  it('redacts handler errors and sends payload-free DLQ metadata', async () => {
    const { worker, store } = setup('active');
    worker.register('demo', () => {
      throw new Error('token=Bearer secret-value; email private@example.test');
    });
    await worker.process(Date.now());
    expect(store.get('tenant-a', 'e1')?.lastError).not.toMatch(
      /secret-value|private@example\.test/,
    );
    const dlqEntry = worker.dlq.receive()?.body as Record<string, unknown>;
    expect(dlqEntry).toEqual({ eventId: 'e1', tenantId: 'tenant-a', reason: 'handler failed' });
    expect(JSON.stringify(dlqEntry)).not.toMatch(/not-for-dlq|private@example\.test/);
    expect(worker.metrics.deadLettered).toBe(1);
  });
  it('sends payload-free metadata when the handler is absent', async () => {
    const { worker } = setup('active');
    await worker.process(Date.now());
    expect(worker.dlq.receive()?.body).toEqual({
      eventId: 'e1',
      tenantId: 'tenant-a',
      reason: 'handler not registered',
      type: 'demo',
      attempts: 1,
    });
    expect(worker.metrics.deadLettered).toBe(1);
  });
  it('audits successful delivery', async () => {
    const { worker, store, audit } = setup('active');
    worker.register('demo', () => undefined);
    await worker.process(Date.now());
    expect(store.get('tenant-a', 'e1')?.status).toBe('delivered');
    expect(audit.list('tenant-a')).toHaveLength(1);
  });
  it('does not redeliver a completed handler after audit append failure', async () => {
    const { store } = setup('active');
    const persisted = new InMemoryAuditStore();
    let failAudit = true;
    let calls = 0;
    const audit = {
      append: (event: Parameters<typeof persisted.append>[0]) => {
        if (failAudit) throw new Error('unavailable');
        persisted.append(event);
      },
      list: (tenantId: string) => persisted.list(tenantId),
    };
    let tenantStatus: 'active' | 'suspended' = 'active';
    const worker = new Worker(store, { status: () => tenantStatus }, audit, 'worker-b', 10);
    worker.register('demo', () => {
      calls += 1;
    });
    const now = Date.now();
    await worker.process(now);
    expect(store.get('tenant-a', 'e1')).toMatchObject({
      status: 'processing',
      handlerCompleted: true,
    });
    expect(worker.metrics.auditFailures).toBe(1);
    expect(worker.metrics.delivered).toBe(0);
    expect(calls).toBe(1);
    failAudit = false;
    tenantStatus = 'suspended';
    await worker.process(now + 11);
    expect(calls).toBe(1);
    expect(store.get('tenant-a', 'e1')?.status).toBe('delivered');
    expect(persisted.list('tenant-a')).toHaveLength(1);
  });
  it('allows only one concurrent worker claim for an event', async () => {
    const { store, audit } = setup('active');
    const workers = [
      new Worker(store, { status: () => 'active' }, audit, 'worker-a'),
      new Worker(store, { status: () => 'active' }, audit, 'worker-b'),
    ];
    let executions = 0;
    for (const worker of workers)
      worker.register('demo', async () => {
        executions += 1;
        await Promise.resolve();
      });
    await Promise.all(workers.map((worker) => worker.process(Date.now())));
    expect(executions).toBe(1);
  });
});

describe('worker lease loss, attempts and tenant isolation', () => {
  const enqueue = (store: InMemoryOutboxStore, tenantId: string, eventId = 'e1') =>
    store.transaction((tx) =>
      tx.enqueue({
        eventId,
        tenantId,
        type: 'demo',
        payload: {},
        occurredAt: '2026-10-04T00:00:00.000Z',
        idempotencyKey: eventId,
      }),
    );
  it('drops the claim instead of crashing when the handler outlives its lease', async () => {
    const store = new InMemoryOutboxStore(() => 0);
    enqueue(store, 'tenant-a');
    const audit = new InMemoryAuditStore();
    const slow = new Worker(store, { status: () => 'active' }, audit, 'worker-a', 10, 5);
    const fast = new Worker(store, { status: () => 'active' }, audit, 'worker-b', 10, 5);
    let release: () => void = () => undefined;
    slow.register(
      'demo',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    fast.register('demo', () => undefined);
    const first = slow.process(0);
    await Promise.resolve();
    await expect(fast.process(100)).resolves.toBe(true);
    release();
    await expect(first).resolves.toBe(true);
    expect(slow.metrics.staleLeases).toBe(1);
    expect(slow.metrics.handlerFailures).toBe(0);
    expect(store.get('tenant-a', 'e1')?.status).toBe('delivered');
  });
  it('dead-letters an event whose audit append keeps failing after maxAttempts claims', async () => {
    const store = new InMemoryOutboxStore(() => 0);
    enqueue(store, 'tenant-a');
    const failing = {
      append: () => {
        throw new Error('audit down');
      },
      list: () => [],
    };
    const worker = new Worker(store, { status: () => 'active' }, failing, 'worker-a', 10, 2);
    let calls = 0;
    worker.register('demo', () => {
      calls += 1;
    });
    for (let tick = 0; tick < 4; tick += 1) await worker.process(tick * 100);
    expect(calls).toBe(1);
    expect(store.get('tenant-a', 'e1')?.status).toBe('dead_letter');
    expect(worker.dlq.receive()?.body).toMatchObject({ reason: 'attempts exhausted' });
  });
  it('retries with backoff before dead-lettering when maxAttempts is greater than one', async () => {
    const store = new InMemoryOutboxStore(
      () => 0,
      () => 0.5,
    );
    enqueue(store, 'tenant-a');
    const worker = new Worker(
      store,
      { status: () => 'active' },
      new InMemoryAuditStore(),
      'worker-a',
      10,
      3,
    );
    worker.register('demo', () => {
      throw new Error('boom');
    });
    await worker.process(0);
    expect(store.get('tenant-a', 'e1')).toMatchObject({ status: 'retry', availableAt: 60_000 });
    await expect(worker.process(500)).resolves.toBe(false);
    await worker.process(60_000);
    await worker.process(360_000);
    expect(store.get('tenant-a', 'e1')?.status).toBe('dead_letter');
    expect(worker.metrics).toMatchObject({ retried: 2, deadLettered: 1, handlerFailures: 3 });
  });
  it('keeps identical event ids in two tenants isolated', async () => {
    const store = new InMemoryOutboxStore(() => 0);
    enqueue(store, 'tenant-a');
    enqueue(store, 'tenant-b');
    const audit = new InMemoryAuditStore();
    const worker = new Worker(
      store,
      { status: (tenantId) => (tenantId === 'tenant-a' ? 'active' : 'suspended') },
      audit,
      'worker-a',
      10,
      2,
    );
    worker.register('demo', () => undefined);
    await worker.process(0);
    await worker.process(0);
    expect(store.get('tenant-a', 'e1')?.status).toBe('delivered');
    expect(store.get('tenant-b', 'e1')?.status).toBe('dead_letter');
    expect(audit.list('tenant-a')).toHaveLength(1);
    expect(audit.list('tenant-b')).toHaveLength(0);
  });
  it('audits with the enqueuing correlation id and the delivery time', async () => {
    const store = new InMemoryOutboxStore(() => 0);
    store.transaction((tx) =>
      tx.enqueue({
        eventId: 'e1',
        tenantId: 'tenant-a',
        type: 'demo',
        payload: {},
        occurredAt: '2026-10-04T00:00:00.000Z',
        idempotencyKey: 'e1',
        correlationId: 'request-42',
      }),
    );
    const audit = new InMemoryAuditStore();
    let time = 0;
    const worker = new Worker(
      store,
      { status: () => 'active' },
      audit,
      'worker-a',
      10_000,
      6,
      () => time,
    );
    worker.register('demo', () => {
      time = 5_000;
    });
    await worker.process();
    expect(audit.list('tenant-a')[0]).toMatchObject({
      correlationId: 'request-42',
      occurredAt: new Date(5_000).toISOString(),
    });
  });
  it('schedules the retry from the failure time, not the claim time', async () => {
    const store = new InMemoryOutboxStore(
      () => 0,
      () => 0.5,
    );
    enqueue(store, 'tenant-a');
    let time = 0;
    const worker = new Worker(
      store,
      { status: () => 'active' },
      new InMemoryAuditStore(),
      'worker-a',
      1_000_000,
      6,
      () => time,
    );
    worker.register('demo', () => {
      time = 90_000;
      throw new Error('slow failure');
    });
    await worker.process();
    expect(store.get('tenant-a', 'e1')?.availableAt).toBe(90_000 + 60_000);
  });
});
