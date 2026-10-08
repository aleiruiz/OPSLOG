import { createHash } from 'node:crypto';
import {
  AuditConflictError,
  defaultAuditListRange,
  sanitizeAuditEvent,
  validateAuditListRange,
  type AuditEvent,
  type AuditListRange,
  type AuditStore,
  type PersistedAuditEvent,
} from '@opslog/platform-audit';
import {
  AuditDeliveryEntity,
  AuditLocalEventEntity,
  AuditProjectionEntity,
  AuditRegistryEntity,
} from './entities.js';
import { AUDIT_TENANT_DATABASE } from './data-source.js';
import type { DataSource, EntityManager } from 'typeorm';

export class AuditPersistenceError extends Error {
  constructor() {
    super('Audit persistence operation failed');
    this.name = 'AuditPersistenceError';
  }
}

/** A command retry with an already-used local identity is resolved by its domain idempotency port. */
export class AuditLocalDuplicateError extends Error {
  readonly code = 'AUDIT_LOCAL_EVENT_DUPLICATE';
  constructor() {
    super('Local audit event was already written');
    this.name = 'AuditLocalDuplicateError';
  }
}

function requireTenantDatabase(manager: EntityManager): void {
  const database = manager.connection.options.database;
  if (typeof database !== 'string' || !AUDIT_TENANT_DATABASE.test(database))
    throw new AuditPersistenceError();
}

function requireTenantSource(source: DataSource): void {
  const database = source.options.database;
  if (typeof database !== 'string' || !AUDIT_TENANT_DATABASE.test(database))
    throw new AuditPersistenceError();
}

function hashEvent(event: PersistedAuditEvent): string {
  const canonical = JSON.stringify({
    eventId: event.eventId,
    tenantId: event.tenantId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    occurredAt: asDate(event.occurredAt).toISOString(),
    actor: { id: event.actor.id, kind: event.actor.kind },
    correlationId: event.correlationId,
    data: { attempts: event.data.attempts },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function asDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || value === '[REDACTED]')
    throw new Error('invalid audit occurredAt');
  return date;
}

function eventRow(event: PersistedAuditEvent, contentHash: string) {
  return {
    eventId: event.eventId,
    tenantId: event.tenantId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    occurredAt: asDate(event.occurredAt),
    actorId: event.actor.id,
    actorKind: event.actor.kind,
    correlationId: event.correlationId,
    data: event.data,
    contentHash,
  };
}

function persisted(row: {
  eventId: string;
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  actorId: string;
  actorKind: PersistedAuditEvent['actor']['kind'];
  correlationId: string;
  data: PersistedAuditEvent['data'];
}): PersistedAuditEvent {
  return {
    eventId: row.eventId,
    tenantId: row.tenantId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    occurredAt: row.occurredAt.toISOString(),
    actor: { id: row.actorId, kind: row.actorKind },
    correlationId: row.correlationId,
    data: row.data,
  };
}

function isDuplicate(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const driver = (error as { driverError?: { errno?: unknown; code?: unknown } }).driverError;
  return driver?.errno === 1062 || driver?.code === 'ER_DUP_ENTRY';
}

function sameHash(existing: { contentHash: string }, contentHash: string): void {
  if (existing.contentHash !== contentHash) throw new AuditConflictError();
}

/**
 * Inserts immutable tenant-local audit plus the initial relay state using the caller's manager.
 * The caller owns the transaction: this helper never creates, commits, or rolls one back.
 */
export async function appendLocalAuditAndDelivery(
  manager: EntityManager,
  rawEvent: AuditEvent,
): Promise<PersistedAuditEvent> {
  requireTenantDatabase(manager);
  const event = sanitizeAuditEvent(structuredClone(rawEvent));
  const contentHash = hashEvent(event);
  const local = manager.getRepository(AuditLocalEventEntity);
  const delivery = manager.getRepository(AuditDeliveryEntity);
  try {
    await local.insert(eventRow(event, contentHash));
  } catch (error) {
    if (isDuplicate(error)) throw new AuditLocalDuplicateError();
    throw new AuditPersistenceError();
  }
  try {
    if (typeof manager.query === 'function') {
      await manager.query(
        'INSERT INTO `opslog_audit_delivery` (`tenant_id`, `event_id`, `status`, `created_at`, `delivered_at`) VALUES (?, ?, ?, ?, ?)',
        [event.tenantId, event.eventId, 'pending', new Date(), null],
      );
    } else {
      await delivery.insert({
        tenantId: event.tenantId,
        eventId: event.eventId,
        status: 'pending',
        createdAt: new Date(),
        deliveredAt: null,
      });
    }
  } catch {
    // The caller's transaction must roll back the local audit row with the command/history.
    throw new AuditPersistenceError();
  }
  return event;
}

/** Inserts the registry and date-partitioned projection in the caller's tenant-local transaction. */
export async function appendAuditProjection(
  manager: EntityManager,
  rawEvent: AuditEvent,
): Promise<void> {
  requireTenantDatabase(manager);
  const event = sanitizeAuditEvent(structuredClone(rawEvent));
  const contentHash = hashEvent(event);
  const registry = manager.getRepository(AuditRegistryEntity);
  const projection = manager.getRepository(AuditProjectionEntity);
  try {
    await registry.insert({
      tenantId: event.tenantId,
      eventId: event.eventId,
      contentHash,
      occurredAt: asDate(event.occurredAt),
    });
  } catch (error) {
    if (!isDuplicate(error)) throw new AuditPersistenceError();
    const existing = await registry.findOneBy({ tenantId: event.tenantId, eventId: event.eventId });
    if (!existing) throw new AuditPersistenceError();
    sameHash(existing, contentHash);
    return;
  }
  try {
    await projection.insert(eventRow(event, contentHash));
  } catch {
    // Registry and log must commit or roll back together to keep cross-partition idempotency sound.
    throw new AuditPersistenceError();
  }
}

export type TenantAuditDataSourceResolver = (tenantId: string) => DataSource | Promise<DataSource>;

/** Lists pending event identities for one physical tenant database; callers then relay each item. */
export async function listPendingAuditEventIds(
  source: DataSource,
  tenantId: string,
  limit = 100,
): Promise<readonly string[]> {
  requireTenantSource(source);
  if (
    typeof tenantId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tenantId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error('invalid audit relay query');
  try {
    const rows = await source.getRepository(AuditDeliveryEntity).find({
      where: { tenantId, status: 'pending' },
      order: { createdAt: 'ASC', eventId: 'ASC' },
      take: limit,
    });
    return rows.map((row) => row.eventId);
  } catch {
    throw new AuditPersistenceError();
  }
}

/** Relay/projection adapter. Its resolver must return the exclusive database for the requested tenant. */
export class MySqlAuditStore implements AuditStore {
  public constructor(
    private readonly resolveRelay: TenantAuditDataSourceResolver,
    private readonly resolveReader: TenantAuditDataSourceResolver = resolveRelay,
  ) {}

  public async append(event: AuditEvent): Promise<void> {
    try {
      const safeEvent = sanitizeAuditEvent(structuredClone(event));
      const source = await this.resolveRelay(safeEvent.tenantId);
      requireTenantSource(source);
      await source.transaction('READ COMMITTED', (manager) =>
        appendAuditProjection(manager, safeEvent),
      );
    } catch (error) {
      if (error instanceof AuditConflictError) throw error;
      throw new AuditPersistenceError();
    }
  }

  public async list(
    tenantId: string,
    range?: AuditListRange,
  ): Promise<readonly PersistedAuditEvent[]> {
    if (typeof tenantId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tenantId))
      throw new Error('invalid audit tenantId');
    const bounded = validateAuditListRange(range ?? defaultAuditListRange());
    try {
      const source = await this.resolveReader(tenantId);
      requireTenantSource(source);
      const rows = await source
        .getRepository(AuditProjectionEntity)
        .createQueryBuilder('audit')
        .where('audit.tenantId = :tenantId', { tenantId })
        .andWhere('audit.occurredAt >= :from', { from: new Date(bounded.from) })
        .andWhere('audit.occurredAt < :to', { to: new Date(bounded.to) })
        .orderBy('audit.occurredAt', 'DESC')
        .addOrderBy('audit.eventId', 'ASC')
        .take(bounded.limit)
        .getMany();
      return rows.map(persisted);
    } catch {
      throw new AuditPersistenceError();
    }
  }
}

/** Reads one local pending event, commits projection+registry, then advances only delivery state. */
export async function relayPendingAuditEvent(
  source: DataSource,
  tenantId: string,
  eventId: string,
): Promise<boolean> {
  if (
    typeof tenantId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tenantId) ||
    typeof eventId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(eventId)
  )
    throw new Error('invalid audit relay identity');
  requireTenantSource(source);
  let event: PersistedAuditEvent | undefined;
  try {
    await source.transaction('READ COMMITTED', async (manager) => {
      const status = await manager.getRepository(AuditDeliveryEntity).findOneBy({
        tenantId,
        eventId,
        status: 'pending',
      });
      if (!status) return;
      const local = await manager
        .getRepository(AuditLocalEventEntity)
        .findOneBy({ tenantId, eventId });
      if (!local) throw new AuditPersistenceError();
      event = persisted(local);
      await appendAuditProjection(manager, event);
    });
    if (!event) return false;
    // This update is intentionally separate from the projection commit and never touches local audit.
    const result = await source.transaction('READ COMMITTED', (manager) =>
      manager
        .getRepository(AuditDeliveryEntity)
        .update(
          { tenantId, eventId, status: 'pending' },
          { status: 'delivered', deliveredAt: new Date() },
        ),
    );
    return result.affected === 1;
  } catch (error) {
    if (error instanceof AuditConflictError) throw error;
    throw new AuditPersistenceError();
  }
}
