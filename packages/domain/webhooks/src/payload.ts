import { createHash, randomBytes } from 'node:crypto';
import { MAX_BODY_BYTES, SCHEMA_VERSION } from './catalog.js';
import { WebhookError } from './errors.js';
import type { Endpoint, PublicEvent } from './types.js';

/** Opaque, stable id of the fact an event announces: `evt_` plus a digest of the company and the fact. */
export function eventIdOf(tenantId: string, factKey: string): string {
  return `evt_${createHash('sha256').update(`${tenantId}\u0000${factKey}`).digest('hex').slice(0, 32)}`;
}
export const randomEventId = (): string => `evt_${randomBytes(16).toString('hex')}`;
export const newCompanyRef = (): string => `co_${randomBytes(12).toString('base64url')}`;

/**
 * The exact body of a delivery (SPECS §7): `{id, type, schemaVersion, occurredAt, companyRef, data}`.
 * `companyRef` is per endpoint, never the internal company id; `data` holds ids, folios and states.
 */
export function bodyOf(endpoint: Pick<Endpoint, 'companyRef'>, event: PublicEvent): string {
  const body = JSON.stringify({
    id: event.eventId,
    type: event.type,
    schemaVersion: SCHEMA_VERSION,
    occurredAt: event.occurredAt,
    companyRef: endpoint.companyRef,
    data: event.data,
  });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new WebhookError('invalid_input', 'data');
  return body;
}
