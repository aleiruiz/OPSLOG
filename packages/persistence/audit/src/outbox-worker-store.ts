import { Brackets, type DataSource } from 'typeorm';
import { AUDIT_TENANT_DATABASE } from './data-source.js';
import { TenantOutboxEntity } from './entities.js';
import type {
  DurableOutboxAdapter,
  EventClaim,
  OutboxRecord,
  OutboxStatus,
  TenantOutboxDataSourceResolver,
} from './outbox-store.js';

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function requireTenantSource(source: DataSource): void {
  if (
    typeof source.options.database !== 'string' ||
    !AUDIT_TENANT_DATABASE.test(source.options.database)
  )
    throw new Error('Outbox DataSource requires one tenant-exclusive database');
}

function recordFrom(row: TenantOutboxEntity): OutboxRecord {
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
    status: row.status,
    attempts: row.attempts,
    availableAt: row.availableAt.getTime(),
    ...(row.leaseUntil === null ? {} : { leaseUntil: row.leaseUntil.getTime() }),
    fencing: Number(row.fencing),
    ...(row.workerId === null ? {} : { workerId: row.workerId }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.handlerCompleted ? { handlerCompleted: true } : {}),
  };
}

function backoffMs(attempt: number, random: () => number): number {
  const delays = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
  const index = Math.min(Math.max(1, attempt), delays.length) - 1;
  return Math.round(delays[index]! * (0.8 + 0.4 * random()));
}

/** Owns fenced worker transitions and read paths for the relay-scoped database account. */
export class MySqlTenantOutboxWorkerStore
  implements
    Pick<
      DurableOutboxAdapter,
      'claim' | 'markHandlerCompleted' | 'acknowledge' | 'retry' | 'reconcile' | 'get' | 'all'
    >
{
  private claimOffset = 0;

  constructor(
    private readonly listTenantIds: () => readonly string[] | Promise<readonly string[]>,
    private readonly resolveRuntime: TenantOutboxDataSourceResolver,
    private readonly resolveWorker: TenantOutboxDataSourceResolver,
    private readonly random: () => number,
  ) {}

  private async tenantIds(): Promise<string[]> {
    const tenantIds = await this.listTenantIds();
    if (tenantIds.some((tenantId) => !TENANT_ID.test(tenantId)))
      throw new Error('trusted tenant directory returned an invalid tenant id');
    return [...new Set(tenantIds)];
  }

  async claim<T>(
    now: number,
    leaseMs: number,
    workerId: string,
  ): Promise<EventClaim<T> | undefined> {
    if (leaseMs <= 0 || !workerId.trim()) throw new Error('valid lease and worker are required');
    const tenants = await this.tenantIds();
    if (tenants.length === 0) return undefined;
    const start = this.claimOffset++ % tenants.length;
    for (let step = 0; step < tenants.length; step += 1) {
      const tenantId = tenants[(start + step) % tenants.length]!;
      const source = await this.resolveWorker(tenantId);
      requireTenantSource(source);
      const claim = await source.transaction('READ COMMITTED', async (manager) => {
        const repository = manager.getRepository(TenantOutboxEntity);
        const row = await repository
          .createQueryBuilder('outbox')
          .where(
            new Brackets((query) =>
              query
                .where('outbox.status IN (:...statuses)', { statuses: ['pending', 'retry'] })
                .orWhere('(outbox.status = :processing AND outbox.leaseUntil <= :now)', {
                  processing: 'processing',
                  now: new Date(now),
                }),
            ),
          )
          .andWhere('outbox.tenantId = :tenantId', { tenantId })
          .andWhere('outbox.availableAt <= :now', { now: new Date(now) })
          .orderBy('outbox.occurredAt', 'ASC')
          .addOrderBy('outbox.eventId', 'ASC')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .getOne();
        if (!row) return undefined;
        const priorFence = Number(row.fencing);
        if (!Number.isSafeInteger(priorFence) || priorFence >= Number.MAX_SAFE_INTEGER)
          throw new Error('outbox fencing counter exhausted');
        const nextFence = priorFence + 1;
        const attempts = row.attempts + 1;
        const leaseUntil = new Date(now + leaseMs);
        const updated = await repository
          .createQueryBuilder()
          .update(TenantOutboxEntity)
          .set({ status: 'processing', attempts, fencing: String(nextFence), workerId, leaseUntil })
          .where('tenant_id = :tenantId AND event_id = :eventId AND fencing = :fencing', {
            tenantId,
            eventId: row.eventId,
            fencing: String(priorFence),
          })
          .execute();
        if (updated.affected !== 1) return undefined;
        row.status = 'processing';
        row.attempts = attempts;
        row.fencing = String(nextFence);
        row.workerId = workerId;
        row.leaseUntil = leaseUntil;
        return {
          record: recordFrom(row) as OutboxRecord<T>,
          fencing: nextFence,
          leaseUntil: now + leaseMs,
        };
      });
      if (claim) return claim;
    }
    return undefined;
  }

  async markHandlerCompleted(tenantId: string, eventId: string, fencing: number): Promise<void> {
    const result = await this.workerRepo(tenantId).then((repo) =>
      repo
        .createQueryBuilder()
        .update(TenantOutboxEntity)
        .set({ handlerCompleted: true })
        .where(
          'tenant_id = :tenantId AND event_id = :eventId AND fencing = :fencing AND status = :status',
          { tenantId, eventId, fencing: String(fencing), status: 'processing' },
        )
        .execute(),
    );
    if (result.affected === 1) return;
    const row = await (await this.workerRepo(tenantId)).findOne({ where: { tenantId, eventId } });
    if (!row) throw new Error('outbox event not found');
    if (Number(row.fencing) !== fencing || row.status !== 'processing' || !row.handlerCompleted)
      throw new Error('stale fencing');
  }

  async acknowledge(tenantId: string, eventId: string, fencing: number): Promise<void> {
    const repository = await this.workerRepo(tenantId);
    const result = await repository
      .createQueryBuilder()
      .update(TenantOutboxEntity)
      .set({ status: 'delivered', leaseUntil: null, workerId: null })
      .where(
        'tenant_id = :tenantId AND event_id = :eventId AND fencing = :fencing AND status = :status AND handler_completed = 1',
        { tenantId, eventId, fencing: String(fencing), status: 'processing' },
      )
      .execute();
    if (result.affected === 1) return;
    const row = await repository.findOne({ where: { tenantId, eventId } });
    if (!row) throw new Error('outbox event not found');
    if (Number(row.fencing) !== fencing || row.status !== 'delivered')
      throw new Error('stale fencing');
  }

  async retry(
    tenantId: string,
    eventId: string,
    fencing: number,
    error: string,
    now: number,
    maxAttempts: number,
  ): Promise<OutboxStatus> {
    const repository = await this.workerRepo(tenantId);
    const row = await repository.findOne({ where: { tenantId, eventId } });
    if (!row) throw new Error('outbox event not found');
    if (Number(row.fencing) !== fencing || row.status !== 'processing')
      throw new Error('stale fencing');
    const status: OutboxStatus = row.attempts >= maxAttempts ? 'dead_letter' : 'retry';
    const result = await repository
      .createQueryBuilder()
      .update(TenantOutboxEntity)
      .set({
        status,
        availableAt:
          status === 'retry'
            ? new Date(now + backoffMs(row.attempts, this.random))
            : row.availableAt,
        leaseUntil: null,
        workerId: null,
        lastError: error.slice(0, 500),
      })
      .where(
        'tenant_id = :tenantId AND event_id = :eventId AND fencing = :fencing AND status = :processing',
        { tenantId, eventId, fencing: String(fencing), processing: 'processing' },
      )
      .execute();
    if (result.affected !== 1) throw new Error('stale fencing');
    return status;
  }

  async reconcile(now: number): Promise<number> {
    let affected = 0;
    for (const tenantId of await this.tenantIds()) {
      const repository = await this.workerRepo(tenantId);
      const result = await repository
        .createQueryBuilder()
        .update(TenantOutboxEntity)
        .set({
          status: 'retry',
          availableAt: new Date(now),
          leaseUntil: null,
          workerId: null,
          lastError: 'lease expired',
        })
        .where('tenant_id = :tenantId AND status = :status AND lease_until <= :now', {
          tenantId,
          status: 'processing',
          now: new Date(now),
        })
        .execute();
      affected += result.affected ?? 0;
    }
    return affected;
  }

  async get(tenantId: string, eventId: string): Promise<OutboxRecord | undefined> {
    const row = await (await this.runtimeRepo(tenantId)).findOne({ where: { tenantId, eventId } });
    return row ? recordFrom(row) : undefined;
  }

  async all(): Promise<readonly OutboxRecord[]> {
    const records: OutboxRecord[] = [];
    for (const tenantId of await this.tenantIds()) {
      const rows = await (await this.runtimeRepo(tenantId)).find({ where: { tenantId } });
      records.push(...rows.map(recordFrom));
    }
    return records;
  }

  private async workerRepo(tenantId: string) {
    const source = await this.resolveWorker(tenantId);
    requireTenantSource(source);
    return source.getRepository(TenantOutboxEntity);
  }

  private async runtimeRepo(tenantId: string) {
    const source = await this.resolveRuntime(tenantId);
    requireTenantSource(source);
    return source.getRepository(TenantOutboxEntity);
  }
}
