import type {
  AuditEvent,
  AuditOutboxStore,
  AuditOutboxTransaction,
  OutboxEvent,
  ReconciliationResult,
} from './types.js';

export class MemoryAuditOutboxStore implements AuditOutboxStore {
  readonly audits: AuditEvent[] = [];
  readonly events = new Map<string, OutboxEvent>();

  async transaction<T>(work: (tx: AuditOutboxTransaction) => Promise<T>): Promise<T> {
    const auditsLength = this.audits.length;
    const snapshot = new Map(this.events);
    const tx: AuditOutboxTransaction = {
      appendAudit: async (event) => {
        if (event.tenantId === '') throw new Error('tenant context required');
        this.audits.push(event);
      },
      enqueue: async (event) => {
        if (!event.tenantId) throw new Error('tenant context required');
        if (!this.events.has(event.eventId)) this.events.set(event.eventId, event);
      },
    };
    try {
      return await work(tx);
    } catch (error) {
      this.audits.length = auditsLength;
      this.events.clear();
      for (const [id, event] of snapshot) this.events.set(id, event);
      throw error;
    }
  }

  async claimPending(limit: number, now: Date): Promise<readonly OutboxEvent[]> {
    return [...this.events.values()]
      .filter(
        (event) =>
          event.status === 'pending' && (!event.nextAttemptAt || event.nextAttemptAt <= now),
      )
      .slice(0, limit)
      .map((event) => ({ ...event, status: 'pending' as const }));
  }

  async markPublished(eventId: string): Promise<void> {
    const event = this.events.get(eventId);
    if (event) this.events.set(eventId, { ...event, status: 'published' });
  }

  async markRetry(eventId: string, nextAttemptAt: Date, attempts: number): Promise<void> {
    const event = this.events.get(eventId);
    if (event) this.events.set(eventId, { ...event, attempts, nextAttemptAt });
  }

  async markDeadLettered(eventId: string, attempts: number): Promise<void> {
    const event = this.events.get(eventId);
    if (event) this.events.set(eventId, { ...event, attempts, status: 'dead-lettered' });
  }

  async reconcile(now: Date): Promise<ReconciliationResult> {
    const checked = this.events.size;
    let repaired = 0;
    for (const [id, event] of this.events) {
      if (event.status === 'published' && event.nextAttemptAt) {
        const published = { ...event };
        delete published.nextAttemptAt;
        this.events.set(id, published);
        repaired++;
      }
    }
    const pending = [...this.events.values()].filter(
      (event) => event.status === 'pending' && (!event.nextAttemptAt || event.nextAttemptAt <= now),
    ).length;
    return { checked, repaired, pending, durable: true };
  }
}
