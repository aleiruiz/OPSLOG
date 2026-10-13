import { EntitySchema } from 'typeorm';

export const INCIDENT_COST_TABLES = {
  lines: 'opslog_incident_cost_lines',
  estimates: 'opslog_incident_cost_estimates',
  snapshots: 'opslog_incident_cost_snapshots',
} as const;

const bin = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: bin,
  nullable,
});
const money = (prefix: string) => ({
  amount: { name: `${prefix}amount_minor`, type: 'bigint' as const, unsigned: true },
  currency: { name: `${prefix}currency`, type: 'char' as const, length: '3', collation: bin },
});
const key = {
  tenantId: { ...text('company_id', 64), primary: true },
  incidentId: { ...text('incident_id', 64), primary: true },
};

export class IncidentCostLineEntity {
  tenantId!: string;
  incidentId!: string;
  id!: string;
  position!: number;
  kind!: string;
  category!: string;
  amountMinor!: string;
  currency!: string;
  note!: string | null;
}
export class IncidentCostEstimateEntity {
  tenantId!: string;
  incidentId!: string;
  amountMinor!: string;
  currency!: string;
  updatedAt!: Date;
  updatedBy!: string;
}
export class IncidentCostSnapshotEntity {
  tenantId!: string;
  incidentId!: string;
  cycle!: number;
  closedAt!: Date;
  totals!: object;
  orders!: object;
}

/** Own cost lines of a case. The runtime account inserts, reads and deletes (a change replaces them all). */
export const IncidentCostLineSchema = new EntitySchema<IncidentCostLineEntity>({
  name: 'IncidentCostLineEntity',
  target: IncidentCostLineEntity,
  tableName: INCIDENT_COST_TABLES.lines,
  columns: {
    ...key,
    id: { ...text('id', 64), primary: true },
    position: { name: 'position', type: 'int', unsigned: true },
    kind: text('kind', 16),
    category: text('category', 24),
    amountMinor: money('').amount,
    currency: money('').currency,
    note: text('note', 200, true),
  },
});

export const IncidentCostEstimateSchema = new EntitySchema<IncidentCostEstimateEntity>({
  name: 'IncidentCostEstimateEntity',
  target: IncidentCostEstimateEntity,
  tableName: INCIDENT_COST_TABLES.estimates,
  columns: {
    ...key,
    amountMinor: money('').amount,
    currency: money('').currency,
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
    updatedBy: text('updated_by', 72),
  },
});

/** The consolidated costs of each closed cycle. The runtime account inserts and reads, never updates. */
export const IncidentCostSnapshotSchema = new EntitySchema<IncidentCostSnapshotEntity>({
  name: 'IncidentCostSnapshotEntity',
  target: IncidentCostSnapshotEntity,
  tableName: INCIDENT_COST_TABLES.snapshots,
  columns: {
    ...key,
    cycle: { name: 'cycle', type: 'int', unsigned: true, primary: true },
    closedAt: { name: 'closed_at', type: 'datetime', precision: 6 },
    totals: { name: 'totals', type: 'json' },
    orders: { name: 'orders', type: 'json' },
  },
});

export const INCIDENT_COST_ENTITIES = [
  IncidentCostLineSchema,
  IncidentCostEstimateSchema,
  IncidentCostSnapshotSchema,
];
