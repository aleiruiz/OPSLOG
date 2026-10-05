import type { AuditEvent, AuditStore } from '../../../../packages/platform/audit/src/index.js';
import { redactError } from '../../../../packages/platform/audit/src/index.js';
import type { OutboxStore } from '../../../../packages/platform/outbox/src/index.js';
import { DeadLetterQueue } from '../../../../infra/queues/src/index.js';

export interface TenantDirectory {
  status(tenantId: string): 'active' | 'suspended' | 'missing';
}
export interface WorkerMetrics {
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  rejectedTenants: number;
  handlerFailures: number;
}
export type Handler = (
  payload: unknown,
  event: { eventId: string; tenantId: string; type: string },
) => void | Promise<void>;
export class Worker {
  readonly metrics: WorkerMetrics = {
    claimed: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    rejectedTenants: 0,
    handlerFailures: 0,
  };
  readonly dlq = new DeadLetterQueue<unknown>();
  private readonly handlers = new Map<string, Handler>();
  constructor(
    private readonly store: OutboxStore,
    private readonly tenants: TenantDirectory,
    private readonly audit: AuditStore,
    private readonly workerId: string,
    private readonly leaseMs = 30_000,
    private readonly maxAttempts = 5,
  ) {}
  register(type: string, handler: Handler): void {
    if (this.handlers.has(type)) throw new Error(`handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }
  async process(now = Date.now()): Promise<boolean> {
    const claim = this.store.claim(now, this.leaseMs, this.workerId);
    if (!claim) return false;
    this.metrics.claimed += 1;
    const { record, fencing } = claim;
    if (this.tenants.status(record.tenantId) !== 'active') {
      this.metrics.rejectedTenants += 1;
      this.store.retry(record.eventId, fencing, 'tenant unavailable', now, 1);
      this.dlq.send({
        eventId: record.eventId,
        tenantId: record.tenantId,
        reason: 'tenant unavailable',
      });
      return true;
    }
    const handler = this.handlers.get(record.type);
    if (!handler) {
      this.metrics.handlerFailures += 1;
      const status = this.store.retry(
        record.eventId,
        fencing,
        'handler not registered',
        now,
        this.maxAttempts,
      );
      if (status === 'dead_letter') {
        this.metrics.deadLettered += 1;
        this.dlq.send(record);
      } else this.metrics.retried += 1;
      return true;
    }
    try {
      await handler(record.payload, {
        eventId: record.eventId,
        tenantId: record.tenantId,
        type: record.type,
      });
      this.store.acknowledge(record.eventId, fencing);
      this.metrics.delivered += 1;
      const auditEvent: AuditEvent = {
        eventId: `outbox:${record.eventId}`,
        tenantId: record.tenantId,
        action: 'outbox.delivered',
        entityType: 'outbox',
        entityId: record.eventId,
        occurredAt: new Date(now).toISOString(),
        actor: { id: this.workerId, kind: 'system' },
        correlationId: record.eventId,
        data: { type: record.type, attempts: record.attempts },
      };
      this.audit.append(auditEvent);
      return true;
    } catch (error) {
      this.metrics.handlerFailures += 1;
      const status = this.store.retry(
        record.eventId,
        fencing,
        redactError(error),
        now,
        this.maxAttempts,
      );
      if (status === 'dead_letter') {
        this.metrics.deadLettered += 1;
        this.dlq.send({
          eventId: record.eventId,
          tenantId: record.tenantId,
          reason: 'handler failed',
        });
      } else this.metrics.retried += 1;
      return true;
    }
  }
}
export async function drain(worker: Worker, max = 100): Promise<number> {
  let count = 0;
  while (count < max && (await worker.process())) count += 1;
  return count;
}
