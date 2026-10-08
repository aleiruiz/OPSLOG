import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore } from '../../../../packages/platform/audit/src/index.js';
import { InMemoryOutboxStore } from '../../../../packages/platform/outbox/src/index.js';
import { Worker, type ActorPermissionCheck } from './index.js';

describe('worker re-checks the actor that enqueued a job', () => {
  const enqueueAs = (
    store: InMemoryOutboxStore,
    actorRef?: { subject: string; kind: 'user' | 'api_key' | 'system' },
  ) =>
    store.transaction((tx) =>
      tx.enqueue({
        eventId: 'e1',
        tenantId: 'tenant-a',
        type: 'demo',
        payload: { secret: 'not-for-dlq' },
        occurredAt: '2026-10-04T00:00:00.000Z',
        idempotencyKey: 'k1',
        requiredPermission: 'create',
        ...(actorRef ? { actorRef } : {}),
      }),
    );
  const user = { subject: 'user-ana', kind: 'user' } as const;
  const build = (allows: ActorPermissionCheck['allows'] | undefined) => {
    const store = new InMemoryOutboxStore();
    const worker = new Worker(
      store,
      { status: () => 'active' },
      new InMemoryAuditStore(),
      'worker-a',
      10,
      1,
      Date.now,
      allows ? { allows } : undefined,
    );
    let calls = 0;
    worker.register('demo', () => {
      calls += 1;
    });
    return { store, worker, calls: () => calls };
  };

  it('runs the job when the actor still holds the permission, passing tenant, actor and permission', async () => {
    const seen: unknown[] = [];
    const { store, worker, calls } = build(async (...args) => {
      seen.push(args);
      return true;
    });
    enqueueAs(store, user);
    await worker.process(Date.now());
    expect(seen).toEqual([['tenant-a', user, 'create']]);
    expect(calls()).toBe(1);
    expect(store.get('tenant-a', 'e1')?.status).toBe('delivered');
    expect(worker.metrics.rejectedActors).toBe(0);
  });

  it('refuses the job without side effects when the actor is no longer permitted', async () => {
    const { store, worker, calls } = build(() => false);
    enqueueAs(store, user);
    await worker.process(Date.now());
    expect(calls()).toBe(0);
    expect(store.get('tenant-a', 'e1')?.status).toBe('dead_letter');
    expect(worker.metrics).toMatchObject({ rejectedActors: 1, deadLettered: 1, delivered: 0 });
    expect(worker.dlq.receive()?.body).toEqual({
      eventId: 'e1',
      tenantId: 'tenant-a',
      reason: 'actor not permitted',
    });
  });

  it('fails closed when the check throws or answers anything but true', async () => {
    for (const allows of [
      () => {
        throw new Error('directory down');
      },
      () => 'yes' as unknown as boolean,
    ]) {
      const { store, worker, calls } = build(allows);
      enqueueAs(store, user);
      await worker.process(Date.now());
      expect(calls()).toBe(0);
      expect(store.get('tenant-a', 'e1')?.status).toBe('dead_letter');
    }
  });

  it('fails closed for a user actor when no check is wired', async () => {
    const { store, worker, calls } = build(undefined);
    enqueueAs(store, user);
    await worker.process(Date.now());
    expect(calls()).toBe(0);
    expect(store.get('tenant-a', 'e1')?.status).toBe('dead_letter');
  });

  it('does not consult the check for system actors or jobs without an actor', async () => {
    for (const actorRef of [{ subject: 'worker-x', kind: 'system' } as const, undefined]) {
      let asked = 0;
      const { store, worker, calls } = build(() => {
        asked += 1;
        return false;
      });
      enqueueAs(store, actorRef);
      await worker.process(Date.now());
      expect(asked).toBe(0);
      expect(calls()).toBe(1);
    }
  });

  it('fails closed for every kind except system: api_key and unknown kinds need a check', async () => {
    for (const kind of ['api_key', 'service', ''] as const) {
      const actorRef = { subject: 'user-x', kind: kind as 'api_key' };
      const unwired = build(undefined);
      enqueueAs(unwired.store, actorRef);
      await unwired.worker.process(Date.now());
      expect(unwired.calls(), kind).toBe(0);
      expect(unwired.store.get('tenant-a', 'e1')?.status, kind).toBe('dead_letter');
      expect(unwired.worker.metrics.rejectedActors, kind).toBe(1);

      const denied = build(() => false);
      enqueueAs(denied.store, actorRef);
      await denied.worker.process(Date.now());
      expect(denied.calls(), kind).toBe(0);
      expect(denied.store.get('tenant-a', 'e1')?.status, kind).toBe('dead_letter');

      const seen: unknown[] = [];
      const allowed = build((...args) => {
        seen.push(args);
        return true;
      });
      enqueueAs(allowed.store, actorRef);
      await allowed.worker.process(Date.now());
      expect(seen, kind).toEqual([['tenant-a', actorRef, 'create']]);
      expect(allowed.calls(), kind).toBe(1);
    }
  });

  it('does not re-ask once the handler already ran (only the audit append is retried)', async () => {
    const store = new InMemoryOutboxStore();
    const persisted = new InMemoryAuditStore();
    let failAudit = true;
    const audit = {
      append: async (event: Parameters<typeof persisted.append>[0]) => {
        if (failAudit) throw new Error('unavailable');
        await persisted.append(event);
      },
      list: (tenantId: string) => persisted.list(tenantId),
    };
    let allowed = true;
    const worker = new Worker(
      store,
      { status: () => 'active' },
      audit,
      'worker-a',
      10,
      3,
      Date.now,
      { allows: () => allowed },
    );
    let calls = 0;
    worker.register('demo', () => {
      calls += 1;
    });
    enqueueAs(store, user);
    const now = Date.now();
    await worker.process(now);
    failAudit = false;
    allowed = false;
    await worker.process(now + 11);
    expect(calls).toBe(1);
    expect(store.get('tenant-a', 'e1')?.status).toBe('delivered');
  });
});
