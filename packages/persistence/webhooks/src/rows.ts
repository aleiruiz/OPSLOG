import {
  isWebhookEvent,
  type AttemptOutcome,
  type Delivery,
  type DeliveredEvent,
  type DeliveryStatus,
  type Endpoint,
  type WebhookEvent,
} from '../../../domain/webhooks/src/index.js';

export type Row = Record<string, unknown>;
export const DUPLICATE_KEY = 1062;
export const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as Date).toISOString();
export const date = (value: string | null): Date | null =>
  value === null ? null : new Date(value);
export const flag = (value: unknown): boolean => value === true || Number(value) === 1;
export const errno = (error: unknown): number | undefined =>
  (error as { driverError?: { errno?: number }; errno?: number }).driverError?.errno ??
  (error as { errno?: number }).errno;
export const affected = (result: unknown): number => {
  const raw = result as { affectedRows?: number; affected?: number } | undefined;
  return raw?.affectedRows ?? raw?.affected ?? 0;
};
const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export function endpoint(row: Row): Endpoint {
  const stored = typeof row.events === 'string' ? JSON.parse(row.events) : row.events;
  return {
    id: row.id as string,
    tenantId: row.company_id as string,
    url: row.url as string,
    events: (stored as unknown[]).filter(isWebhookEvent) as WebhookEvent[],
    active: flag(row.active),
    disabledReason: (row.disabled_reason as 'failures' | null) ?? null,
    companyRef: row.company_ref as string,
    secretSealed: row.secret_sealed as string,
    previousSealed: (row.previous_sealed as string | null) ?? null,
    previousExpiresAt: iso(row.previous_expires_at),
    consecutiveFailures: Number(row.consecutive_failures),
    version: Number(row.version),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    createdBy: row.created_by as string,
  };
}

export function delivery(row: Row): Delivery {
  return {
    id: row.id as string,
    tenantId: row.company_id as string,
    endpointId: row.endpoint_id as string,
    eventId: row.event_id as string,
    eventType: row.event_type as DeliveredEvent,
    body: row.body as string,
    status: row.status as DeliveryStatus,
    attempts: Number(row.attempts),
    manual: flag(row.manual),
    nextAttemptAt: iso(row.next_attempt_at),
    leaseUntil: iso(row.lease_until),
    lastAttemptAt: iso(row.last_attempt_at),
    lastStatusCode: nullableNumber(row.last_status_code),
    lastDurationMs: nullableNumber(row.last_duration_ms),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  };
}

/** The SET clause and parameters that record the outcome of an attempt. */
export function outcomeChange(outcome: AttemptOutcome): { sql: string; params: unknown[] } {
  const common = 'attempts = attempts + 1, manual = 0, last_status_code = ?, last_duration_ms = ?';
  const measured = [outcome.statusCode, outcome.durationMs];
  if (outcome.kind === 'delivered')
    return {
      sql: `status = 'delivered', ${common}, last_error = NULL, next_attempt_at = NULL`,
      params: measured,
    };
  if (outcome.kind === 'retry')
    return {
      sql: `status = 'failed', ${common}, last_error = ?, next_attempt_at = ?`,
      params: [...measured, outcome.error, new Date(outcome.nextAttemptAt)],
    };
  return {
    sql: `status = 'dead_letter', ${common}, last_error = ?, next_attempt_at = NULL`,
    params: [...measured, outcome.error],
  };
}
