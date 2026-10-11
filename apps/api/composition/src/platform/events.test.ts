import { describe, expect, it, vi } from 'vitest';
import { publish } from './events.js';
import type { PlatformKernel } from './kernel.js';
import type {
  OutboxStore,
  OutboxTransaction,
} from '../../../../../packages/platform/outbox/src/index.js';

describe('publish with a caller transaction', () => {
  const manager = { queryRunner: { isTransactionActive: true } };
  const makeKernel = (transaction: OutboxStore['transaction']) =>
    ({
      authorize: async () => ({ tenantId: 'tenant-a', actor: { subject: 'actor-a' } }),
      outbox: { transaction },
      now: () => new Date('2026-10-09T12:00:00.000Z'),
    }) as unknown as PlatformKernel;

  it('passes the caller EntityManager to durable enqueue', async () => {
    const enqueue = vi.fn();
    const transaction = vi.fn(async (_manager: unknown, work: (tx: OutboxTransaction) => unknown) =>
      work({ enqueue }),
    );
    const kernel = makeKernel(transaction as unknown as OutboxStore['transaction']);

    await expect(
      publish(
        kernel,
        'token',
        'correlation-a',
        (emit) =>
          emit({
            eventId: 'event-a',
            type: 'synthetic.created',
            entityId: 'entity-a',
            payload: { value: 'synthetic' },
            idempotencyKey: 'event-a',
          }),
        'create',
        manager,
      ),
    ).resolves.toMatchObject({ ok: true, value: undefined });
    expect(transaction).toHaveBeenCalledWith(manager, expect.any(Function));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-a',
        tenantId: 'tenant-a',
        correlationId: 'correlation-a',
        actorRef: { subject: 'user-actor-a', kind: 'user' },
        requiredPermission: 'create',
      }),
    );
  });

  it('propagates durable enqueue failures so the surrounding business transaction rolls back', async () => {
    const error = new Error('synthetic outbox failure');
    const transaction = vi.fn(async () => {
      throw error;
    });
    const kernel = makeKernel(transaction as unknown as OutboxStore['transaction']);

    await expect(
      publish(kernel, 'token', 'correlation-a', () => undefined, 'create', manager),
    ).rejects.toBe(error);
  });
});
