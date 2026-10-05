import { isDeepStrictEqual } from 'node:util';

export type OutboxStatus = 'pending' | 'processing' | 'retry' | 'delivered' | 'dead_letter';
export interface OutboxRecord<T = unknown> {
  readonly eventId: string;
  readonly tenantId: string;
  readonly type: string;
  readonly payload: T;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  /** Request correlation and actor of the operation that enqueued the event (SPECS event envelope). */
  readonly correlationId?: string;
  readonly actorRef?: { readonly subject: string; readonly kind: 'user' | 'api_key' | 'system' };
  readonly entityId?: string;
  readonly schemaVersion?: number;
  status: OutboxStatus;
  attempts: number;
  availableAt: number;
  leaseUntil?: number;
  fencing?: number;
  lastError?: string;
  handlerCompleted?: boolean;
}
export interface EventClaim<T = unknown> {
  readonly record: OutboxRecord<T>;
  readonly fencing: number;
  readonly leaseUntil: number;
}
export interface OutboxTransaction {
  enqueue<T>(record: Omit<OutboxRecord<T>, 'status' | 'attempts' | 'availableAt'>): OutboxRecord<T>;
}
export class OutboxConflictError extends Error {
  readonly code = 'OUTBOX_EVENT_CONFLICT';
  constructor() {
    super('Event id was already used with a different event');
    this.name = 'OutboxConflictError';
  }
}
export interface OutboxStore {
  transaction<T>(work: (tx: OutboxTransaction) => T): T;
  claim<T>(now: number, leaseMs: number, workerId: string): EventClaim<T> | undefined;
  markHandlerCompleted(tenantId: string, eventId: string, fencing: number): void;
  acknowledge(tenantId: string, eventId: string, fencing: number): void;
  retry(
    tenantId: string,
    eventId: string,
    fencing: number,
    error: string,
    now: number,
    maxAttempts: number,
  ): OutboxStatus;
  reconcile(now: number): number;
  get(tenantId: string, eventId: string): OutboxRecord | undefined;
  all(): readonly OutboxRecord[];
}
/**
 * In-memory reference adapter. Durable adapters must persist handlerCompleted with
 * the lease/fencing state so an audit retry cannot repeat a completed side effect.
 * Handlers must also be idempotent by (tenantId, eventId) across a crash between
 * the external side effect and this completion checkpoint.
 */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, OutboxRecord>();
  private fencing = 0;
  private inTransaction = false;
  constructor(
    private readonly clock: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}
  transaction<T>(work: (tx: OutboxTransaction) => T): T {
    if (this.inTransaction) throw new Error('nested outbox transactions are not supported');
    this.inTransaction = true;
    const staged: OutboxRecord[] = [];
    const keys = new Set<string>();
    const store = this;
    let closed = false;
    const tx: OutboxTransaction = {
      enqueue<T>(input: Omit<OutboxRecord<T>, 'status' | 'attempts' | 'availableAt'>) {
        if (closed) throw new Error('transaction is closed');
        // Event ids become audit keys (`outbox:<eventId>`), so they must be opaque identifiers.
        if (!EVENT_ID.test(input.eventId) || !TENANT_ID.test(input.tenantId))
          throw new Error('event and tenant ids must be opaque identifiers');
        const recordKey = scopedKey(input.tenantId, input.eventId);
        const eventKey = `event:${recordKey}`;
        const idempotencyKey = `idempotency:${scopedKey(input.tenantId, tuple(input.eventId, input.idempotencyKey))}`;
        const existing = store.records.get(recordKey);
        const sameEventStaged = staged.find((r) => scopedKey(r.tenantId, r.eventId) === recordKey);
        const prior = existing ?? sameEventStaged;
        if (
          prior &&
          (prior.type !== input.type ||
            !isDeepStrictEqual(prior.payload, structuredClone(input.payload)))
        )
          throw new OutboxConflictError();
        if (existing || keys.has(eventKey) || keys.has(idempotencyKey))
          return structuredClone(
            existing ??
              staged.find(
                (r) =>
                  `event:${scopedKey(r.tenantId, r.eventId)}` === eventKey ||
                  `idempotency:${scopedKey(r.tenantId, tuple(r.eventId, r.idempotencyKey))}` ===
                    idempotencyKey,
              )!,
          ) as OutboxRecord<T>;
        const record: OutboxRecord = {
          eventId: input.eventId,
          tenantId: input.tenantId,
          type: input.type,
          payload: structuredClone(input.payload),
          occurredAt: input.occurredAt,
          idempotencyKey: input.idempotencyKey,
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          ...(input.actorRef === undefined ? {} : { actorRef: structuredClone(input.actorRef) }),
          ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
          ...(input.schemaVersion === undefined ? {} : { schemaVersion: input.schemaVersion }),
          status: 'pending',
          attempts: 0,
          availableAt: store.clock(),
        };
        staged.push(record);
        keys.add(eventKey);
        keys.add(idempotencyKey);
        return structuredClone(record) as OutboxRecord<T>;
      },
    };
    try {
      const result = work(tx);
      if (isThenable(result)) {
        // An async callback would commit before it settles, so a later rejection could not roll back.
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('outbox transactions must be synchronous');
      }
      closed = true;
      for (const record of staged) {
        this.records.set(scopedKey(record.tenantId, record.eventId), record);
      }
      return result;
    } catch (error) {
      closed = true;
      staged.length = 0;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  claim<T>(now: number, leaseMs: number, workerId: string): EventClaim<T> | undefined {
    if (leaseMs <= 0 || !workerId.trim()) throw new Error('valid lease and worker are required');
    const candidate = [...this.records.values()].find(
      (r) =>
        (r.status === 'pending' ||
          r.status === 'retry' ||
          (r.status === 'processing' && (r.leaseUntil ?? 0) <= now)) &&
        r.availableAt <= now,
    );
    if (!candidate) return undefined;
    this.fencing += 1;
    candidate.status = 'processing';
    candidate.attempts += 1;
    candidate.fencing = this.fencing;
    const leaseUntil = now + leaseMs;
    candidate.leaseUntil = leaseUntil;
    return {
      record: structuredClone(candidate) as OutboxRecord<T>,
      fencing: this.fencing,
      leaseUntil,
    };
  }
  private checked(tenantId: string, eventId: string, fencing: number): OutboxRecord {
    const record = this.records.get(scopedKey(tenantId, eventId));
    if (!record) throw new Error('outbox event not found');
    if (record.fencing !== fencing) throw new Error('stale fencing');
    return record;
  }
  markHandlerCompleted(tenantId: string, eventId: string, fencing: number): void {
    const record = this.checked(tenantId, eventId, fencing);
    if (record.status !== 'processing') throw new Error('stale fencing');
    record.handlerCompleted = true;
  }
  acknowledge(tenantId: string, eventId: string, fencing: number): void {
    const record = this.checked(tenantId, eventId, fencing);
    if (record.status === 'delivered') return;
    if (record.status !== 'processing') throw new Error('stale fencing');
    if (!record.handlerCompleted) throw new Error('handler not completed');
    record.status = 'delivered';
  }
  retry(
    tenantId: string,
    eventId: string,
    fencing: number,
    error: string,
    now: number,
    maxAttempts: number,
  ): OutboxStatus {
    const record = this.checked(tenantId, eventId, fencing);
    if (record.status === 'retry' || record.status === 'dead_letter') return record.status;
    if (record.status !== 'processing') throw new Error('stale fencing');
    record.lastError = error.slice(0, 500);
    if (record.attempts >= maxAttempts) record.status = 'dead_letter';
    else {
      record.status = 'retry';
      record.availableAt = now + backoffMs(record.attempts, this.random);
    }
    return record.status;
  }
  reconcile(now: number): number {
    let count = 0;
    for (const record of this.records.values())
      if (record.status === 'processing' && (record.leaseUntil ?? 0) <= now) {
        record.status = 'retry';
        record.availableAt = now;
        record.lastError = 'lease expired';
        count += 1;
      }
    return count;
  }
  get(tenantId: string, eventId: string): OutboxRecord | undefined {
    const record = this.records.get(scopedKey(tenantId, eventId));
    return record && structuredClone(record);
  }
  all(): readonly OutboxRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
function scopedKey(tenantId: string, key: string): string {
  return `${tenantId.length}:${tenantId}${key.length}:${key}`;
}
function tuple(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
/** SPECS delivery schedule: first try, then retries after 1m/5m/30m/2h/12h (attempt = tries so far). */
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000] as const;
/** Delay before the next try with +/-20% jitter; `random` returns [0, 1), so 0.5 gives the exact schedule. */
export function backoffMs(attempt: number, random: () => number = () => 0.5): number {
  const index = Math.min(Math.max(1, attempt), RETRY_DELAYS_MS.length) - 1;
  return Math.round(RETRY_DELAYS_MS[index]! * (0.8 + 0.4 * random()));
}
