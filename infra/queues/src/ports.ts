import type { OutboxEvent } from '../../../packages/platform/audit/src/types.js';

export interface QueuePublisher {
  /** Implementations must deduplicate by eventId at the delivery boundary. */
  publish(event: OutboxEvent): Promise<void>;
  deadLetter(event: OutboxEvent, reason: string): Promise<void>;
}

export class MemoryQueuePublisher implements QueuePublisher {
  readonly published: OutboxEvent[] = [];
  readonly deadLetters: Array<{ event: OutboxEvent; reason: string }> = [];
  private readonly ids = new Set<string>();

  async publish(event: OutboxEvent): Promise<void> {
    if (this.ids.has(event.eventId)) return;
    this.ids.add(event.eventId);
    this.published.push(event);
  }

  async deadLetter(event: OutboxEvent, reason: string): Promise<void> {
    this.deadLetters.push({ event, reason });
  }
}

export interface QueueMetrics {
  increment(name: 'published' | 'retried' | 'rejected' | 'deadLettered' | 'handlerFailed'): void;
}
