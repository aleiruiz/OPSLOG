import { EntitySchema } from 'typeorm';

export const WORK_ORDER_TABLES = {
  orders: 'opslog_maintenance_work_orders',
  tasks: 'opslog_maintenance_work_order_tasks',
  parts: 'opslog_maintenance_work_order_parts',
  costs: 'opslog_maintenance_work_order_costs',
  transitions: 'opslog_maintenance_work_order_transitions',
  files: 'opslog_maintenance_work_order_files',
  idempotency: 'opslog_maintenance_work_order_idempotency',
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
const key = { tenantId: { ...text('company_id', 64), primary: true } };

export class WorkOrderEntity {
  tenantId!: string;
  id!: string;
  kind!: string;
  vehicleId!: string;
  planId!: string | null;
  occurrenceId!: string | null;
  status!: string;
  version!: number;
  description!: string | null;
  responsibleId!: string | null;
  workshopId!: string | null;
  mechanicId!: string | null;
  scheduledDate!: string | null;
  requiresWorkshop!: boolean;
  startedAt!: Date | null;
  completedAt!: Date | null;
  actualDate!: string | null;
  actualKm!: number | null;
  closeApprovedBy!: string | null;
  closeApprovedAt!: Date | null;
  closedAt!: Date | null;
  closedBy!: string | null;
  vehicleStatusDecision!: string | null;
  cancelReason!: string | null;
  reopenCount!: number;
  createdAt!: Date;
  createdBy!: string;
  updatedAt!: Date;
  updatedBy!: string;
}
export class WorkOrderTaskEntity {
  tenantId!: string;
  orderId!: string;
  id!: string;
  position!: number;
  description!: string;
}
export class WorkOrderPartEntity {
  tenantId!: string;
  orderId!: string;
  id!: string;
  position!: number;
  name!: string;
  quantity!: string;
  unitCostMinor!: string | null;
  unitCostCurrency!: string | null;
}
export class WorkOrderCostEntity {
  tenantId!: string;
  orderId!: string;
  id!: string;
  position!: number;
  category!: string;
  amountMinor!: string;
  currency!: string;
}
export class WorkOrderFileEntity {
  tenantId!: string;
  orderId!: string;
  id!: string;
  fileId!: string;
  kind!: string;
  displayName!: string;
  contentType!: string;
  sizeBytes!: string | number;
  attachedBy!: string;
  attachedAt!: Date;
}
export class WorkOrderIdempotencyEntity {
  tenantId!: string;
  actorId!: string;
  command!: string;
  key!: string;
  orderId!: string;
  payloadHash!: string;
  status!: string;
  response!: object;
  createdAt!: Date;
  expiresAt!: Date;
}
export class WorkOrderTransitionEntity {
  tenantId!: string;
  orderId!: string;
  sequence!: number;
  command!: string;
  fromStatus!: string | null;
  toStatus!: string;
  actorId!: string;
  comment!: string | null;
  occurredAt!: Date;
  before!: object | null;
}

export const WorkOrderSchema = new EntitySchema<WorkOrderEntity>({
  name: 'WorkOrderEntity',
  target: WorkOrderEntity,
  tableName: WORK_ORDER_TABLES.orders,
  columns: {
    ...key,
    id: { ...text('id', 64), primary: true },
    kind: text('kind', 16),
    vehicleId: text('vehicle_id', 64),
    planId: text('plan_id', 64, true),
    occurrenceId: text('occurrence_id', 64, true),
    status: text('status', 16),
    version: { type: 'int', unsigned: true },
    description: text('description', 2000, true),
    responsibleId: text('responsible_id', 64, true),
    workshopId: text('workshop_id', 64, true),
    mechanicId: text('mechanic_id', 64, true),
    scheduledDate: day('scheduled_date'),
    requiresWorkshop: { name: 'requires_workshop', type: 'boolean' },
    startedAt: instant('started_at', true),
    completedAt: instant('completed_at', true),
    actualDate: day('actual_date'),
    actualKm: { name: 'actual_km', type: 'int', unsigned: true, nullable: true },
    closeApprovedBy: text('close_approved_by', 72, true),
    closeApprovedAt: instant('close_approved_at', true),
    closedAt: instant('closed_at', true),
    closedBy: text('closed_by', 72, true),
    vehicleStatusDecision: text('vehicle_status_decision', 32, true),
    cancelReason: text('cancel_reason', 1000, true),
    reopenCount: { name: 'reopen_count', type: 'int', unsigned: true },
    createdAt: instant('created_at'),
    createdBy: text('created_by', 72),
    updatedAt: instant('updated_at'),
    updatedBy: text('updated_by', 72),
  },
});
const child = { ...key, orderId: { ...text('order_id', 64), primary: true } };
export const WorkOrderTaskSchema = new EntitySchema<WorkOrderTaskEntity>({
  name: 'WorkOrderTaskEntity',
  target: WorkOrderTaskEntity,
  tableName: WORK_ORDER_TABLES.tasks,
  columns: {
    ...child,
    id: { ...text('id', 64), primary: true },
    position: { type: 'smallint', unsigned: true },
    description: text('description', 500),
  },
});
export const WorkOrderPartSchema = new EntitySchema<WorkOrderPartEntity>({
  name: 'WorkOrderPartEntity',
  target: WorkOrderPartEntity,
  tableName: WORK_ORDER_TABLES.parts,
  columns: {
    ...child,
    id: { ...text('id', 64), primary: true },
    position: { type: 'smallint', unsigned: true },
    name: text('name', 200),
    quantity: { type: 'decimal', precision: 10, scale: 3 },
    unitCostMinor: { name: 'unit_cost_minor', type: 'bigint', unsigned: true, nullable: true },
    unitCostCurrency: {
      name: 'unit_cost_currency',
      type: 'char',
      length: 3,
      collation: bin,
      nullable: true,
    },
  },
});
export const WorkOrderCostSchema = new EntitySchema<WorkOrderCostEntity>({
  name: 'WorkOrderCostEntity',
  target: WorkOrderCostEntity,
  tableName: WORK_ORDER_TABLES.costs,
  columns: {
    ...child,
    id: { ...text('id', 64), primary: true },
    position: { type: 'smallint', unsigned: true },
    category: text('category', 32),
    amountMinor: { name: 'amount_minor', type: 'bigint', unsigned: true },
    currency: { type: 'char', length: 3, collation: bin },
  },
});
export const WorkOrderTransitionSchema = new EntitySchema<WorkOrderTransitionEntity>({
  name: 'WorkOrderTransitionEntity',
  target: WorkOrderTransitionEntity,
  tableName: WORK_ORDER_TABLES.transitions,
  columns: {
    ...child,
    sequence: { type: 'int', unsigned: true, primary: true },
    command: text('command', 32),
    fromStatus: text('from_status', 16, true),
    toStatus: text('to_status', 16),
    actorId: text('actor_id', 72),
    comment: text('comment', 1000, true),
    occurredAt: instant('occurred_at'),
    before: { name: 'before_snapshot', type: 'json', nullable: true },
  },
});

export const WorkOrderFileSchema = new EntitySchema<WorkOrderFileEntity>({
  name: 'WorkOrderFileEntity',
  target: WorkOrderFileEntity,
  tableName: WORK_ORDER_TABLES.files,
  columns: {
    ...child,
    id: { ...text('id', 64), primary: true },
    fileId: text('file_id', 64),
    kind: text('kind', 16),
    displayName: text('display_name', 120),
    contentType: text('content_type', 100),
    sizeBytes: { name: 'size_bytes', type: 'bigint', unsigned: true },
    attachedBy: text('attached_by', 72),
    attachedAt: instant('attached_at'),
  },
});

/** Idempotency-Key registry (SPECS:195): one row per tenant, actor, command and key. */
export const WorkOrderIdempotencySchema = new EntitySchema<WorkOrderIdempotencyEntity>({
  name: 'WorkOrderIdempotencyEntity',
  target: WorkOrderIdempotencyEntity,
  tableName: WORK_ORDER_TABLES.idempotency,
  columns: {
    ...key,
    actorId: { ...text('actor_id', 72), primary: true },
    command: { ...text('command', 32), primary: true },
    key: { ...text('idempotency_key', 128), primary: true },
    orderId: text('order_id', 64),
    payloadHash: { name: 'payload_hash', type: 'char', length: 64, collation: bin },
    status: text('status', 16),
    response: { name: 'response', type: 'json' },
    createdAt: instant('created_at'),
    expiresAt: instant('expires_at'),
  },
});

export const WORK_ORDER_ENTITIES = [
  WorkOrderSchema,
  WorkOrderTaskSchema,
  WorkOrderPartSchema,
  WorkOrderCostSchema,
  WorkOrderTransitionSchema,
  WorkOrderFileSchema,
  WorkOrderIdempotencySchema,
] as const;
