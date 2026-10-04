import { describe, expect, it } from 'vitest';
import { AuditOutboxService, MemoryAuditOutboxStore } from './index.js';

const base = {
  eventId: 'evt-1',
  tenantId: 'tenant-a',
  entityId: 'vehicle-1',
  action: 'vehicle.updated',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  actorRef: 'actor-a',
  correlationId: 'corr-1',
};

describe('audit and outbox atomicity', () => {
  it('rolls back audit when the outbox write is invalid', async () => {
    const store = new MemoryAuditOutboxStore();
    const service = new AuditOutboxService(store);
    await expect(
      service.record(base, {
        eventId: 'evt-1',
        tenantId: 'tenant-b',
        type: 'vehicle.updated',
        entityId: 'vehicle-1',
        occurredAt: base.occurredAt,
        actorRef: 'actor-a',
        correlationId: 'corr-1',
        payload: { version: 2 },
      }),
    ).rejects.toThrow('tenant mismatch');
    expect(store.audits).toHaveLength(0);
    expect(store.events.size).toBe(0);
  });

  it('keeps audit metadata free of obvious PII and secrets', async () => {
    const store = new MemoryAuditOutboxStore();
    await new AuditOutboxService(store).record({
      ...base,
      metadata: { status: 'active', email: 'a@example.test', token: 'secret' },
    });
    expect(store.audits[0]?.metadata).toEqual({ status: 'active' });
  });
});
