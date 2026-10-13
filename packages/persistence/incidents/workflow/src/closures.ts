import 'reflect-metadata';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  ClosedOrderRef,
  IncidentClosure,
  IncidentClosures,
} from '../../../../domain/incidents/workflow/src/index.js';
import { IncidentClosureSchema, type IncidentClosureEntity } from './entities.js';

const toDate = (value: string | null): Date | null => (value === null ? null : new Date(value));
const toIso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const flag = (value: boolean | number | null): boolean | null =>
  value === null ? null : Boolean(value);

export function closureRow(closure: IncidentClosure): IncidentClosureEntity {
  return {
    tenantId: closure.tenantId,
    incidentId: closure.incidentId,
    cycle: closure.cycle,
    statusBefore: closure.statusBefore,
    resolvedFrom: closure.resolvedFrom,
    resolvedAt: toDate(closure.resolvedAt),
    resolutionSummary: closure.resolutionSummary,
    totalLoss: closure.totalLoss,
    vehicleStatusDecision: closure.vehicleStatusDecision,
    insurerResult: closure.insurerResult,
    costAssumed: closure.costAssumed,
    closeApprovedBy: closure.closeApprovedBy,
    closeApprovedAt: toDate(closure.closeApprovedAt),
    orders: closure.orders,
    closedAt: new Date(closure.closedAt),
    closedBy: closure.closedBy,
  };
}

export function closureFrom(row: IncidentClosureEntity): IncidentClosure {
  // The driver may hand JSON back as text, depending on the connection.
  const orders = (
    typeof row.orders === 'string' ? JSON.parse(row.orders) : row.orders
  ) as readonly ClosedOrderRef[];
  return {
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    cycle: Number(row.cycle),
    statusBefore: row.statusBefore as IncidentClosure['statusBefore'],
    resolvedFrom: row.resolvedFrom as IncidentClosure['resolvedFrom'],
    resolvedAt: toIso(row.resolvedAt),
    resolutionSummary: row.resolutionSummary,
    totalLoss: flag(row.totalLoss),
    vehicleStatusDecision: row.vehicleStatusDecision,
    insurerResult: row.insurerResult as IncidentClosure['insurerResult'],
    costAssumed: flag(row.costAssumed),
    closeApprovedBy: row.closeApprovedBy,
    closeApprovedAt: toIso(row.closeApprovedAt),
    orders: orders.map(({ orderId, version, status }) => ({ orderId, version, status })),
    closedAt: row.closedAt.toISOString(),
    closedBy: row.closedBy,
  };
}

/**
 * The closures of the cases. `record` runs in the transaction of the closure (`tx` is its entity
 * manager), so the row exists exactly when the case is closed. Every selector names the tenant.
 */
export class TypeOrmIncidentClosures implements IncidentClosures {
  public constructor(private readonly dataSource: DataSource) {}

  public async record(closure: IncidentClosure, tx: unknown): Promise<boolean> {
    const manager = tx as EntityManager;
    try {
      await manager.getRepository(IncidentClosureSchema).insert(closureRow(closure));
      return true;
    } catch (error) {
      // The cycle already has its closure: the whole mutation is refused.
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false;
      throw error;
    }
  }

  public async list(tenantId: string, incidentId: string): Promise<readonly IncidentClosure[]> {
    const rows = await this.dataSource
      .getRepository(IncidentClosureSchema)
      .find({ where: { tenantId, incidentId }, order: { cycle: 'ASC' } });
    return rows.map(closureFrom);
  }
}
