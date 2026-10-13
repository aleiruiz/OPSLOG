import { EntitySchema } from 'typeorm';

export const INCIDENT_TABLES = {
  incidents: 'opslog_incident_incidents',
  folios: 'opslog_incident_folio_sequences',
  transitions: 'opslog_incident_transitions',
  idempotency: 'opslog_incident_idempotency',
} as const;

const bin = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: bin,
  nullable,
});
const instant = (name: string, nullable = false) => ({
  name,
  type: 'datetime' as const,
  precision: 6,
  nullable,
});
const day = (name: string) => ({
  name,
  type: 'char' as const,
  length: 10,
  collation: bin,
  nullable: true,
});
const flag = (name: string) => ({ name, type: 'boolean' as const, nullable: true });
const tenant = { tenantId: { ...text('company_id', 64), primary: true } };
const counter = (name: string) => ({ name, type: 'int' as const, unsigned: true });

export class IncidentEntity {
  tenantId!: string;
  id!: string;
  folio!: string;
  status!: string;
  version!: number;
  cycle!: number;
  reopenCount!: number;
  type!: string;
  severity!: string | null;
  vehicleId!: string;
  areaId!: string;
  driverId!: string | null;
  noDriverReason!: string | null;
  occurredAt!: Date | null;
  occurredOn!: string | null;
  locationText!: string | null;
  locationLatitude!: string | null;
  locationLongitude!: string | null;
  description!: string | null;
  vehicleOperable!: boolean | null;
  damageDescription!: string | null;
  damageZones!: object;
  noPhotoJustification!: string | null;
  coverageStatus!: string;
  policySnapshot!: object | null;
  reportedAt!: Date | null;
  reportedBy!: string | null;
  responsibleId!: string | null;
  insurerName!: string | null;
  claimNumber!: string | null;
  adjusterName!: string | null;
  adjusterContact!: string | null;
  insurerReportedOn!: string | null;
  insurerResult!: string | null;
  rejectionReason!: string | null;
  appealNote!: string | null;
  noInsuranceReason!: string | null;
  costAssumed!: boolean | null;
  resolutionSummary!: string | null;
  totalLoss!: boolean | null;
  vehicleStatusDecision!: string | null;
  resolvedAt!: Date | null;
  assumptionApprovedBy!: string | null;
  assumptionApprovedAt!: Date | null;
  closeApprovedBy!: string | null;
  closeApprovedAt!: Date | null;
  closedAt!: Date | null;
  closedBy!: string | null;
  cancelReason!: string | null;
  createdAt!: Date;
  createdBy!: string;
  updatedAt!: Date;
  updatedBy!: string;
}
export class IncidentFolioEntity {
  tenantId!: string;
  year!: number;
  kind!: string;
  lastValue!: number;
}
export class IncidentTransitionEntity {
  tenantId!: string;
  incidentId!: string;
  sequence!: number;
  command!: string;
  fromStatus!: string | null;
  toStatus!: string;
  actorId!: string;
  comment!: string | null;
  occurredAt!: Date;
  changedFields!: object;
  before!: object | null;
}
export class IncidentIdempotencyEntity {
  tenantId!: string;
  actorId!: string;
  command!: string;
  key!: string;
  incidentId!: string;
  payloadHash!: string;
  status!: string;
  response!: object;
  createdAt!: Date;
  expiresAt!: Date;
}

export const IncidentSchema = new EntitySchema<IncidentEntity>({
  name: 'IncidentEntity',
  target: IncidentEntity,
  tableName: INCIDENT_TABLES.incidents,
  columns: {
    ...tenant,
    id: { ...text('id', 64), primary: true },
    folio: text('folio', 24),
    status: text('status', 24),
    version: { type: 'int', unsigned: true },
    cycle: { type: 'int', unsigned: true },
    reopenCount: counter('reopen_count'),
    type: text('type', 24),
    severity: text('severity', 16, true),
    vehicleId: text('vehicle_id', 64),
    areaId: text('area_id', 64),
    driverId: text('driver_id', 64, true),
    noDriverReason: text('no_driver_reason', 300, true),
    occurredAt: instant('occurred_at', true),
    occurredOn: day('occurred_on'),
    locationText: text('location_text', 300, true),
    locationLatitude: {
      name: 'location_latitude',
      type: 'decimal',
      precision: 9,
      scale: 6,
      nullable: true,
    },
    locationLongitude: {
      name: 'location_longitude',
      type: 'decimal',
      precision: 9,
      scale: 6,
      nullable: true,
    },
    description: text('description', 4000, true),
    vehicleOperable: flag('vehicle_operable'),
    damageDescription: text('damage_description', 2000, true),
    damageZones: { name: 'damage_zones', type: 'json' },
    noPhotoJustification: text('no_photo_justification', 500, true),
    coverageStatus: text('coverage_status', 16),
    policySnapshot: { name: 'policy_snapshot', type: 'json', nullable: true },
    reportedAt: instant('reported_at', true),
    reportedBy: text('reported_by', 72, true),
    responsibleId: text('responsible_id', 72, true),
    insurerName: text('insurer_name', 200, true),
    claimNumber: text('claim_number', 100, true),
    adjusterName: text('adjuster_name', 200, true),
    adjusterContact: text('adjuster_contact', 200, true),
    insurerReportedOn: day('insurer_reported_on'),
    insurerResult: text('insurer_result', 16, true),
    rejectionReason: text('rejection_reason', 1000, true),
    appealNote: text('appeal_note', 1000, true),
    noInsuranceReason: text('no_insurance_reason', 1000, true),
    costAssumed: flag('cost_assumed'),
    resolutionSummary: text('resolution_summary', 2000, true),
    totalLoss: flag('total_loss'),
    vehicleStatusDecision: text('vehicle_status_decision', 32, true),
    resolvedAt: instant('resolved_at', true),
    assumptionApprovedBy: text('assumption_approved_by', 72, true),
    assumptionApprovedAt: instant('assumption_approved_at', true),
    closeApprovedBy: text('close_approved_by', 72, true),
    closeApprovedAt: instant('close_approved_at', true),
    closedAt: instant('closed_at', true),
    closedBy: text('closed_by', 72, true),
    cancelReason: text('cancel_reason', 1000, true),
    createdAt: instant('created_at'),
    createdBy: text('created_by', 72),
    updatedAt: instant('updated_at'),
    updatedBy: text('updated_by', 72),
  },
});

/** One counter per tenant, year and kind; the row is locked while a folio is taken (BR-024). */
export const IncidentFolioSchema = new EntitySchema<IncidentFolioEntity>({
  name: 'IncidentFolioEntity',
  target: IncidentFolioEntity,
  tableName: INCIDENT_TABLES.folios,
  columns: {
    ...tenant,
    year: { type: 'smallint', unsigned: true, primary: true },
    kind: { ...text('kind', 16), primary: true },
    lastValue: counter('last_sequence'),
  },
});

export const IncidentTransitionSchema = new EntitySchema<IncidentTransitionEntity>({
  name: 'IncidentTransitionEntity',
  target: IncidentTransitionEntity,
  tableName: INCIDENT_TABLES.transitions,
  columns: {
    ...tenant,
    incidentId: { ...text('incident_id', 64), primary: true },
    sequence: { type: 'int', unsigned: true, primary: true },
    command: text('command', 32),
    fromStatus: text('from_status', 24, true),
    toStatus: text('to_status', 24),
    actorId: text('actor_id', 72),
    comment: text('comment', 1000, true),
    occurredAt: instant('occurred_at'),
    changedFields: { name: 'changed_fields', type: 'json' },
    before: { name: 'before_snapshot', type: 'json', nullable: true },
  },
});

/** Idempotency-Key registry (SPECS:195): one row per tenant, actor, command and key. */
export const IncidentIdempotencySchema = new EntitySchema<IncidentIdempotencyEntity>({
  name: 'IncidentIdempotencyEntity',
  target: IncidentIdempotencyEntity,
  tableName: INCIDENT_TABLES.idempotency,
  columns: {
    ...tenant,
    actorId: { ...text('actor_id', 72), primary: true },
    command: { ...text('command', 32), primary: true },
    key: { ...text('idempotency_key', 128), primary: true },
    incidentId: text('incident_id', 64),
    payloadHash: { name: 'payload_hash', type: 'char', length: 64, collation: bin },
    status: text('status', 16),
    response: { name: 'response', type: 'json' },
    createdAt: instant('created_at'),
    expiresAt: instant('expires_at'),
  },
});

export const INCIDENT_ENTITIES = [
  IncidentSchema,
  IncidentFolioSchema,
  IncidentTransitionSchema,
  IncidentIdempotencySchema,
] as const;
