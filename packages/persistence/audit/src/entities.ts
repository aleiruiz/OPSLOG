import { EntitySchema } from 'typeorm';
import type { AuditActorKind, AuditData } from '@opslog/platform-audit';

export const AUDIT_TABLES = {
  local: 'opslog_audit_local',
  delivery: 'opslog_audit_delivery',
  projection: 'opslog_audit_log',
  registry: 'opslog_audit_registry',
  outbox: 'opslog_tenant_outbox',
} as const;

export class TenantOutboxEntity {
  eventId!: string;
  tenantId!: string;
  type!: string;
  payload!: object;
  occurredAt!: Date;
  idempotencyKey!: string;
  correlationId!: string | null;
  actorSubject!: string | null;
  actorKind!: string | null;
  requiredPermission!: string | null;
  entityId!: string | null;
  schemaVersion!: number | null;
  status!: 'pending' | 'processing' | 'retry' | 'delivered' | 'dead_letter';
  attempts!: number;
  availableAt!: Date;
  leaseUntil!: Date | null;
  fencing!: string;
  workerId!: string | null;
  lastError!: string | null;
  handlerCompleted!: boolean;
}

export class AuditLocalEventEntity {
  eventId!: string;
  tenantId!: string;
  action!: string;
  entityType!: string;
  entityId!: string;
  occurredAt!: Date;
  actorId!: string;
  actorKind!: AuditActorKind;
  correlationId!: string;
  data!: AuditData;
  contentHash!: string;
}

export class AuditDeliveryEntity {
  tenantId!: string;
  eventId!: string;
  status!: 'pending' | 'delivered';
  createdAt!: Date;
  deliveredAt!: Date | null;
}

export class AuditProjectionEntity {
  eventId!: string;
  tenantId!: string;
  action!: string;
  entityType!: string;
  entityId!: string;
  occurredAt!: Date;
  actorId!: string;
  actorKind!: AuditActorKind;
  correlationId!: string;
  data!: AuditData;
  contentHash!: string;
}

export class AuditRegistryEntity {
  tenantId!: string;
  eventId!: string;
  contentHash!: string;
  occurredAt!: Date;
}

const text = (length: number) => ({
  type: 'varchar' as const,
  length: String(length),
  collation: 'utf8mb4_bin',
});
const eventColumns = {
  tenantId: { name: 'tenant_id', ...text(128), primary: true },
  eventId: { name: 'event_id', ...text(128), primary: true },
  action: { ...text(64) },
  entityType: { name: 'entity_type', ...text(64) },
  entityId: { name: 'entity_id', ...text(128) },
  occurredAt: { name: 'occurred_at', type: 'datetime' as const, precision: 3, primary: true },
  actorId: { name: 'actor_id', ...text(128) },
  actorKind: { name: 'actor_kind', ...text(16) },
  correlationId: { name: 'correlation_id', ...text(128) },
  data: { type: 'json' as const },
  contentHash: {
    name: 'content_hash',
    type: 'char' as const,
    length: '64',
    collation: 'ascii_bin',
  },
};

export const TenantOutboxSchema = new EntitySchema<TenantOutboxEntity>({
  name: 'TenantOutboxEntity',
  target: TenantOutboxEntity,
  tableName: AUDIT_TABLES.outbox,
  columns: {
    tenantId: { name: 'tenant_id', ...text(128), primary: true },
    eventId: { name: 'event_id', ...text(128), primary: true },
    type: { type: 'varchar', length: '128', collation: 'utf8mb4_bin' },
    payload: { type: 'json' },
    occurredAt: { name: 'occurred_at', type: 'datetime', precision: 3 },
    idempotencyKey: {
      name: 'idempotency_key',
      type: 'varchar',
      length: '128',
      collation: 'utf8mb4_bin',
    },
    correlationId: { name: 'correlation_id', type: 'varchar', length: '128', nullable: true },
    actorSubject: { name: 'actor_subject', type: 'varchar', length: '128', nullable: true },
    actorKind: { name: 'actor_kind', type: 'varchar', length: '16', nullable: true },
    requiredPermission: {
      name: 'required_permission',
      type: 'varchar',
      length: '64',
      nullable: true,
    },
    entityId: { name: 'entity_id', type: 'varchar', length: '128', nullable: true },
    schemaVersion: { name: 'schema_version', type: 'int', nullable: true },
    status: {
      type: 'enum',
      enum: ['pending', 'processing', 'retry', 'delivered', 'dead_letter'],
      default: 'pending',
    },
    attempts: { type: 'int', unsigned: true, default: 0 },
    availableAt: { name: 'available_at', type: 'datetime', precision: 3 },
    leaseUntil: { name: 'lease_until', type: 'datetime', precision: 3, nullable: true },
    fencing: { type: 'bigint', unsigned: true, default: 0 },
    workerId: { name: 'worker_id', type: 'varchar', length: '128', nullable: true },
    lastError: { name: 'last_error', type: 'varchar', length: '500', nullable: true },
    handlerCompleted: { name: 'handler_completed', type: 'boolean', default: false },
  },
  indices: [{ name: 'ix_tenant_outbox_due', columns: ['status', 'availableAt', 'occurredAt'] }],
});

export const AuditLocalEventSchema = new EntitySchema<AuditLocalEventEntity>({
  name: 'AuditLocalEventEntity',
  target: AuditLocalEventEntity,
  tableName: AUDIT_TABLES.local,
  columns: { ...eventColumns, occurredAt: { ...eventColumns.occurredAt, primary: false } },
  indices: [{ name: 'ix_audit_local_tenant_date', columns: ['tenantId', 'occurredAt'] }],
});

export const AuditDeliverySchema = new EntitySchema<AuditDeliveryEntity>({
  name: 'AuditDeliveryEntity',
  target: AuditDeliveryEntity,
  tableName: AUDIT_TABLES.delivery,
  columns: {
    tenantId: { name: 'tenant_id', ...text(128), primary: true },
    eventId: { name: 'event_id', ...text(128), primary: true },
    status: { type: 'enum', enum: ['pending', 'delivered'], default: 'pending' },
    createdAt: { name: 'created_at', type: 'datetime', precision: 3 },
    deliveredAt: { name: 'delivered_at', type: 'datetime', precision: 3, nullable: true },
  },
  indices: [{ name: 'ix_audit_delivery_pending', columns: ['status', 'createdAt'] }],
});

export const AuditProjectionSchema = new EntitySchema<AuditProjectionEntity>({
  name: 'AuditProjectionEntity',
  target: AuditProjectionEntity,
  tableName: AUDIT_TABLES.projection,
  columns: eventColumns,
  indices: [{ name: 'ix_audit_projection_tenant_date', columns: ['tenantId', 'occurredAt'] }],
});

export const AuditRegistrySchema = new EntitySchema<AuditRegistryEntity>({
  name: 'AuditRegistryEntity',
  target: AuditRegistryEntity,
  tableName: AUDIT_TABLES.registry,
  columns: {
    tenantId: { name: 'tenant_id', ...text(128), primary: true },
    eventId: { name: 'event_id', ...text(128), primary: true },
    contentHash: { name: 'content_hash', type: 'char', length: '64', collation: 'ascii_bin' },
    occurredAt: { name: 'occurred_at', type: 'datetime', precision: 3 },
  },
  indices: [{ name: 'ix_audit_registry_date', columns: ['tenantId', 'occurredAt'] }],
});

export const AUDIT_ENTITIES = [
  AuditLocalEventSchema,
  AuditDeliverySchema,
  AuditProjectionSchema,
  AuditRegistrySchema,
  TenantOutboxSchema,
] as const;
