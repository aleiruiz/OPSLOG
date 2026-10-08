import { describe, expect, it } from 'vitest';
import {
  AuditConflictError,
  InMemoryAuditStore,
  createAuditEvent,
  defaultAuditListRange,
  redactAuditData,
  redactError,
} from './index.js';

// Assembled at runtime so secret scanners do not mistake the synthetic IDs for provider tokens.
const SYNTHETIC_UUID = '00000000-0000-4000-8000-000000000000';
const SYNTHETIC_USER_ACTOR = ['user', SYNTHETIC_UUID].join('-');
const SYNTHETIC_API_ACTOR = ['api', SYNTHETIC_UUID].join('-');
const RANGE = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z' } as const;

describe('audit safety and tenant isolation', () => {
  it('uses a bounded default read range and exposes only in-memory test snapshots', async () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    const range = defaultAuditListRange(now);
    expect(range).toEqual({
      from: '2026-09-10T12:00:00.000Z',
      to: '2026-10-10T12:00:00.001Z',
      limit: 500,
    });
    const store = new InMemoryAuditStore();
    expect(await store.list('tenant-a')).toEqual([]);
    await store.append({
      eventId: 'default-range',
      tenantId: 'tenant-a',
      action: 'x',
      entityType: 'x',
      entityId: 'e',
      occurredAt: now.toISOString(),
      actor: { id: 'system', kind: 'system' },
      correlationId: 'c',
      data: {},
    });
    expect(store.snapshotForTesting('tenant-a')).toHaveLength(1);
    expect(store.snapshotForTesting('tenant-b')).toEqual([]);
  });
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
  it('redacts raw events appended directly to the public store API', async () => {
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

    await store.append(rawEvent);

    expect((await store.list('tenant-a', RANGE))[0]?.actor.id).toBe('[REDACTED]');
    expect((await store.list('tenant-a', RANGE))[0]?.data).toEqual({ attempts: 1 });
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
  it('keeps A/B tenants isolated and deduplicates event ids', async () => {
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
    await store.append(event('tenant-a'));
    await store.append(event('tenant-a'));
    await store.append(event('tenant-b'));
    const tenantA = await store.list('tenant-a', RANGE);
    const tenantB = await store.list('tenant-b', RANGE);
    expect(tenantA).toHaveLength(1);
    expect(tenantB).toHaveLength(1);
    expect(tenantA[0]?.tenantId).toBe('tenant-a');
    expect(tenantB[0]?.eventId).toBe(tenantA[0]?.eventId);
    expect(tenantA[0]?.data).toEqual({});
  });
  it('rejects changed content for an immutable tenant/event identity', async () => {
    const store = new InMemoryAuditStore();
    const base = {
      eventId: 'immutable-e',
      tenantId: 'tenant-a',
      action: 'vehicle.created',
      entityType: 'vehicle',
      entityId: 'vehicle-1',
      occurredAt: '2026-10-04T00:00:00.000Z',
      actor: { id: 'system', kind: 'system' as const },
      correlationId: 'corr-a',
      data: { attempts: 1 },
    };
    await store.append(base);
    await expect(store.append({ ...base, action: 'vehicle.deleted' })).rejects.toBeInstanceOf(
      AuditConflictError,
    );
    expect(await store.list('tenant-a', RANGE)).toMatchObject([{ action: 'vehicle.created' }]);
  });
  it('treats equivalent UTC timestamp spellings as the same canonical event', async () => {
    const store = new InMemoryAuditStore();
    const event = {
      eventId: 'timestamp-e',
      tenantId: 'tenant-a',
      action: 'x',
      entityType: 'x',
      entityId: 'e',
      occurredAt: '2026-10-04T00:00:00Z',
      actor: { id: 'system', kind: 'system' as const },
      correlationId: 'c',
      data: {},
    };
    await store.append(event);
    await expect(store.append({ ...event, occurredAt: '2026-10-04T00:00:00.000Z' })).resolves.toBe(
      undefined,
    );
  });
  it('bounds tenant reads by a half-open time range and deterministic limit', async () => {
    const store = new InMemoryAuditStore();
    const base = {
      eventId: 'range-event',
      tenantId: 'tenant-a',
      action: 'x',
      entityType: 'x',
      entityId: 'e',
      actor: { id: 'system', kind: 'system' as const },
      correlationId: 'c',
      data: {},
    };
    await store.append({ ...base, eventId: 'before', occurredAt: '2026-09-30T23:59:59.999Z' });
    await store.append({ ...base, eventId: 'inside-1', occurredAt: '2026-10-02T00:00:00.000Z' });
    await store.append({ ...base, eventId: 'inside-2', occurredAt: '2026-10-03T00:00:00.000Z' });
    await store.append({ ...base, eventId: 'at-end', occurredAt: RANGE.to });
    expect(await store.list('tenant-a', { ...RANGE, limit: 1 })).toMatchObject([
      { eventId: 'inside-2' },
    ]);
    await expect(store.list('tenant-a', { from: RANGE.to, to: RANGE.from })).rejects.toThrow(
      /time range/,
    );
  });
  it('persists only allowlisted fields and opaque identifiers on append', async () => {
    const store = new InMemoryAuditStore();
    await store.append({
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
    const [stored] = await store.list('tenant-a', RANGE);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('note');
    expect(stored?.entityId).toBe('[REDACTED]');
    expect(stored?.correlationId).toBe('[REDACTED]');
    expect(JSON.stringify(stored)).not.toMatch(/jane|ssn|123-45/i);
  });
  it('rejects, rather than redacts, keys that identify and deduplicate events', async () => {
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
    await expect(store.append({ ...base, eventId: 'order/1' })).rejects.toThrow('eventId');
    await expect(store.append({ ...base, tenantId: '' })).rejects.toThrow('tenantId');
    await expect(
      store.append({ ...base, actor: { id: 'system', kind: 'root' as never } }),
    ).rejects.toThrow('actor kind');
    await store.append(base);
    await store.append({ ...base, eventId: 'e-key-2' });
    expect(await store.list('tenant-a', RANGE)).toHaveLength(2);
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
  it('redacts invalid labels and timestamps but keeps well-formed ones', () => {
    const context = {
      tenantId: 'tenant-a',
      actorId: 'system',
      actorKind: 'system' as const,
      correlationId: 'corr-a',
    };
    const input = {
      eventId: 'label-e',
      action: 'order.created',
      entityType: 'order',
      entityId: 'e',
      occurredAt: '2026-10-04T00:00:00Z',
    };
    const good = createAuditEvent(context, input);
    expect(good.action).toBe('order.created');
    expect(good.occurredAt).toBe('2026-10-04T00:00:00Z');
    const bad = createAuditEvent(context, {
      ...input,
      action: 'Jane Doe did it',
      entityType: 5 as never,
      entityId: 'a b',
      occurredAt: 'yesterday',
    });
    expect(bad.action).toBe('[REDACTED]');
    expect(bad.entityType).toBe('[REDACTED]');
    expect(bad.entityId).toBe('[REDACTED]');
    expect(bad.occurredAt).toBe('[REDACTED]');
    expect(createAuditEvent(context, { ...input, occurredAt: 12 as never }).occurredAt).toBe(
      '[REDACTED]',
    );
  });
  it('rejects a blank tenant in createAuditEvent', () => {
    expect(() =>
      createAuditEvent(
        { tenantId: '  ', actorId: 'system', actorKind: 'system', correlationId: 'c' },
        { eventId: 'e', action: 'x', entityType: 'x', entityId: 'e', occurredAt: 'x' },
      ),
    ).toThrow('tenant is required');
  });
  it('treats a missing data object as empty on append', async () => {
    const store = new InMemoryAuditStore();
    await store.append({
      eventId: 'no-data',
      tenantId: 'tenant-a',
      action: 'x',
      entityType: 'x',
      entityId: 'e',
      occurredAt: '2026-10-04T00:00:00.000Z',
      actor: { id: 'system', kind: 'system' },
      correlationId: 'c',
      data: undefined,
    } as never);
    expect((await store.list('tenant-a', RANGE))[0]?.data).toEqual({});
  });
  it('keeps only valid non-negative safe-integer attempts', () => {
    expect(redactAuditData({ attempts: 0 })).toEqual({ attempts: 0 });
    for (const attempts of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '3', null])
      expect(redactAuditData({ attempts })).toEqual({});
    expect(redactAuditData({})).toEqual({});
  });
  it('validates actor id shape per actor kind', () => {
    const make = (actorId: string, actorKind: 'user' | 'api_key' | 'system') =>
      createAuditEvent(
        { tenantId: 'tenant-a', actorId, actorKind, correlationId: 'c' },
        { eventId: 'e', action: 'x', entityType: 'x', entityId: 'e', occurredAt: 'x' },
      ).actor.id;
    expect(make('system', 'system')).toBe('system');
    expect(make('worker-outbox_1', 'system')).toBe('worker-outbox_1');
    expect(make('worker-', 'system')).toBe('[REDACTED]');
    expect(make('someone', 'system')).toBe('[REDACTED]');
    // An actor id valid for one kind is not valid for another.
    expect(make(SYNTHETIC_USER_ACTOR, 'api_key')).toBe('[REDACTED]');
    expect(make(SYNTHETIC_API_ACTOR, 'user')).toBe('[REDACTED]');
    expect(make(SYNTHETIC_USER_ACTOR, 'system')).toBe('[REDACTED]');
  });
  it('returns a generic message for non-Error values and truncates long messages', () => {
    expect(redactError('boom password=abc')).toBe('handler failed');
    expect(redactError(undefined)).toBe('handler failed');
    expect(redactError(new Error('x'.repeat(5000)))).toHaveLength(500);
    expect(redactError(new Error('plain failure'))).toBe('plain failure');
  });
  it('redacts secret-looking values in error messages', () => {
    const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const hex = 'a'.repeat(40);
    for (const text of [
      'sent Bearer abc.def.ghi upstream',
      'key sk-live12345 rejected',
      `creds ${awsKey} rejected`,
      `hash ${hex} mismatch`,
      '-----BEGIN PRIVATE KEY-----', // secret-scan:allow synthetic negative fixture
    ])
      expect(redactError(new Error(text))).toBe('[REDACTED]');
  });
});
