import { describe, expect, test } from 'vitest';
import {
  notFoundApiError,
  serializeApiError,
  validateCreateIncident,
  validateEventEnvelope,
  validateFileMetadata,
  validateIdempotencyClaim,
  validateOutboxRecord,
  validatePageQuery,
} from './index';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

describe('FND-CONTRACTS', () => {
  test('invalid incident and unknown property', () => {
    expect(validateCreateIncident({ vehicleId: 'foreign', type: '', extra: true })).toHaveLength(3);
  });
  test('bounded page', () => {
    expect(validatePageQuery({ limit: 50, direction: 'desc' })).toEqual([]);
    expect(validatePageQuery({ limit: 10 })).toHaveLength(1);
  });
  test('event envelope rejects malformed actor and impossible dates', () => {
    expect(validateEventEnvelope({ payload: {} })).toHaveLength(7);
    expect(validateEventEnvelope({ eventId: uuid, schemaVersion: 1, tenantId: 't', entityId: uuid, occurredAt: '2026-02-30T00:00:00Z', actorRef: { subject: 'x', kind: 'robot' }, correlationId: 'c', payload: {} })).toHaveLength(2);
  });
  test('outbox reports idempotency once and leaves persistence to a consumer', () => {
    expect(validateOutboxRecord({ eventId: uuid, schemaVersion: 1, tenantId: 't', entityId: uuid, occurredAt: '2026-01-01T00:00:00Z', actorRef: { subject: 'x', kind: 'system' }, correlationId: 'c', payload: {} })).toEqual([{ path: 'idempotencyKey', code: 'required', message: 'idempotencyKey required' }]);
  });
  test('idempotency claim validates tenant, event and scope without persistence', () => {
    expect(validateIdempotencyClaim({ tenantId: 't', eventId: uuid, key: 'k', scope: 'tenant:event' })).toEqual([]);
    expect(validateIdempotencyClaim({ tenantId: '', eventId: 'bad', key: '', scope: 'global' })).toHaveLength(4);
  });
  test('file metadata validates type, real dates, category limit and unknowns', () => {
    const base = { originalName: 'x', category: 'identity', contentType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64), version: 1 };
    expect(validateFileMetadata({ ...base, extra: true })).toHaveLength(1);
    expect(validateFileMetadata({ ...base, contentType: 'text/plain' })).toHaveLength(1);
    expect(validateFileMetadata({ ...base, issuedAt: '2026-02-30T00:00:00Z' })).toHaveLength(1);
    expect(validateFileMetadata({ ...base, issuedAt: '2026-02-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' })).toHaveLength(1);
    expect(validateFileMetadata({ ...base, sizeBytes: 10 * 1024 * 1024 + 1 })).toHaveLength(1);
  });
  test('api errors whitelist messages and tolerate malformed input', () => {
    expect(notFoundApiError('c')).toEqual({ code: 'not_found', status: 404, message: 'Resource not found', correlationId: 'c' });
    expect(serializeApiError({ code: 'not_found', message: 'SQL secret', correlationId: 'c', fieldErrors: [null, { field: 'x', code: 'invalid_type', message: 'stack' }, { field: 'y', code: 'evil', message: 'leak' }] })).toEqual({ code: 'not_found', status: 404, message: 'Resource not found', correlationId: 'c', fieldErrors: [{ field: 'x', code: 'invalid_type', message: 'Invalid value' }] });
    expect(serializeApiError(null)).toEqual({ code: 'internal_error', status: 500, message: 'Request failed', correlationId: 'unknown' });
  });
});
