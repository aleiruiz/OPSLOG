import type {
  AuditOutboxStore,
  OutboxEvent,
  TenantContext,
} from '../../../../packages/platform/audit/src/types.js';
import type { QueueMetrics, QueuePublisher } from '../../../../infra/queues/src/ports.js';

export interface TenantResolver {
  resolve(tenantId: string): Promise<TenantContext | 'suspended' | 'missing'>;
}

export type JobHandler = (event: OutboxEvent, context: TenantContext) => Promise<void>;

export interface DispatcherOptions {
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export class TenantJobDispatcher {
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: AuditOutboxStore,
    private readonly publisher: QueuePublisher,
    private readonly resolver: TenantResolver,
    private readonly metrics: QueueMetrics,
    private readonly handlers: ReadonlyMap<string, JobHandler> = new Map(),
    options: DispatcherOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  async dispatch(limit: number): Promise<number> {
    const events = await this.store.claimPending(limit, this.now());
    for (const event of events) await this.dispatchOne(event);
    return events.length;
  }

  async reconcile(): Promise<Awaited<ReturnType<AuditOutboxStore['reconcile']>>> {
    return this.store.reconcile(this.now());
  }

  private async dispatchOne(event: OutboxEvent): Promise<void> {
    const status = await this.resolver.resolve(event.tenantId);
    if (status === 'missing' || status === 'suspended') {
      this.metrics.increment('rejected');
      await this.store.markDeadLettered(event.eventId, event.attempts + 1);
      await this.publisher.deadLetter(event, `tenant-${status}`);
      return;
    }
    try {
      const handler = this.handlers.get(event.type);
      if (handler) await handler(event, status);
      await this.publisher.publish(event);
      await this.store.markPublished(event.eventId);
      this.metrics.increment('published');
    } catch (error) {
      this.metrics.increment('handlerFailed');
      const attempts = event.attempts + 1;
      if (attempts >= this.maxAttempts) {
        await this.store.markDeadLettered(event.eventId, attempts);
        await this.publisher.deadLetter(
          event,
          error instanceof Error ? error.message : 'publish failed',
        );
        this.metrics.increment('deadLettered');
      } else {
        const next = new Date(this.now().getTime() + 2 ** attempts * 1000);
        await this.store.markRetry(event.eventId, next, attempts);
        this.metrics.increment('retried');
      }
    }
  }
}
