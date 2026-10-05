export type OutboxStatus = 'pending' | 'processing' | 'retry' | 'delivered' | 'dead_letter';
export interface OutboxRecord<T = unknown> { readonly eventId: string; readonly tenantId: string; readonly type: string; readonly payload: T; readonly occurredAt: string; readonly idempotencyKey: string; status: OutboxStatus; attempts: number; availableAt: number; leaseUntil?: number; fencing?: number; lastError?: string; }
export interface EventClaim<T = unknown> { readonly record: OutboxRecord<T>; readonly fencing: number; readonly leaseUntil: number; }
export interface OutboxTransaction { enqueue<T>(record: Omit<OutboxRecord<T>, 'status' | 'attempts' | 'availableAt'>): OutboxRecord<T>; }
export interface OutboxStore { transaction<T>(work: (tx: OutboxTransaction) => T): T; claim<T>(now: number, leaseMs: number, workerId: string): EventClaim<T> | undefined; acknowledge(eventId: string, fencing: number): void; retry(eventId: string, fencing: number, error: string, now: number, maxAttempts: number): OutboxStatus; get(eventId: string): OutboxRecord | undefined; all(): readonly OutboxRecord[]; }
export class InMemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, OutboxRecord>(); private readonly keys = new Map<string, string>(); private fencing = 0;
  transaction<T>(work: (tx: OutboxTransaction) => T): T {
    const staged: OutboxRecord[] = []; const keys = new Set<string>();
    const tx: OutboxTransaction = { enqueue: (input) => {
      const existing = this.records.get(input.eventId) ?? [...this.records.values()].find((r) => r.idempotencyKey === input.idempotencyKey);
      if (existing || keys.has(input.idempotencyKey)) return structuredClone(existing ?? staged.find((r) => r.idempotencyKey === input.idempotencyKey)!) as OutboxRecord<T>;
      const record: OutboxRecord = { ...structuredClone(input), status: 'pending', attempts: 0, availableAt: Date.now() }; staged.push(record); keys.add(record.idempotencyKey); return structuredClone(record) as OutboxRecord<T>;
    }};
    try { const result = work(tx); for (const record of staged) { this.records.set(record.eventId, record); this.keys.set(record.idempotencyKey, record.eventId); } return result; } catch (error) { staged.length = 0; throw error; }
  }
  claim<T>(now: number, leaseMs: number, workerId: string): EventClaim<T> | undefined {
    if (leaseMs <= 0 || !workerId.trim()) throw new Error('valid lease and worker are required');
    const candidate = [...this.records.values()].find((r) => (r.status === 'pending' || r.status === 'retry' || (r.status === 'processing' && (r.leaseUntil ?? 0) <= now)) && r.availableAt <= now);
    if (!candidate) return undefined; this.fencing += 1; candidate.status = 'processing'; candidate.attempts += 1; candidate.fencing = this.fencing; const leaseUntil = now + leaseMs; candidate.leaseUntil = leaseUntil;
    return { record: structuredClone(candidate) as OutboxRecord<T>, fencing: this.fencing, leaseUntil };
  }
  private checked(eventId: string, fencing: number): OutboxRecord { const record = this.records.get(eventId); if (!record) throw new Error('outbox event not found'); if (record.status !== 'processing' || record.fencing !== fencing) throw new Error('stale fencing'); return record; }
  acknowledge(eventId: string, fencing: number): void { this.checked(eventId, fencing).status = 'delivered'; }
  retry(eventId: string, fencing: number, error: string, now: number, maxAttempts: number): OutboxStatus { const record = this.checked(eventId, fencing); record.lastError = error.slice(0, 500); if (record.attempts >= maxAttempts) record.status = 'dead_letter'; else { record.status = 'retry'; record.availableAt = now + backoffMs(record.attempts); } return record.status; }
  get(eventId: string): OutboxRecord | undefined { const record = this.records.get(eventId); return record && structuredClone(record); }
  all(): readonly OutboxRecord[] { return [...this.records.values()].map((record) => structuredClone(record)); }
}
export function backoffMs(attempt: number, baseMs = 1000, capMs = 300_000): number { return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1)); }
