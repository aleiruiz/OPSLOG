import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore, createAuditEvent, redactAuditData, redactError } from './index.js';

describe('audit safety and tenant isolation', () => {
  it('redacts PII and secrets recursively while preserving safe fields', () => {
    const data = redactAuditData({
      email: 'person@example.test',
      nested: { token: 'Bearer secret-value' },
      safe: 'ok',
    });
    expect(data).toEqual({ email: '[REDACTED]', nested: { token: '[REDACTED]' }, safe: 'ok' });
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
      actor: { id: 'opaque-actor', kind: 'user' as const },
      correlationId: 'corr-a',
      data: {
        email: 'person@example.test',
        nested: { token: 'Bearer secret-value' },
        note: 'Contact ana@example.test',
      },
    };

    store.append(rawEvent);

    expect(store.list('tenant-a')[0]?.data).toEqual({
      email: '[REDACTED]',
      nested: { token: '[REDACTED]' },
      note: 'Contact [REDACTED]',
    });
    expect(rawEvent.data).toEqual({
      email: 'person@example.test',
      nested: { token: 'Bearer secret-value' },
      note: 'Contact ana@example.test',
    });
  });
  it('keeps A/B tenants isolated and deduplicates event ids', () => {
    const store = new InMemoryAuditStore();
    const event = (tenantId: string) =>
      createAuditEvent(
        { tenantId, actorId: 'opaque-actor', actorKind: 'system', correlationId: `${tenantId}-c` },
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
    expect(store.list('tenant-a')[0]?.data).toEqual({
      contact: '[REDACTED]',
      nested: { phone: '[REDACTED]' },
    });
  });
});
