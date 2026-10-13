import { EntitySchema } from 'typeorm';

export const INCIDENT_WORKFLOW_TABLES = {
  closures: 'opslog_incident_closures',
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

export class IncidentClosureEntity {
  tenantId!: string;
  incidentId!: string;
  cycle!: number;
  statusBefore!: string;
  resolvedFrom!: string;
  resolvedAt!: Date | null;
  resolutionSummary!: string | null;
  totalLoss!: boolean | number | null;
  vehicleStatusDecision!: string | null;
  insurerResult!: string | null;
  costAssumed!: boolean | number | null;
  closeApprovedBy!: string | null;
  closeApprovedAt!: Date | null;
  orders!: object;
  closedAt!: Date;
  closedBy!: string;
}

/** The snapshot of each closed cycle of a case. The runtime account inserts and reads it, never updates it. */
export const IncidentClosureSchema = new EntitySchema<IncidentClosureEntity>({
  name: 'IncidentClosureEntity',
  target: IncidentClosureEntity,
  tableName: INCIDENT_WORKFLOW_TABLES.closures,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    incidentId: { ...text('incident_id', 64), primary: true },
    cycle: { name: 'cycle', type: 'int', unsigned: true, primary: true },
    statusBefore: text('status_before', 24),
    resolvedFrom: text('resolved_from', 24),
    resolvedAt: instant('resolved_at', true),
    resolutionSummary: text('resolution_summary', 2000, true),
    totalLoss: { name: 'total_loss', type: 'boolean', nullable: true },
    vehicleStatusDecision: text('vehicle_status_decision', 32, true),
    insurerResult: text('insurer_result', 16, true),
    costAssumed: { name: 'cost_assumed', type: 'boolean', nullable: true },
    closeApprovedBy: text('close_approved_by', 72, true),
    closeApprovedAt: instant('close_approved_at', true),
    orders: { name: 'orders', type: 'json' },
    closedAt: instant('closed_at'),
    closedBy: text('closed_by', 72),
  },
});

export const INCIDENT_WORKFLOW_ENTITIES = [IncidentClosureSchema];
