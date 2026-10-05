import { describe, expect, test } from 'vitest';
import {
  serializeApiError,
  validateCreateIncident,
  validateEventEnvelope,
  validateFileMetadata,
  validateIdempotencyClaim,
  validateOutboxRecord,
  validatePageQuery,
} from './index';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
const notObject = [{ path: '', code: 'invalid_type', message: 'Expected object' }];
const paths = (errors: { path: string }[]) => errors.map((error) => error.path);

describe('FND-CONTRACTS validator branches', () => {
  test('every validator rejects non-objects', () => {
    for (const validate of [
      validatePageQuery,
      validateCreateIncident,
      validateEventEnvelope,
      validateOutboxRecord,
      validateIdempotencyClaim,
      validateFileMetadata,
    ]) {
      expect(validate(null)).toEqual(notObject);
      expect(validate([])).toEqual(notObject);
      expect(validate('x')).toEqual(notObject);
    }
  });

  test('page query rejects a non-string cursor and a bad direction', () => {
    expect(paths(validatePageQuery({ limit: 25, cursor: 5, direction: 'up' }))).toEqual([
      'cursor',
      'direction',
    ]);
    expect(validatePageQuery({ limit: 100, cursor: 'abc', direction: 'asc' })).toEqual([]);
    expect(validatePageQuery({})).toEqual([]);
  });

  test('create incident validates optional fields', () => {
    expect(
      paths(
        validateCreateIncident({
          vehicleId: uuid,
          type: 'collision',
          occurredAt: 'yesterday',
          driverId: 'nope',
        }),
      ),
    ).toEqual(['occurredAt', 'driverId']);
    expect(
      validateCreateIncident({
        vehicleId: uuid,
        type: 'collision',
        occurredAt: '2026-01-01T00:00:00Z',
        driverId: uuid,
      }),
    ).toEqual([]);
  });

  test('event envelope rejects bad schema versions and missing actors', () => {
    const base = {
      eventId: uuid,
      tenantId: 't',
      entityId: uuid,
      occurredAt: '2026-01-01T00:00:00Z',
      correlationId: 'c',
      payload: {},
    };
    expect(paths(validateEventEnvelope({ ...base, schemaVersion: 0, actorRef: null }))).toEqual([
      'schemaVersion',
      'actorRef',
    ]);
    expect(paths(validateEventEnvelope({ ...base, schemaVersion: 1.5, actorRef: 'x' }))).toEqual([
      'schemaVersion',
      'actorRef',
    ]);
    expect(
      validateEventEnvelope({
        ...base,
        schemaVersion: 1,
        actorRef: { subject: 'x', kind: 'system' },
      }),
    ).toEqual([]);
  });

  test('outbox record rejects non-string idempotency keys and accepts a valid record', () => {
    const record = {
      eventId: uuid,
      schemaVersion: 1,
      tenantId: 't',
      entityId: uuid,
      occurredAt: '2026-01-01T00:00:00Z',
      actorRef: { subject: 'x', kind: 'system' },
      correlationId: 'c',
      payload: {},
    };
    expect(paths(validateOutboxRecord({ ...record, idempotencyKey: 5 }))).toEqual([
      'idempotencyKey',
    ]);
    expect(validateOutboxRecord({ ...record, idempotencyKey: 'k' })).toEqual([]);
  });

  test('file metadata rejects bad categories, sizes, hashes, versions and dates', () => {
    const base = {
      originalName: 'x',
      category: 'identity',
      contentType: 'application/pdf',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      version: 1,
    };
    expect(paths(validateFileMetadata({ ...base, category: 5 }))).toEqual(['category']);
    expect(paths(validateFileMetadata({ ...base, category: 'nope' }))).toEqual(['category']);
    expect(paths(validateFileMetadata({ ...base, sizeBytes: 0 }))).toEqual(['sizeBytes']);
    expect(paths(validateFileMetadata({ ...base, sizeBytes: 1.5 }))).toEqual(['sizeBytes']);
    expect(paths(validateFileMetadata({ ...base, sha256: 'zz' }))).toEqual(['sha256']);
    expect(paths(validateFileMetadata({ ...base, sha256: undefined }))).toEqual(['sha256']);
    expect(paths(validateFileMetadata({ ...base, version: 0 }))).toEqual(['version']);
    expect(paths(validateFileMetadata({ ...base, originalName: ' ' }))).toEqual(['originalName']);
    expect(paths(validateFileMetadata({ ...base, expiresAt: 'later' }))).toEqual(['expiresAt']);
    expect(
      validateFileMetadata({
        ...base,
        issuedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-02-01T00:00:00Z',
      }),
    ).toEqual([]);
  });
});

describe('serializeApiError', () => {
  test('falls back to internal_error for unknown input', () => {
    expect(serializeApiError(undefined)).toMatchObject({
      code: 'internal_error',
      status: 500,
      correlationId: 'unknown',
    });
    expect(serializeApiError({ code: 'bogus', correlationId: ' c-1 ' })).toMatchObject({
      code: 'internal_error',
      correlationId: 'c-1',
    });
  });

  test('keeps only known field errors and trimmed missing requirements', () => {
    const result = serializeApiError({
      code: 'unprocessable_entity',
      correlationId: 'c',
      fieldErrors: [
        { field: 'name', code: 'required', message: 'leaks <script>' },
        { field: 'age', code: 'made_up' },
        { field: '', code: 'required' },
        'not an object',
      ],
      missingRequirements: [' licencia ', '', 7],
    });
    expect(result).toMatchObject({
      code: 'unprocessable_entity',
      status: 422,
      fieldErrors: [{ field: 'name', code: 'required', message: 'Field is required' }],
      missingRequirements: ['licencia'],
    });
    const none = serializeApiError({
      code: 'bad_request',
      fieldErrors: [{ field: 'x', code: 'made_up' }],
      missingRequirements: [''],
    });
    expect(none).not.toHaveProperty('fieldErrors');
    expect(none).not.toHaveProperty('missingRequirements');
  });
});
