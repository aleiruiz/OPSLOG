import { EntitySchema } from 'typeorm';

export const MAINTENANCE_TABLES = {
  plans: 'opslog_maintenance_plans',
  versions: 'opslog_maintenance_plan_versions',
  occurrences: 'opslog_maintenance_plan_occurrences',
  orders: 'opslog_maintenance_scheduled_orders',
  alerts: 'opslog_maintenance_plan_alerts',
  workshops: 'opslog_maintenance_workshops',
  mechanics: 'opslog_maintenance_mechanics',
} as const;

const bin = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: bin,
  nullable,
});
const date = (name: string, nullable = false) => ({
  name,
  type: 'datetime' as const,
  precision: 6,
  nullable,
});

export class MaintenancePlanEntity {
  tenantId!: string;
  id!: string;
  vehicleId!: string;
  state!: string;
  intervalDays!: number | null;
  intervalKm!: number | null;
  lastServiceDate!: string | null;
  lastServiceKm!: number | null;
  defaultWorkshopId!: string | null;
  defaultMechanicId!: string | null;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export class MaintenancePlanVersionEntity {
  tenantId!: string;
  planId!: string;
  version!: number;
  snapshot!: object;
  actorId!: string;
  createdAt!: Date;
}
export class MaintenanceOccurrenceEntity {
  tenantId!: string;
  id!: string;
  planId!: string;
  sequence!: number;
  planVersion!: number;
  trigger!: string;
  targetDate!: string | null;
  targetKm!: number | null;
  detectedAt!: Date;
  idempotencyKey!: string;
  orderId!: string;
  state!: string;
  workshopId!: string | null;
  mechanicId!: string | null;
  completedAt!: Date | null;
  actualDate!: string | null;
  actualKm!: number | null;
}
export class MaintenanceScheduledOrderEntity {
  tenantId!: string;
  id!: string;
  occurrenceId!: string;
  planId!: string;
  vehicleId!: string;
  status!: string;
  kind!: string;
  snapshot!: object;
  createdAt!: Date;
}
export class MaintenancePlanAlertEntity {
  tenantId!: string;
  id!: string;
  planId!: string;
  occurrence!: number;
  planVersion!: number;
  kind!: string;
  trigger!: string;
  threshold!: string;
  targetDate!: string | null;
  targetKm!: number | null;
  odometerLastUpdatedAt!: Date | null;
  odometerAgeSeconds!: number | null;
  occurredAt!: Date;
  idempotencyKey!: string;
}
export class MaintenanceWorkshopEntity {
  tenantId!: string;
  id!: string;
  name!: string;
  specialties!: string[];
  contact!: string | null;
  active!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}
export class MaintenanceMechanicEntity {
  tenantId!: string;
  id!: string;
  name!: string;
  specialties!: string[];
  contact!: string | null;
  kind!: string;
  workshopId!: string | null;
  memberId!: string | null;
  registeredBy!: string;
  active!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}

export const MaintenancePlanSchema = new EntitySchema<MaintenancePlanEntity>({
  name: 'MaintenancePlanEntity',
  target: MaintenancePlanEntity,
  tableName: MAINTENANCE_TABLES.plans,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    vehicleId: text('vehicle_id', 64),
    state: text('state', 16),
    intervalDays: { name: 'interval_days', type: 'int', unsigned: true, nullable: true },
    intervalKm: { name: 'interval_km', type: 'int', unsigned: true, nullable: true },
    lastServiceDate: {
      name: 'last_service_date',
      type: 'char',
      length: 10,
      collation: bin,
      nullable: true,
    },
    lastServiceKm: { name: 'last_service_km', type: 'int', unsigned: true, nullable: true },
    defaultWorkshopId: {
      name: 'default_workshop_id',
      type: 'varchar',
      length: '64',
      collation: bin,
      nullable: true,
    },
    defaultMechanicId: {
      name: 'default_mechanic_id',
      type: 'varchar',
      length: '64',
      collation: bin,
      nullable: true,
    },
    version: { type: 'int', unsigned: true },
    createdAt: date('created_at'),
    updatedAt: date('updated_at'),
  },
  indices: [
    { name: 'ix_maintenance_plans_vehicle', columns: ['tenantId', 'vehicleId'] },
    { name: 'ix_maintenance_plans_due', columns: ['tenantId', 'state'] },
  ],
});
export const MaintenancePlanVersionSchema = new EntitySchema<MaintenancePlanVersionEntity>({
  name: 'MaintenancePlanVersionEntity',
  target: MaintenancePlanVersionEntity,
  tableName: MAINTENANCE_TABLES.versions,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    planId: { ...text('plan_id', 64), primary: true },
    version: { type: 'int', unsigned: true, primary: true },
    snapshot: { type: 'json' },
    actorId: text('actor_id', 64),
    createdAt: date('created_at'),
  },
});
export const MaintenanceOccurrenceSchema = new EntitySchema<MaintenanceOccurrenceEntity>({
  name: 'MaintenanceOccurrenceEntity',
  target: MaintenanceOccurrenceEntity,
  tableName: MAINTENANCE_TABLES.occurrences,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    planId: text('plan_id', 64),
    sequence: { type: 'int', unsigned: true },
    planVersion: { name: 'plan_version', type: 'int', unsigned: true },
    trigger: text('trigger_kind', 16),
    targetDate: { name: 'target_date', type: 'char', length: 10, collation: bin, nullable: true },
    targetKm: { name: 'target_km', type: 'int', unsigned: true, nullable: true },
    detectedAt: date('detected_at'),
    idempotencyKey: text('idempotency_key', 160),
    orderId: text('order_id', 64),
    state: text('state', 16),
    workshopId: {
      name: 'workshop_id',
      type: 'varchar',
      length: '64',
      collation: bin,
      nullable: true,
    },
    mechanicId: {
      name: 'mechanic_id',
      type: 'varchar',
      length: '64',
      collation: bin,
      nullable: true,
    },
    completedAt: { ...date('completed_at', true) },
    actualDate: { name: 'actual_date', type: 'char', length: 10, collation: bin, nullable: true },
    actualKm: { name: 'actual_km', type: 'int', unsigned: true, nullable: true },
  },
  uniques: [
    { name: 'uq_maintenance_occurrence_sequence', columns: ['tenantId', 'planId', 'sequence'] },
    { name: 'uq_maintenance_occurrence_key', columns: ['tenantId', 'idempotencyKey'] },
  ],
  indices: [{ name: 'ix_maintenance_occurrence_plan', columns: ['tenantId', 'planId', 'state'] }],
});
export const MaintenanceOrderSchema = new EntitySchema<MaintenanceScheduledOrderEntity>({
  name: 'MaintenanceScheduledOrderEntity',
  target: MaintenanceScheduledOrderEntity,
  tableName: MAINTENANCE_TABLES.orders,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    occurrenceId: text('occurrence_id', 64),
    planId: text('plan_id', 64),
    vehicleId: text('vehicle_id', 64),
    status: text('status', 16),
    kind: text('kind', 16),
    snapshot: { type: 'json' },
    createdAt: date('created_at'),
  },
  uniques: [{ name: 'uq_maintenance_order_occurrence', columns: ['tenantId', 'occurrenceId'] }],
});
export const MaintenanceAlertSchema = new EntitySchema<MaintenancePlanAlertEntity>({
  name: 'MaintenancePlanAlertEntity',
  target: MaintenancePlanAlertEntity,
  tableName: MAINTENANCE_TABLES.alerts,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    planId: text('plan_id', 64),
    occurrence: { type: 'int', unsigned: true },
    planVersion: { name: 'plan_version', type: 'int', unsigned: true },
    kind: text('kind', 16),
    trigger: text('trigger_kind', 16),
    threshold: text('threshold_kind', 16),
    targetDate: { name: 'target_date', type: 'char', length: 10, collation: bin, nullable: true },
    targetKm: { name: 'target_km', type: 'int', unsigned: true, nullable: true },
    odometerLastUpdatedAt: {
      name: 'odometer_last_updated_at',
      type: 'datetime',
      precision: 6,
      nullable: true,
    },
    odometerAgeSeconds: {
      name: 'odometer_age_seconds',
      type: 'int',
      unsigned: true,
      nullable: true,
    },
    occurredAt: date('occurred_at'),
    idempotencyKey: text('idempotency_key', 200),
  },
  uniques: [{ name: 'uq_maintenance_alert_idempotency', columns: ['tenantId', 'idempotencyKey'] }],
  indices: [{ name: 'ix_maintenance_alert_listing', columns: ['tenantId', 'occurredAt'] }],
});
export const MaintenanceWorkshopSchema = new EntitySchema<MaintenanceWorkshopEntity>({
  name: 'MaintenanceWorkshopEntity',
  target: MaintenanceWorkshopEntity,
  tableName: MAINTENANCE_TABLES.workshops,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    name: text('name', 120),
    specialties: { type: 'json' },
    contact: { ...text('contact', 254, true) },
    active: { type: 'boolean', default: true },
    createdAt: date('created_at'),
    updatedAt: date('updated_at'),
  },
  indices: [{ name: 'ix_maintenance_workshop_name', columns: ['tenantId', 'name'] }],
});
export const MaintenanceMechanicSchema = new EntitySchema<MaintenanceMechanicEntity>({
  name: 'MaintenanceMechanicEntity',
  target: MaintenanceMechanicEntity,
  tableName: MAINTENANCE_TABLES.mechanics,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    name: text('name', 120),
    specialties: { type: 'json' },
    contact: { ...text('contact', 254, true) },
    kind: text('kind', 16),
    workshopId: {
      name: 'workshop_id',
      type: 'varchar',
      length: '64',
      collation: bin,
      nullable: true,
    },
    memberId: { name: 'member_id', type: 'varchar', length: '64', collation: bin, nullable: true },
    registeredBy: text('registered_by', 64),
    active: { type: 'boolean', default: true },
    createdAt: date('created_at'),
    updatedAt: date('updated_at'),
  },
  indices: [
    { name: 'ix_maintenance_mechanic_workshop', columns: ['tenantId', 'workshopId'] },
    { name: 'ix_maintenance_mechanic_member', columns: ['tenantId', 'memberId'] },
  ],
});
export const MAINTENANCE_ENTITIES = [
  MaintenancePlanSchema,
  MaintenancePlanVersionSchema,
  MaintenanceOccurrenceSchema,
  MaintenanceOrderSchema,
  MaintenanceAlertSchema,
  MaintenanceWorkshopSchema,
  MaintenanceMechanicSchema,
] as const;
