import type { AuditEvent, AuditStore } from '../../../../packages/platform/audit/src/index.js';
import { redactError } from '../../../../packages/platform/audit/src/index.js';
import type { OutboxStore } from '../../../../packages/platform/outbox/src/index.js';
import { DeadLetterQueue } from '../../../../infra/queues/src/index.js';

export interface TenantDirectory {
  status(tenantId: string): 'active' | 'suspended' | 'missing';
}
/**
 * Re-checks the CURRENT permission of the actor that enqueued a job. Implemented by the
 * composition on top of the server-side membership/role directory. Throwing counts as denied.
 */
export interface ActorPermissionCheck {
  allows(
    tenantId: string,
    actor: { readonly subject: string; readonly kind: 'user' | 'api_key' | 'system' },
    permission: string | undefined,
  ): boolean | Promise<boolean>;
}
export interface WorkerMetrics {
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  rejectedTenants: number;
  rejectedActors: number;
  handlerFailures: number;
  auditFailures: number;
  staleLeases: number;
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
    rejectedActors: 0,
    handlerFailures: 0,
    auditFailures: 0,
    staleLeases: 0,
  };
  readonly dlq = new DeadLetterQueue<unknown>();
  private readonly handlers = new Map<string, Handler>();
  constructor(
    private readonly store: OutboxStore,
    private readonly tenants: TenantDirectory,
    private readonly audit: AuditStore,
    private readonly workerId: string,
    private readonly leaseMs = 30_000,
    // First try plus five retries (SPECS delivery schedule).
    private readonly maxAttempts = 6,
    private readonly clock: () => number = Date.now,
    // Without a check, jobs enqueued by a user actor fail closed.
    private readonly actors?: ActorPermissionCheck,
  ) {}
  register(type: string, handler: Handler): void {
    if (this.handlers.has(type)) throw new Error(`handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }
  async process(explicitNow?: number): Promise<boolean> {
    const now = explicitNow ?? this.clock();
    const claim = await this.store.claim(now, this.leaseMs, this.workerId);
    if (!claim) return false;
    this.metrics.claimed += 1;
    const { record, fencing } = claim;
    if (record.attempts > this.maxAttempts) {
      // Reclaimed after repeated lease expiries without ever reaching a terminal state.
      await this.guarded(async () => {
        await this.store.retry(
          record.tenantId,
          record.eventId,
          fencing,
          'attempts exhausted',
          now,
          this.maxAttempts,
        );
        this.metrics.deadLettered += 1;
        this.dlq.send({
          eventId: record.eventId,
          tenantId: record.tenantId,
          reason: 'attempts exhausted',
          type: record.type,
          attempts: record.attempts,
        });
      });
      return true;
    }
    if (!record.handlerCompleted && this.tenants.status(record.tenantId) !== 'active') {
      this.metrics.rejectedTenants += 1;
      await this.guarded(async () => {
        await this.store.retry(
          record.tenantId,
          record.eventId,
          fencing,
          'tenant unavailable',
          now,
          1,
        );
        this.metrics.deadLettered += 1;
        this.dlq.send({
          eventId: record.eventId,
          tenantId: record.tenantId,
          reason: 'tenant unavailable',
        });
      });
      return true;
    }
    if (
      !record.handlerCompleted &&
      record.actorRef !== undefined &&
      record.actorRef.kind !== 'system' &&
      !(await this.actorStillAllowed(record))
    ) {
      this.metrics.rejectedActors += 1;
      await this.guarded(async () => {
        await this.store.retry(
          record.tenantId,
          record.eventId,
          fencing,
          'actor not permitted',
          now,
          1,
        );
        this.metrics.deadLettered += 1;
        this.dlq.send({
          eventId: record.eventId,
          tenantId: record.tenantId,
          reason: 'actor not permitted',
        });
      });
      return true;
    }
    const handler = this.handlers.get(record.type);
    if (!record.handlerCompleted && !handler) {
      await this.guarded(async () => {
        this.metrics.handlerFailures += 1;
        const status = await this.store.retry(
          record.tenantId,
          record.eventId,
          fencing,
          'handler not registered',
          now,
          this.maxAttempts,
        );
        if (status === 'dead_letter') {
          this.metrics.deadLettered += 1;
          this.dlq.send({
            eventId: record.eventId,
            tenantId: record.tenantId,
            reason: 'handler not registered',
            type: record.type,
            attempts: record.attempts,
          });
        } else this.metrics.retried += 1;
      });
      return true;
    }
    if (!record.handlerCompleted && handler) {
      try {
        await handler(record.payload, {
          eventId: record.eventId,
          tenantId: record.tenantId,
          type: record.type,
        });
      } catch (error) {
        // Backoff counts from the failure, not from the claim: a slow handler must not retry immediately.
        const failedAt = explicitNow ?? this.clock();
        await this.guarded(async () => {
          this.metrics.handlerFailures += 1;
          const status = await this.store.retry(
            record.tenantId,
            record.eventId,
            fencing,
            redactError(error),
            failedAt,
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
        });
        return true;
      }
      const checkpointed = await this.guarded(() =>
        this.store.markHandlerCompleted(record.tenantId, record.eventId, fencing),
      );
      if (!checkpointed) return true;
    }
    const deliveredAt = explicitNow ?? this.clock();
    const auditEvent: AuditEvent = {
      eventId: `outbox:${record.eventId}`,
      tenantId: record.tenantId,
      action: 'outbox.delivered',
      entityType: 'outbox',
      entityId: record.eventId,
      occurredAt: new Date(deliveredAt).toISOString(),
      actor: { id: this.workerId, kind: 'system' },
      correlationId: record.correlationId ?? record.eventId,
      data: { type: record.type, attempts: record.attempts },
    };
    try {
      await this.audit.append(auditEvent);
    } catch {
      // Keep the claim processing until lease expiry. The handler checkpoint is already stored,
      // so reclaiming retries only the audit append and never re-invokes the handler.
      this.metrics.auditFailures += 1;
      return true;
    }
    await this.guarded(async () => {
      await this.store.acknowledge(record.tenantId, record.eventId, fencing);
      this.metrics.delivered += 1;
    });
    return true;
  }
  /** Fails closed: no check wired, or a check that throws, means the actor is not permitted. */
  private async actorStillAllowed(record: {
    tenantId: string;
    actorRef?: { subject: string; kind: 'user' | 'api_key' | 'system' };
    requiredPermission?: string;
  }): Promise<boolean> {
    if (!this.actors || !record.actorRef) return false;
    try {
      return (
        (await this.actors.allows(record.tenantId, record.actorRef, record.requiredPermission)) ===
        true
      );
    } catch {
      return false;
    }
  }
  /** Runs a fenced store mutation; a lost lease drops the claim instead of crashing the drain loop. */
  private async guarded(work: () => void | Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/^(stale fencing|outbox event not found)$/.test(error.message)
      )
        throw error;
      this.metrics.staleLeases += 1;
      return false;
    }
  }
}
export async function drain(worker: Worker, max = 100): Promise<number> {
  let count = 0;
  while (count < max && (await worker.process())) count += 1;
  return count;
}
