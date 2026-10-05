export interface QueueMessage<T = unknown> { readonly messageId: string; readonly body: T; readonly enqueuedAt: number; }
export interface Queue<T = unknown> { send(body: T): QueueMessage<T>; receive(): QueueMessage<T> | undefined; size(): number; }
export class InMemoryQueue<T = unknown> implements Queue<T> {
  private readonly messages: QueueMessage<T>[] = [];
  constructor(private readonly id = 'queue') {}
  send(body: T): QueueMessage<T> { const message = { messageId: `${this.id}-${this.messages.length + 1}`, body: structuredClone(body), enqueuedAt: Date.now() }; this.messages.push(message); return structuredClone(message); }
  receive(): QueueMessage<T> | undefined { const message = this.messages.shift(); return message && structuredClone(message); }
  size(): number { return this.messages.length; }
}
export class DeadLetterQueue<T = unknown> extends InMemoryQueue<T> { constructor() { super('dlq'); } }
