export type OutboxStatus = 'pending' | 'processing' | 'retry' | 'delivered' | 'dead_letter';
export interface OutboxRecord<T = unknown> {
  readonly eventId: string;
  readonly tenantId: string;
  readonly type: string;
  readonly payload: T;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
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
  transaction<T>(work: (tx: OutboxTransaction) => T): T {
    const staged: OutboxRecord[] = [];
    const keys = new Set<string>();
    const store = this;
    const tx: OutboxTransaction = {
      enqueue<T>(input: Omit<OutboxRecord<T>, 'status' | 'attempts' | 'availableAt'>) {
        const recordKey = scopedKey(input.tenantId, input.eventId);
        const eventKey = `event:${recordKey}`;
        const idempotencyKey = `idempotency:${scopedKey(input.tenantId, tuple(input.eventId, input.idempotencyKey))}`;
        const existing = store.records.get(recordKey);
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
          ...structuredClone(input),
          status: 'pending',
          attempts: 0,
          availableAt: Date.now(),
        };
        staged.push(record);
        keys.add(eventKey);
        keys.add(idempotencyKey);
        return structuredClone(record) as OutboxRecord<T>;
      },
    };
    try {
      const result = work(tx);
      for (const record of staged) {
        this.records.set(scopedKey(record.tenantId, record.eventId), record);
      }
      return result;
    } catch (error) {
      staged.length = 0;
      throw error;
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
      record.availableAt = now + backoffMs(record.attempts);
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
function scopedKey(tenantId: string, key: string): string {
  return `${tenantId.length}:${tenantId}${key.length}:${key}`;
}
function tuple(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
export function backoffMs(attempt: number, baseMs = 1000, capMs = 300_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
