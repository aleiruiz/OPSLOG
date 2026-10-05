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

describe('in-memory queue size and ordering', () => {
  it('reports the number of pending messages and drains FIFO', () => {
    const queue = new InMemoryQueue<string>();
    expect(queue.size()).toBe(0);
    expect(queue.receive()).toBeUndefined();
    queue.send('a');
    queue.send('b');
    expect(queue.size()).toBe(2);
    expect(queue.receive()?.body).toBe('a');
    expect(queue.size()).toBe(1);
    expect(queue.receive()?.body).toBe('b');
    expect(queue.size()).toBe(0);
  });

  it('isolates stored messages from caller mutation', () => {
    const queue = new InMemoryQueue<{ n: number }>();
    const body = { n: 1 };
    const sent = queue.send(body);
    body.n = 2;
    (sent.body as { n: number }).n = 3;
    expect(queue.receive()?.body).toEqual({ n: 1 });
  });
});
