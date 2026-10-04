import { describe, expect, it } from 'vitest';
import { MemoryAuditOutboxStore } from '../../../../packages/platform/audit/src/index.js';
import type { OutboxEvent, TenantContext } from '../../../../packages/platform/audit/src/types.js';
import { MemoryQueuePublisher } from '../../../../infra/queues/src/index.js';
import type { QueueMetrics } from '../../../../infra/queues/src/ports.js';
import { TenantJobDispatcher } from './dispatcher.js';

const event: OutboxEvent = {
  eventId: 'evt-1',
  tenantId: 'tenant-a',
  type: 'vehicle.updated',
  entityId: 'vehicle-1',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  actorRef: 'actor-a',
  correlationId: 'corr-1',
  payload: { version: 2 },
  schemaVersion: 1,
  status: 'pending',
  attempts: 0,
};

const context: TenantContext = {
  tenantId: 'tenant-a',
  actorRef: 'actor-a',
  correlationId: 'corr-1',
  authorizationVersion: 1,
};
const metrics = (): QueueMetrics & { counts: Map<string, number> } => {
  const counts = new Map<string, number>();
  return { counts, increment: (name) => counts.set(name, (counts.get(name) ?? 0) + 1) };
};

describe('tenant job dispatcher', () => {
  it('rejects missing and suspended tenants without publishing', async () => {
    for (const state of ['missing', 'suspended'] as const) {
      const store = new MemoryAuditOutboxStore();
      await store.transaction((tx) => tx.enqueue(event));
      const publisher = new MemoryQueuePublisher();
      const m = metrics();
      await new TenantJobDispatcher(store, publisher, { resolve: async () => state }, m).dispatch(
        10,
      );
      expect(publisher.published).toHaveLength(0);
      expect(publisher.deadLetters[0]?.reason).toBe(`tenant-${state}`);
    }
  });

  it('runs a handler with the resolved context and publishes once on retry', async () => {
    const store = new MemoryAuditOutboxStore();
    await store.transaction((tx) => tx.enqueue(event));
    const publisher = new MemoryQueuePublisher();
    const m = metrics();
    const seen: TenantContext[] = [];
    const dispatcher = new TenantJobDispatcher(
      store,
      publisher,
      { resolve: async () => context },
      m,
      new Map([
        [
          'vehicle.updated',
          async (_event, tenant) => {
            seen.push(tenant);
          },
        ],
      ]),
    );
    await dispatcher.dispatch(10);
    await dispatcher.dispatch(10);
    expect(seen).toHaveLength(1);
    expect(publisher.published).toHaveLength(1);
  });
});
