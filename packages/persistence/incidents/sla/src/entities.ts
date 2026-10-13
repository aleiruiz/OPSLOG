import { EntitySchema } from 'typeorm';

export const INCIDENT_SLA_TABLES = {
  cycles: 'opslog_incident_sla_cycles',
  alerts: 'opslog_incident_sla_alerts',
  deliveries: 'opslog_incident_alert_deliveries',
} as const;

const bin = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: bin,
  nullable,
});
const tenant = { ...text('company_id', 64), primary: true };

export class IncidentSlaCycleEntity {
  tenantId!: string;
  incidentId!: string;
  cycle!: number;
  startedAt!: Date;
  severity!: string;
  targetDays!: number;
  targetVersion!: number;
}
export class IncidentSlaAlertEntity {
  tenantId!: string;
  id!: string;
  incidentId!: string;
  folio!: string;
  cycle!: number;
  kind!: string;
  dedupeRef!: string;
  severity!: string | null;
  deadlineAt!: Date | null;
  subjectId!: string | null;
  createdAt!: Date;
}
export class IncidentSlaDeliveryEntity {
  tenantId!: string;
  alertId!: string;
  recipientId!: string;
  channel!: string;
  status!: string;
  attempts!: number;
  nextAttemptAt!: Date | null;
  leaseUntil!: Date | null;
}

/** The target of each cycle: written by the scan, moved by a severity change (compare-and-set). */
export const IncidentSlaCycleSchema = new EntitySchema<IncidentSlaCycleEntity>({
  name: 'IncidentSlaCycleEntity',
  target: IncidentSlaCycleEntity,
  tableName: INCIDENT_SLA_TABLES.cycles,
  columns: {
    tenantId: tenant,
    incidentId: { ...text('incident_id', 64), primary: true },
    cycle: { name: 'cycle', type: 'int', unsigned: true, primary: true },
    startedAt: { name: 'started_at', type: 'datetime', precision: 6 },
    severity: text('severity', 16),
    targetDays: { name: 'target_days', type: 'smallint', unsigned: true },
    targetVersion: { name: 'target_version', type: 'int', unsigned: true },
  },
});

/** A notice: no recipient, no name, no amount. The runtime account inserts and reads, never updates. */
export const IncidentSlaAlertSchema = new EntitySchema<IncidentSlaAlertEntity>({
  name: 'IncidentSlaAlertEntity',
  target: IncidentSlaAlertEntity,
  tableName: INCIDENT_SLA_TABLES.alerts,
  columns: {
    tenantId: tenant,
    id: { ...text('id', 64), primary: true },
    incidentId: text('incident_id', 64),
    folio: text('folio', 24),
    cycle: { name: 'cycle', type: 'int', unsigned: true },
    kind: text('kind', 24),
    dedupeRef: text('dedupe_ref', 40),
    severity: text('severity', 16, true),
    deadlineAt: { name: 'deadline_at', type: 'datetime', precision: 6, nullable: true },
    subjectId: text('subject_id', 72, true),
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
  },
});

/** One row per notice, recipient and channel. It keeps no address and no content. */
export const IncidentSlaDeliverySchema = new EntitySchema<IncidentSlaDeliveryEntity>({
  name: 'IncidentSlaDeliveryEntity',
  target: IncidentSlaDeliveryEntity,
  tableName: INCIDENT_SLA_TABLES.deliveries,
  columns: {
    tenantId: tenant,
    alertId: { ...text('alert_id', 64), primary: true },
    recipientId: { ...text('recipient_id', 72), primary: true },
    channel: { ...text('channel', 16), primary: true },
    status: text('status', 16),
    attempts: { name: 'attempts', type: 'smallint', unsigned: true },
    nextAttemptAt: { name: 'next_attempt_at', type: 'datetime', precision: 6, nullable: true },
    leaseUntil: { name: 'lease_until', type: 'datetime', precision: 6, nullable: true },
  },
});

export const INCIDENT_SLA_ENTITIES = [
  IncidentSlaCycleSchema,
  IncidentSlaAlertSchema,
  IncidentSlaDeliverySchema,
];
