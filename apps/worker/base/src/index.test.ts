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
    const worker = new Worker(store, { status: () => 'active' }, audit, 'worker-b', 10);
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
