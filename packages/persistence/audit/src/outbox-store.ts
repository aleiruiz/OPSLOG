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
type ImmutableOutboxEnvelope = Pick<
  OutboxRecord,
  | 'eventId'
  | 'tenantId'
  | 'type'
  | 'payload'
  | 'occurredAt'
  | 'idempotencyKey'
  | 'correlationId'
  | 'actorRef'
  | 'requiredPermission'
  | 'entityId'
  | 'schemaVersion'
>;
export interface DurableOutboxAdapter {
  transaction<T>(work: (tx: OutboxTransaction) => T): T | Promise<T>;
  transaction<T>(manager: unknown, work: (tx: OutboxTransaction) => T | Promise<T>): Promise<T>;
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

function sameImmutableEnvelope(
  left: ImmutableOutboxEnvelope,
  right: ImmutableOutboxEnvelope,
): boolean {
  const normalized = (record: ImmutableOutboxEnvelope) => ({
    eventId: record.eventId,
    tenantId: record.tenantId,
    type: record.type,
    payload: structuredClone(record.payload),
    occurredAt: new Date(record.occurredAt).toISOString(),
    idempotencyKey: record.idempotencyKey,
    correlationId: record.correlationId ?? null,
    actorRef: record.actorRef ?? null,
    requiredPermission: record.requiredPermission ?? null,
    entityId: record.entityId ?? null,
    schemaVersion: record.schemaVersion ?? null,
  });
  return isDeepStrictEqual(normalized(left), normalized(right));
}

function storedEnvelope(row: TenantOutboxEntity): ImmutableOutboxEnvelope {
  return {
    eventId: row.eventId,
    tenantId: row.tenantId,
    type: row.type,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    ...(row.correlationId === null ? {} : { correlationId: row.correlationId }),
    ...(row.actorSubject === null || row.actorKind === null
      ? {}
      : {
          actorRef: {
            subject: row.actorSubject,
            kind: row.actorKind as NonNullable<OutboxRecord['actorRef']>['kind'],
          },
        }),
    ...(row.requiredPermission === null ? {} : { requiredPermission: row.requiredPermission }),
    ...(row.entityId === null ? {} : { entityId: row.entityId }),
    ...(row.schemaVersion === null ? {} : { schemaVersion: row.schemaVersion }),
  };
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

  transaction<T>(work: (tx: OutboxTransaction) => T): Promise<T>;
  transaction<T>(
    manager: unknown,
    managerWork: (tx: OutboxTransaction) => T | Promise<T>,
  ): Promise<T>;
  async transaction<T>(
    managerOrWork: unknown | ((tx: OutboxTransaction) => T),
    managerWork?: (tx: OutboxTransaction) => T | Promise<T>,
  ): Promise<T> {
    if (typeof managerOrWork === 'function')
      throw new Error('durable outbox transaction requires the business EntityManager');
    if (!managerWork) throw new Error('transaction callback is required');
    const manager = managerOrWork as EntityManager;
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error('outbox transaction requires an active EntityManager');
    const staged = this.createStagedTransaction();
    try {
      const result = await managerWork(staged.tx);
      staged.close();
      const tenants = new Set([...staged.records.values()].map((record) => record.tenantId));
      if (tenants.size > 1) throw new Error('outbox transaction cannot span tenant databases');
      for (const tenantId of tenants) {
        const source = await this.resolveRuntime(tenantId);
        requireSource(source);
        if (manager.connection.options.database !== source.options.database)
          throw new Error('outbox EntityManager must use the tenant database');
      }
      for (const record of staged.records.values()) await this.insertIdempotently(manager, record);
      return result;
    } catch (error) {
      staged.close();
      throw error;
    }
  }

  private createStagedTransaction(): {
    readonly records: Map<string, OutboxRecord>;
    readonly tx: OutboxTransaction;
    close(): void;
  } {
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
          if (!sameImmutableEnvelope(previous, input)) throw new OutboxConflictError();
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
    return { records: staged, tx, close: () => (closed = true) };
  }

  private async insertIdempotently(manager: EntityManager, record: OutboxRecord): Promise<void> {
    const repository = manager.getRepository(TenantOutboxEntity);
    const row = this.row(record);
    const existing = await repository.findOne({
      where: { tenantId: record.tenantId, eventId: record.eventId },
    });
    if (existing) {
      if (!sameImmutableEnvelope(storedEnvelope(existing), record)) throw new OutboxConflictError();
      return;
    }
    try {
      await manager.query('CALL opslog_enqueue_tenant_outbox(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        record.tenantId,
        record.eventId,
        record.type,
        JSON.stringify(record.payload),
        row.occurredAt,
        record.idempotencyKey,
        row.correlationId,
        row.actorSubject,
        row.actorKind,
        row.requiredPermission,
        row.entityId,
        row.schemaVersion,
      ]);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      // A duplicate-key insert is a current read, but a normal follow-up SELECT can
      // remain on the transaction's older REPEATABLE READ snapshot. Locking reads
      // use the current committed version so identical concurrent retries reconcile.
      const raced = await repository.findOne({
        where: { tenantId: record.tenantId, eventId: record.eventId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!raced || !sameImmutableEnvelope(storedEnvelope(raced), record))
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
      availableAt: new Date(record.availableAt),
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
