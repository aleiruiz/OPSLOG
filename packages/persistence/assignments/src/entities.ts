import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: keys are compared exactly as normalized
 * by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const ASSIGNMENT_TABLES = {
  assignments: 'opslog_vehicle_assignments',
  events: 'opslog_vehicle_assignment_events',
} as const;

/**
 * Assignment row. `tenantId` is the BRD's `company_id`: part of the primary key and of every index,
 * so no query can reach a row without naming its company. The two flag columns are what makes
 * BR-002 / BR-003 hold under concurrency: `currentFlag` is 1 while the assignment is current and
 * NULL once ended; `principalFlag` is 1 only for a current principal and NULL otherwise. Unique
 * keys over them (NULLs never collide) allow one current assignment per (vehicle, driver), one
 * current principal per vehicle and one per driver. A CHECK keeps both flags consistent with
 * `ended_at` and `type`; the store derives them, the domain never sees them.
 */
export class AssignmentEntity {
  tenantId!: string;
  id!: string;
  vehicleId!: string;
  employeeId!: string;
  type!: string;
  reason!: string;
  assignedBy!: string;
  startedAt!: Date;
  endedAt!: Date | null;
  endKind!: string | null;
  endReason!: string | null;
  endedBy!: string | null;
  currentFlag!: number | null;
  principalFlag!: number | null;
  version!: number;
  updatedAt!: Date;
}

/** Append-only history of an assignment: written once, never updated or deleted. */
export class AssignmentEventEntity {
  tenantId!: string;
  assignmentId!: string;
  seq!: number;
  kind!: string;
  actorId!: string;
  reason!: string;
  at!: Date;
}

const bin = BINARY_COLLATION;
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length,
  collation: bin,
  ...(nullable ? { nullable: true } : {}),
});
const flag = (name: string) => ({
  name,
  type: 'tinyint' as const,
  unsigned: true,
  nullable: true,
});

export const AssignmentEntitySchema = new EntitySchema<AssignmentEntity>({
  name: 'AssignmentEntity',
  target: AssignmentEntity,
  tableName: ASSIGNMENT_TABLES.assignments,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    vehicleId: text('vehicle_id', 64),
    employeeId: text('employee_id', 64),
    type: text('type', 16),
    reason: text('reason', 200),
    assignedBy: text('assigned_by', 64),
    startedAt: { name: 'started_at', type: 'datetime', precision: 6 },
    endedAt: { name: 'ended_at', type: 'datetime', precision: 6, nullable: true },
    endKind: text('end_kind', 8, true),
    endReason: text('end_reason', 200, true),
    endedBy: text('ended_by', 64, true),
    currentFlag: flag('current_flag'),
    principalFlag: flag('principal_flag'),
    version: { type: 'int', unsigned: true },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
  },
  indices: [
    { name: 'ix_assignments_vehicle', columns: ['tenantId', 'vehicleId', 'startedAt'] },
    { name: 'ix_assignments_employee', columns: ['tenantId', 'employeeId', 'startedAt'] },
    { name: 'ix_assignments_listing', columns: ['tenantId', 'startedAt', 'id'] },
  ],
  uniques: [
    {
      name: 'ux_assignments_current_pair',
      columns: ['tenantId', 'vehicleId', 'employeeId', 'currentFlag'],
    },
    {
      name: 'ux_assignments_principal_vehicle',
      columns: ['tenantId', 'vehicleId', 'principalFlag'],
    },
    {
      name: 'ux_assignments_principal_employee',
      columns: ['tenantId', 'employeeId', 'principalFlag'],
    },
  ],
});

export const AssignmentEventEntitySchema = new EntitySchema<AssignmentEventEntity>({
  name: 'AssignmentEventEntity',
  target: AssignmentEventEntity,
  tableName: ASSIGNMENT_TABLES.events,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    assignmentId: { ...text('assignment_id', 64), primary: true },
    seq: { type: 'int', unsigned: true, primary: true },
    kind: text('kind', 8),
    actorId: text('actor_id', 64),
    reason: text('reason', 200),
    at: { type: 'datetime', precision: 6 },
  },
});

export const ASSIGNMENT_ENTITIES = [AssignmentEntitySchema, AssignmentEventEntitySchema] as const;
