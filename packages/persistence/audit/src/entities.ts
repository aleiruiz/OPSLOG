import { EntitySchema } from 'typeorm';
import type { AuditActorKind, AuditData } from '@opslog/platform-audit';

export const AUDIT_TABLES = {
  local: 'opslog_audit_local',
  delivery: 'opslog_audit_delivery',
  projection: 'opslog_audit_log',
  registry: 'opslog_audit_registry',
} as const;

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
] as const;
