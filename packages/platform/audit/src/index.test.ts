import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore, createAuditEvent, redactAuditData, redactError } from './index.js';

describe('audit safety and tenant isolation', () => {
  it('persists only allowlisted structured audit data', () => {
    const data = redactAuditData({
      attempts: 2,
      name: 'Jane Doe',
      address: '123 Main Street, Example City',
      email: 'person@example.test',
      nested: { token: 'Bearer secret-value' },
      safe: 'ok',
    });
    expect(data).toEqual({ attempts: 2 });
  });
  it('redacts free form email, phone and government identifier errors', () => {
    expect(
      redactError(new Error('contact ana@example.test or call +1 (415) 555-2671; SSN 123-45-6789')),
    ).not.toMatch(/ana@example\.test|415|123-45-6789/);
  });
  it('redacts raw events appended directly to the public store API', () => {
    const store = new InMemoryAuditStore();
    const rawEvent = {
      eventId: 'raw-e',
      tenantId: 'tenant-a',
      action: 'x',
      entityType: 'x',
      entityId: 'e',
      occurredAt: '2026-10-04T00:00:00.000Z',
      actor: { id: 'Jane Doe', kind: 'user' as const },
      correlationId: 'corr-a',
      data: {
        attempts: 1,
        name: 'Jane Doe',
        address: '123 Main Street, Example City',
        email: 'person@example.test',
        nested: { token: 'Bearer secret-value' },
        note: 'Contact ana@example.test',
      },
    };

    store.append(rawEvent);

    expect(store.list('tenant-a')[0]?.actor.id).toBe('[REDACTED]');
    expect(store.list('tenant-a')[0]?.data).toEqual({ attempts: 1 });
    expect(rawEvent.actor.id).toBe('Jane Doe');
    expect(rawEvent.data).toEqual({
      attempts: 1,
      name: 'Jane Doe',
      address: '123 Main Street, Example City',
      email: 'person@example.test',
      nested: { token: 'Bearer secret-value' },
      note: 'Contact ana@example.test',
    });
  });
  it('sanitizes actor IDs supplied through createAuditEvent', () => {
    const event = createAuditEvent(
      {
        tenantId: 'tenant-a',
        actorId: 'person@example.test',
        actorKind: 'user',
        correlationId: 'corr-a',
      },
      {
        eventId: 'actor-e',
        action: 'x',
        entityType: 'x',
        entityId: 'e',
        occurredAt: '2026-10-04T00:00:00.000Z',
      },
    );

    expect(event.actor.id).toBe('[REDACTED]');
  });
  it('preserves opaque internal user and API actor references', () => {
    const userEvent = createAuditEvent(
      {
        tenantId: 'tenant-a',
        actorId: 'user-550e8400-e29b-41d4-a716-446655440000',
        actorKind: 'user',
        correlationId: 'corr-a',
      },
      {
        eventId: 'actor-user-e',
        action: 'x',
        entityType: 'x',
        entityId: 'e',
        occurredAt: '2026-10-04T00:00:00.000Z',
      },
    );
    const apiEvent = createAuditEvent(
      {
        tenantId: 'tenant-a',
        actorId: ['api', '550e8400-e29b-41d4-a716-446655440000'].join('-'),
        actorKind: 'api_key',
        correlationId: 'corr-a',
      },
      {
        eventId: 'actor-api-e',
        action: 'x',
        entityType: 'x',
        entityId: 'e',
        occurredAt: '2026-10-04T00:00:00.000Z',
      },
    );

    expect(userEvent.actor.id).toBe('user-550e8400-e29b-41d4-a716-446655440000');
    expect(apiEvent.actor.id).toBe(['api', '550e8400-e29b-41d4-a716-446655440000'].join('-'));
  });
  it('keeps A/B tenants isolated and deduplicates event ids', () => {
    const store = new InMemoryAuditStore();
    const event = (tenantId: string) =>
      createAuditEvent(
        { tenantId, actorId: 'system', actorKind: 'system', correlationId: `${tenantId}-c` },
        {
          eventId: 'local-e',
          action: 'x',
          entityType: 'x',
          entityId: 'e',
          occurredAt: '2026-10-04T00:00:00.000Z',
          data: { contact: 'person@example.test', nested: { phone: '+1 415 555 2671' } },
        },
      );
    store.append(event('tenant-a'));
    store.append(event('tenant-a'));
    store.append(event('tenant-b'));
    expect(store.list('tenant-a')).toHaveLength(1);
    expect(store.list('tenant-b')).toHaveLength(1);
    expect(store.list('tenant-a')[0]?.tenantId).toBe('tenant-a');
    expect(store.list('tenant-b')[0]?.eventId).toBe(store.list('tenant-a')[0]?.eventId);
    expect(store.list('tenant-a')[0]?.data).toEqual({});
  });
});
