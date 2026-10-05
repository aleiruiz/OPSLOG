import { describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  ProvisioningFailedError,
  TenantAccessDeniedError,
  correlationId,
  immutableContext,
  opaqueId,
  opaqueTenantId,
  payloadHash,
  sessionIdHash,
  subjectId,
  uuidV7,
  type SessionId,
  type TenantContext,
  type TenantId,
} from './index.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('application-generated identifiers', () => {
  it('generates RFC 9562 UUIDv7 values with the timestamp in the leading bits', () => {
    const timestamp = 1_798_697_600_123;
    const id = uuidV7(timestamp);
    expect(id).toMatch(UUID_V7);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamp);
  });

  it('uses UUIDv7 for tenant and opaque entity identifiers', () => {
    expect(opaqueTenantId()).toMatch(UUID_V7);
    expect(opaqueId()).toMatch(UUID_V7);
  });

  it('uses UUIDv7 for correlation identifiers and never repeats them', () => {
    const first = correlationId();
    expect(first).toMatch(UUID_V7);
    expect(correlationId()).not.toBe(first);
  });

  it('accepts the 48-bit timestamp boundaries and the default clock', () => {
    expect(uuidV7(0).slice(0, 13)).toBe('00000000-0000');
    expect(uuidV7(0xffffffffffff).slice(0, 13)).toBe('ffffffff-ffff');
    const before = Date.now();
    const stamp = Number.parseInt(uuidV7().replaceAll('-', '').slice(0, 12), 16);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it.each([-1, 0xffffffffffff + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the out-of-range or non-integer timestamp %s',
    (value) => {
      expect(() => uuidV7(value)).toThrow(RangeError);
      expect(() => uuidV7(value)).toThrow('UUIDv7 timestamp must fit 48 bits');
    },
  );
});

describe('subject identifiers', () => {
  it('passes a non-empty subject through unchanged', () => {
    expect(subjectId('user-1')).toBe('user-1');
  });

  it('requires a subject', () => {
    expect(() => subjectId('')).toThrow('subject is required');
  });
});

describe('hashing helpers', () => {
  it('hashes payloads deterministically as lowercase SHA-256 hex', () => {
    expect(payloadHash({ name: 'a' })).toBe(payloadHash({ name: 'a' }));
    expect(payloadHash({ name: 'a' })).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash({ name: 'a' })).not.toBe(payloadHash({ name: 'b' }));
    // Known SHA-256 of the JSON text `{"name":"a"}`.
    expect(payloadHash({ name: 'a' })).toBe(
      'd9d719b27480b55cd4918020e7473e716ed3569c8adafe926cf9b10b4f8ef064',
    );
  });

  it('hashes session identifiers without exposing the raw value', () => {
    const raw = 'session-secret' as SessionId;
    const hashed = sessionIdHash(raw);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain(raw);
    expect(sessionIdHash(raw)).toBe(hashed);
    expect(sessionIdHash('other' as SessionId)).not.toBe(hashed);
  });
});

describe('domain errors', () => {
  it('denies tenant access with a stable code and no detail', () => {
    const error = new TenantAccessDeniedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TenantAccessDeniedError');
    expect(error.code).toBe('TENANT_ACCESS_DENIED');
    expect(error.message).toBe('Tenant access denied');
  });

  it('reports idempotency conflicts with a stable code', () => {
    const error = new IdempotencyConflictError();
    expect(error.name).toBe('IdempotencyConflictError');
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(error.message).toBe('Idempotency key was already used with a different request');
  });

  it('reports provisioning failures with a default and an explicit reason code', () => {
    const generic = new ProvisioningFailedError();
    expect(generic.name).toBe('ProvisioningFailedError');
    expect(generic.code).toBe('TENANT_PROVISIONING_FAILED');
    expect(generic.reasonCode).toBe('PROVISIONING_FAILED');
    expect(generic.message).toBe('Tenant provisioning failed');
    expect(new ProvisioningFailedError('ATTEMPTS_EXHAUSTED').reasonCode).toBe('ATTEMPTS_EXHAUSTED');
  });
});

describe('immutableContext', () => {
  const context = (): TenantContext => {
    const tenantId = opaqueTenantId();
    return {
      tenantId,
      actor: { subjectId: subjectId('s'), membershipVersion: 1 },
      authorizationVersion: 1,
      correlationId: correlationId(),
      database: {
        tenantId: tenantId as TenantId,
        databaseName: 'db',
        credentialRef: 'ref',
        secretVersion: 1,
        migrationVersion: '1',
        runtimeRoleVerified: true,
        isolationProbeVerified: true,
        verifiedAt: new Date(0),
      },
    };
  };

  it('deeply freezes the context, its actor and its database location', () => {
    const frozen = immutableContext(context());
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.actor)).toBe(true);
    expect(Object.isFrozen(frozen.database)).toBe(true);
  });

  it('returns the same object and rejects mutation in strict mode', () => {
    const input = context();
    const frozen = immutableContext(input);
    expect(frozen).toBe(input);
    expect(() => {
      (frozen as { authorizationVersion: number }).authorizationVersion = 2;
    }).toThrow(TypeError);
    expect(() => {
      (frozen.actor as { membershipVersion: number }).membershipVersion = 2;
    }).toThrow(TypeError);
    expect(() => {
      (frozen.database as { databaseName: string }).databaseName = 'other';
    }).toThrow(TypeError);
  });
});
