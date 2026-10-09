import { isDeepStrictEqual } from 'node:util';
import { type DataSource, type EntityManager } from 'typeorm';
import { AUDIT_TENANT_DATABASE } from './data-source.js';
import { TenantOutboxEntity } from './entities.js';
import { MySqlTenantOutboxWorkerStore } from './outbox-worker-store.js';

export type TenantOutboxDataSourceResolver = (tenantId: string) => DataSource | Promise<DataSource>;
export type OutboxStatus = 'pending' | 'processing' | 'retry' | 'delivered' | 'dead_letter';
export interface OutboxRecord<T = unknown> {
  readonly eventId: string;
  readonly tenantId: string;
  readonly type: string;
  readonly payload: T;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly actorRef?: { readonly subject: string; readonly kind: 'user' | 'api_key' | 'system' };
  readonly requiredPermission?: string;
  readonly entityId?: string;
  readonly schemaVersion?: number;
  status: OutboxStatus;
  attempts: number;
  availableAt: number;
  leaseUntil?: number;
  fencing?: number;
  workerId?: string;
  lastError?: string;
  handlerCompleted?: boolean;
}
export interface EventClaim<T = unknown> {
  readonly record: OutboxRecord<T>;
  readonly fencing: number;
  readonly leaseUntil: number;
}
export interface OutboxTransaction {
  enqueue<T>(record: Omit<OutboxRecord<T>, 'status' | 'attempts' | 'availableAt'>): OutboxRecord<T>;
}
export interface DurableOutboxAdapter {
  transaction<T>(work: (tx: OutboxTransaction) => T): T | Promise<T>;
  claim<T>(
    now: number,
    leaseMs: number,
    workerId: string,
  ): EventClaim<T> | undefined | Promise<EventClaim<T> | undefined>;
  markHandlerCompleted(tenantId: string, eventId: string, fencing: number): void | Promise<void>;
  acknowledge(tenantId: string, eventId: string, fencing: number): void | Promise<void>;
  retry(
    tenantId: string,
    eventId: string,
    fencing: number,
    error: string,
    now: number,
    maxAttempts: number,
  ): OutboxStatus | Promise<OutboxStatus>;
  reconcile(now: number): number | Promise<number>;
  get(
    tenantId: string,
    eventId: string,
  ): OutboxRecord | undefined | Promise<OutboxRecord | undefined>;
  all(): readonly OutboxRecord[] | Promise<readonly OutboxRecord[]>;
}

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const scoped = (tenantId: string, eventId: string) =>
  `${tenantId.length}:${tenantId}${eventId.length}:${eventId}`;

class OutboxConflictError extends Error {
  readonly code = 'OUTBOX_EVENT_CONFLICT';
  constructor() {
    super('Event id was already used with a different event');
  }
}

function copy<T>(record: OutboxRecord<T>): OutboxRecord<T> {
  return structuredClone(record);
}

function requireSource(source: DataSource): void {
  if (
    typeof source.options.database !== 'string' ||
    !AUDIT_TENANT_DATABASE.test(source.options.database)
  )
    throw new Error('Outbox DataSource requires one tenant-exclusive database');
}

function isDuplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ER_DUP_ENTRY' || error.code === 'SQLITE_CONSTRAINT')
  );
}

/**
 * MySQL outbox for one exclusive tenant database per resolved tenant. Runtime owns enqueue;
 * the worker resolver owns lease/checkpoint/delivery updates. Fences and handler completion are
 * committed with every state transition, so process restarts do not reset either value.
 */
export class MySqlTenantOutboxStore implements DurableOutboxAdapter {
  private readonly worker: MySqlTenantOutboxWorkerStore;

  constructor(
    private readonly listTenantIds: () => readonly string[] | Promise<readonly string[]>,
    private readonly resolveRuntime: TenantOutboxDataSourceResolver,
    resolveWorker: TenantOutboxDataSourceResolver,
    private readonly clock: () => number = Date.now,
    random: () => number = Math.random,
  ) {
    this.worker = new MySqlTenantOutboxWorkerStore(
      listTenantIds,
      resolveRuntime,
      resolveWorker,
      random,
    );
  }

  async transaction<T>(work: (tx: OutboxTransaction) => T): Promise<T> {
    const staged = new Map<string, OutboxRecord>();
    let closed = false;
    const tx: OutboxTransaction = {
      enqueue: (input) => {
        if (closed) throw new Error('transaction is closed');
        if (!EVENT_ID.test(input.eventId) || !TENANT_ID.test(input.tenantId))
          throw new Error('event and tenant ids must be opaque identifiers');
        const key = scoped(input.tenantId, input.eventId);
        const previous = staged.get(key);
        if (previous) {
          if (previous.type !== input.type || !isDeepStrictEqual(previous.payload, input.payload))
            throw new OutboxConflictError();
          return copy(previous) as OutboxRecord<typeof input.payload>;
        }
        const record: OutboxRecord = {
          eventId: input.eventId,
          tenantId: input.tenantId,
          type: input.type,
          payload: structuredClone(input.payload) as object,
          occurredAt: input.occurredAt,
          idempotencyKey: input.idempotencyKey,
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          ...(input.actorRef === undefined ? {} : { actorRef: structuredClone(input.actorRef) }),
          ...(input.requiredPermission === undefined
            ? {}
            : { requiredPermission: input.requiredPermission }),
          ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
          ...(input.schemaVersion === undefined ? {} : { schemaVersion: input.schemaVersion }),
          status: 'pending',
          attempts: 0,
          availableAt: this.clock(),
        };
        staged.set(key, record);
        return copy(record) as OutboxRecord<typeof input.payload>;
      },
    };
    let result: T;
    try {
      result = work(tx);
      if (
        (typeof result === 'object' || typeof result === 'function') &&
        result !== null &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('outbox transactions must be synchronous');
      }
      closed = true;
    } catch (error) {
      closed = true;
      staged.clear();
      throw error;
    }
    const tenants = new Set([...staged.values()].map((record) => record.tenantId));
    if (tenants.size > 1) throw new Error('outbox transaction cannot span tenant databases');
    const tenantId = [...tenants][0];
    if (tenantId) {
      const source = await this.resolveRuntime(tenantId);
      requireSource(source);
      await source.transaction('READ COMMITTED', async (manager) => {
        for (const record of staged.values()) await this.insertIdempotently(manager, record);
      });
    }
    return result;
  }

  private async insertIdempotently(manager: EntityManager, record: OutboxRecord): Promise<void> {
    const repository = manager.getRepository(TenantOutboxEntity);
    const row = this.row(record);
    const existing = await repository.findOne({
      where: { tenantId: record.tenantId, eventId: record.eventId },
    });
    if (existing) {
      if (existing.type !== record.type || !isDeepStrictEqual(existing.payload, record.payload))
        throw new OutboxConflictError();
      return;
    }
    try {
      await repository.insert(row);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const raced = await repository.findOne({
        where: { tenantId: record.tenantId, eventId: record.eventId },
      });
      if (!raced || raced.type !== record.type || !isDeepStrictEqual(raced.payload, record.payload))
        throw new OutboxConflictError();
    }
  }

  private row(record: OutboxRecord): Partial<TenantOutboxEntity> {
    return {
      tenantId: record.tenantId,
      eventId: record.eventId,
      type: record.type,
      payload: record.payload as object,
      occurredAt: new Date(record.occurredAt),
      idempotencyKey: record.idempotencyKey,
      correlationId: record.correlationId ?? null,
      actorSubject: record.actorRef?.subject ?? null,
      actorKind: record.actorRef?.kind ?? null,
      requiredPermission: record.requiredPermission ?? null,
      entityId: record.entityId ?? null,
      schemaVersion: record.schemaVersion ?? null,
      status: 'pending',
      attempts: 0,
      availableAt: new Date(record.availableAt),
      leaseUntil: null,
      fencing: '0',
      workerId: null,
      lastError: null,
      handlerCompleted: false,
    };
  }

  claim<T>(now: number, leaseMs: number, workerId: string) {
    return this.worker.claim<T>(now, leaseMs, workerId);
  }

  markHandlerCompleted(tenantId: string, eventId: string, fencing: number) {
    return this.worker.markHandlerCompleted(tenantId, eventId, fencing);
  }

  acknowledge(tenantId: string, eventId: string, fencing: number) {
    return this.worker.acknowledge(tenantId, eventId, fencing);
  }

  retry(
    tenantId: string,
    eventId: string,
    fencing: number,
    error: string,
    now: number,
    maxAttempts: number,
  ) {
    return this.worker.retry(tenantId, eventId, fencing, error, now, maxAttempts);
  }

  reconcile(now: number) {
    return this.worker.reconcile(now);
  }

  get(tenantId: string, eventId: string) {
    return this.worker.get(tenantId, eventId);
  }

  all() {
    return this.worker.all();
  }
}
