import { createHash } from 'node:crypto';
import { WorkOrderError } from './errors.js';
import type { WorkOrder, WorkOrderCommand } from './types.js';

/** What a key can protect: a status command, or the creation of a corrective order. */
export type IdempotentCommand = WorkOrderCommand | 'create';

/** Header value format (SPECS:195): 8-128 characters of [A-Za-z0-9_-]. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
/** A key is remembered for 24 hours; after that the same key is a new command. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Financial-impact commands that cannot be retried without the defence: the header is mandatory. */
export const IDEMPOTENCY_REQUIRED_COMMANDS: readonly WorkOrderCommand[] = ['close', 'reopen'];

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value))
    throw new WorkOrderError('invalid_input');
  return value;
}

/** Deterministic JSON: object keys sorted, `undefined` members dropped, so equal payloads hash equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, member]) => `${JSON.stringify(name)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of the canonical command: the order, the command and the whole payload (version included). */
export const payloadHash = (
  orderId: string,
  command: IdempotentCommand,
  payload: unknown,
): string =>
  createHash('sha256').update(canonicalJson({ orderId, command, payload })).digest('hex');

/** What a command claims in the mutation that applies it; the store records `order` as the response. */
export interface IdempotencyClaim {
  readonly actorId: string;
  readonly command: IdempotentCommand;
  readonly key: string;
  readonly orderId: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}
/**
 * Stored key of one (tenant, actor, command, key). `response` is the order the caller received, kept
 * unfiltered: `view_costs` is applied to the caller at read time, never baked into the record.
 */
export interface IdempotencyRecord extends IdempotencyClaim {
  readonly tenantId: string;
  readonly status: 'completed';
  readonly response: WorkOrder;
}
