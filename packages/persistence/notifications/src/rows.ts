import type {
  Channel,
  DeliveryOutcome,
  DeliveryStatus,
  EntityType,
  EventKind,
  Notification,
  NotificationDelivery,
  NotificationFilter,
  Severity,
} from '../../../domain/notifications/src/index.js';

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
export const marks = (count: number): string => Array.from({ length: count }, () => '?').join(',');

export function notice(row: Row): Notification {
  return {
    id: row.id as string,
    tenantId: row.company_id as string,
    recipientId: row.recipient_id as string,
    eventKind: row.event_kind as EventKind,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id as string,
    title: row.title as string,
    link: row.link as string,
    severity: row.severity as Severity,
    createdAt: iso(row.created_at) as string,
    readAt: iso(row.read_at),
    inApp: flag(row.in_app),
  };
}

export function delivery(row: Row): NotificationDelivery {
  return {
    tenantId: row.company_id as string,
    notificationId: row.notification_id as string,
    channel: row.channel as Channel,
    status: row.status as DeliveryStatus,
    attempts: Number(row.attempts),
    lastError: (row.last_error as string | null) ?? null,
    nextAttemptAt: iso(row.next_attempt_at),
    leaseUntil: iso(row.lease_until),
    updatedAt: iso(row.updated_at) as string,
  };
}

/** The filter of the center as SQL; every statement starts from the company and the person. */
export function center(tenantId: string, recipientId: string, filter: NotificationFilter) {
  const clauses = ['company_id = ?', 'recipient_id = ?', 'in_app = 1'];
  const params: unknown[] = [tenantId, recipientId];
  clauses.push(`event_kind IN (${marks(filter.kinds.length)})`);
  params.push(...filter.kinds);
  if (filter.kind !== undefined) {
    clauses.push('event_kind = ?');
    params.push(filter.kind);
  }
  if (filter.unreadOnly) clauses.push('read_at IS NULL');
  return { where: clauses.join(' AND '), params };
}

/** The SET clause and parameters that record an outcome of a send. */
export function outcomeChange(outcome: DeliveryOutcome): { sql: string; params: unknown[] } {
  const set: Record<DeliveryOutcome['status'], { sql: string; params: unknown[] }> = {
    deferred: {
      sql: 'next_attempt_at = ?',
      params: [date((outcome as { nextAttemptAt?: string }).nextAttemptAt ?? null)],
    },
    suppressed: {
      sql: "status = 'suppressed', last_error = ?, next_attempt_at = NULL",
      params: [(outcome as { reason?: string }).reason ?? null],
    },
    sent: { sql: "status = 'sent', attempts = attempts + 1, next_attempt_at = NULL", params: [] },
    retry: {
      sql: 'attempts = attempts + 1, last_error = ?, next_attempt_at = ?',
      params: [
        (outcome as { error?: string }).error ?? null,
        date((outcome as { nextAttemptAt?: string }).nextAttemptAt ?? null),
      ],
    },
    failed: {
      sql: "status = 'failed', attempts = attempts + 1, last_error = ?, next_attempt_at = NULL",
      params: [(outcome as { error?: string }).error ?? null],
    },
  };
  return set[outcome.status];
}
