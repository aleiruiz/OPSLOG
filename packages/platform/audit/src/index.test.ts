import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore, createAuditEvent, redactAuditData, redactError } from './index.js';

// Assembled at runtime so secret scanners do not mistake the synthetic IDs for provider tokens.
const SYNTHETIC_UUID = '00000000-0000-4000-8000-000000000000';
const SYNTHETIC_USER_ACTOR = ['user', SYNTHETIC_UUID].join('-');
const SYNTHETIC_API_ACTOR = ['api', SYNTHETIC_UUID].join('-');

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
        actorId: SYNTHETIC_USER_ACTOR,
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
        actorId: SYNTHETIC_API_ACTOR,
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

    expect(userEvent.actor.id).toBe(SYNTHETIC_USER_ACTOR);
    expect(apiEvent.actor.id).toBe(SYNTHETIC_API_ACTOR);
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
  it('persists only allowlisted fields and opaque identifiers on append', () => {
    const store = new InMemoryAuditStore();
    store.append({
      eventId: 'e-field',
      tenantId: 'tenant-a',
      action: 'x',
      entityType: 'x',
      entityId: 'jane@example.test',
      occurredAt: '2026-10-04T00:00:00.000Z',
      actor: { id: 'system', kind: 'system' },
      correlationId: 'Jane Doe, 12 Main Street',
      data: {},
      note: 'ssn 123-45-6789',
    } as never);
    const [stored] = store.list('tenant-a');
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('note');
    expect(stored?.entityId).toBe('[REDACTED]');
    expect(stored?.correlationId).toBe('[REDACTED]');
    expect(JSON.stringify(stored)).not.toMatch(/jane|ssn|123-45/i);
  });
  it('rejects, rather than redacts, keys that identify and deduplicate events', () => {
    const store = new InMemoryAuditStore();
    const base = {
      eventId: 'e-key',
      tenantId: 'tenant-a',
      action: 'x',
      entityType: 'x',
      entityId: 'e',
      occurredAt: '2026-10-04T00:00:00.000Z',
      actor: { id: 'system', kind: 'system' as const },
      correlationId: 'c',
      data: {},
    };
    expect(() => store.append({ ...base, eventId: 'order/1' })).toThrow('eventId');
    expect(() => store.append({ ...base, tenantId: '' })).toThrow('tenantId');
    expect(() => store.append({ ...base, actor: { id: 'system', kind: 'root' as never } })).toThrow(
      'actor kind',
    );
    store.append(base);
    store.append({ ...base, eventId: 'e-key-2' });
    expect(store.list('tenant-a')).toHaveLength(2);
  });
  it('redacts credential pairs and JWT-like values from stored errors', () => {
    // Built at runtime so secret scanners do not flag the synthetic token.
    const jwtLike = ['eyJhbGciOiJIUzI1NiJ9', 'payloadpart', 'sigpart'].join('.');
    const message = redactError(new Error(`upstream 401 api_key=abc123 failed for ${jwtLike}`));
    expect(message).not.toMatch(/abc123|eyJhbGci/);
    expect(message).toContain('upstream 401');
    for (const text of [
      'access_token=abc123secretvalue',
      'client_secret: s3cr3tvalue',
      'db_password=hunter2xyz',
      'Authorization: Basic dXNlcjpwYXNz',
      'password = "hunter 2"',
      '{"password":"hunter2xyz"}',
      'password: "unterminated hunter value',
    ])
      expect(redactError(new Error(text))).not.toMatch(
        /abc123|s3cr3t|hunter|dXNlcjpwYXNz|unterminated/,
      );
  });
  it('scans long error messages in bounded time', () => {
    const started = Date.now();
    redactError(new Error('_'.repeat(100_000)));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
