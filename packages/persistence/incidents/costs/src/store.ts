import 'reflect-metadata';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  IncidentApplyResult,
  IncidentMutation,
  IncidentStore,
} from '../../../../domain/incidents/cases/src/index.js';
import type {
  ClosedOrder,
  CostChange,
  CostLine,
  CostSnapshot,
  CurrencyTotals,
  IncidentCostStore,
  Money,
} from '../../../../domain/incidents/costs/src/index.js';
import {
  IncidentCostEstimateSchema,
  IncidentCostLineSchema,
  IncidentCostSnapshotSchema,
  type IncidentCostLineEntity,
  type IncidentCostSnapshotEntity,
} from './entities.js';

/** The driver may hand JSON back as text, depending on the connection. */
const json = <T>(value: object | string): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

export const lineRow = (
  tenantId: string,
  incidentId: string,
  position: number,
  line: CostLine,
): IncidentCostLineEntity => ({
  tenantId,
  incidentId,
  id: line.id,
  position,
  kind: line.kind,
  category: line.category,
  amountMinor: line.amount.amountMinor,
  currency: line.amount.currency,
  note: line.note,
});
export const lineFrom = (row: IncidentCostLineEntity): CostLine => ({
  id: row.id,
  kind: row.kind as CostLine['kind'],
  category: row.category as CostLine['category'],
  amount: { amountMinor: String(row.amountMinor), currency: row.currency },
  note: row.note,
});
export const snapshotRow = (snapshot: CostSnapshot): IncidentCostSnapshotEntity => ({
  tenantId: snapshot.tenantId,
  incidentId: snapshot.incidentId,
  cycle: snapshot.cycle,
  closedAt: new Date(snapshot.closedAt),
  totals: snapshot.totals,
  orders: snapshot.orders,
});
export const snapshotFrom = (row: IncidentCostSnapshotEntity): CostSnapshot => ({
  tenantId: row.tenantId,
  incidentId: row.incidentId,
  cycle: Number(row.cycle),
  closedAt: row.closedAt.toISOString(),
  totals: json<CurrencyTotals[]>(row.totals),
  orders: json<ClosedOrder[]>(row.orders),
});

/**
 * Costs of the cases. Every selector carries the tenant. Writes join the transaction of the incident
 * store, so the case row (version CAS), its timeline, audit, outbox and the lines commit together.
 */
export class TypeOrmIncidentCostStore implements IncidentCostStore {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly base: IncidentStore,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Incident cost store requires MySQL with synchronize disabled');
  }

  private source(tx?: unknown): DataSource | EntityManager {
    return (tx as EntityManager | undefined) ?? this.dataSource;
  }

  public async lines(
    tenantId: string,
    incidentId: string,
    tx?: unknown,
  ): Promise<readonly CostLine[]> {
    const rows = await this.source(tx)
      .getRepository(IncidentCostLineSchema)
      .find({ where: { tenantId, incidentId }, order: { position: 'ASC', id: 'ASC' } });
    return rows.map(lineFrom);
  }

  public async estimate(tenantId: string, incidentId: string, tx?: unknown): Promise<Money | null> {
    const row = await this.source(tx)
      .getRepository(IncidentCostEstimateSchema)
      .findOneBy({ tenantId, incidentId });
    return row ? { amountMinor: String(row.amountMinor), currency: row.currency } : null;
  }

  public async snapshots(tenantId: string, incidentId: string): Promise<readonly CostSnapshot[]> {
    const rows = await this.dataSource
      .getRepository(IncidentCostSnapshotSchema)
      .find({ where: { tenantId, incidentId }, order: { cycle: 'ASC' } });
    return rows.map(snapshotFrom);
  }

  public async saveSnapshot(snapshot: CostSnapshot, tx: unknown): Promise<void> {
    // A second snapshot of the same cycle trips the primary key (ER_DUP_ENTRY) and aborts the closure.
    await (tx as EntityManager)
      .getRepository(IncidentCostSnapshotSchema)
      .insert(snapshotRow(snapshot));
  }

  private async write(manager: EntityManager, change: CostChange): Promise<boolean> {
    const { tenantId, incidentId } = change;
    const lines = manager.getRepository(IncidentCostLineSchema);
    await lines.delete({ tenantId, incidentId });
    for (const [position, line] of change.lines.entries())
      await lines.insert(lineRow(tenantId, incidentId, position, line));
    const estimates = manager.getRepository(IncidentCostEstimateSchema);
    await estimates.delete({ tenantId, incidentId });
    if (change.estimate)
      await estimates.insert({
        tenantId,
        incidentId,
        amountMinor: change.estimate.amountMinor,
        currency: change.estimate.currency,
        updatedAt: new Date(change.at),
        updatedBy: change.actorId,
      });
    return true;
  }

  public apply(mutation: IncidentMutation, change: CostChange): Promise<IncidentApplyResult> {
    return this.base.apply(mutation, { run: (tx) => this.write(tx as EntityManager, change) });
  }
}
