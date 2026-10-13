import { createHash } from 'node:crypto';
import {
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_TTL_MS,
  canonicalJson,
} from '../../../maintenance/orders/src/idempotency.js';
import type { Incident } from './types.js';

export { IDEMPOTENCY_KEY, IDEMPOTENCY_TTL_MS, canonicalJson };

/** SHA-256 of the canonical command: the target (an incident id, or `new`), the command and the payload. */
export const payloadHash = (target: string, command: string, payload: unknown): string =>
  createHash('sha256').update(canonicalJson({ target, command, payload })).digest('hex');

/** What a command claims in the mutation that applies it; the store records the incident as the response. */
export interface IdempotencyClaim {
  readonly actorId: string;
  readonly command: string;
  readonly key: string;
  readonly incidentId: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}
/** Stored key of one (tenant, actor, command, key); the response is kept unfiltered and shaped per caller on replay. */
export interface IdempotencyRecord extends IdempotencyClaim {
  readonly tenantId: string;
  readonly status: 'completed';
  readonly response: Incident;
}
