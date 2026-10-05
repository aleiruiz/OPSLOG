import { describe, expect, it } from 'vitest';
import { DeadLetterQueue, InMemoryQueue, type Queue } from './index.js';

const expectMonotonicEnqueueIds = (queue: Queue<string>, prefix: string) => {
  const first = queue.send('first');
  expect(queue.receive()?.messageId).toBe(first.messageId);

  const second = queue.send('second');
  expect(second.messageId).toBe(`${prefix}-2`);
  expect(second.messageId).not.toBe(first.messageId);
};

describe('in-memory queue message IDs', () => {
  it('does not reuse an ID after receiving a message', () => {
    expectMonotonicEnqueueIds(new InMemoryQueue<string>(), 'queue');
  });

  it('uses the same monotonic ID mechanism for dead-letter messages', () => {
    expectMonotonicEnqueueIds(new DeadLetterQueue<string>(), 'dlq');
  });
});
