import type {
  IncidentApplyResult,
  IncidentMutation,
  IncidentStore,
} from '../../cases/src/index.js';
import type { IncidentRepairStore, RepairBatchReads, RepairChange, RepairLink } from './ports.js';

/** In-memory links, written through the incident store so a lost race leaves them untouched. */
export class InMemoryIncidentRepairStore implements IncidentRepairStore, RepairBatchReads {
  private rows: RepairLink[] = [];
  public constructor(private readonly base: IncidentStore) {}

  public async links(tenantId: string, incidentId: string): Promise<readonly RepairLink[]> {
    return structuredClone(
      this.rows.filter((row) => row.tenantId === tenantId && row.incidentId === incidentId),
    );
  }

  public async linkOfOrder(tenantId: string, orderId: string): Promise<RepairLink | null> {
    const found = this.rows.find((row) => row.tenantId === tenantId && row.orderId === orderId);
    return found ? structuredClone(found) : null;
  }

  public async linksOfOrders(
    tenantId: string,
    orderIds: readonly string[],
  ): Promise<ReadonlyMap<string, RepairLink>> {
    const wanted = new Set(orderIds);
    const result = new Map<string, RepairLink>();
    for (const row of this.rows)
      if (row.tenantId === tenantId && wanted.has(row.orderId))
        result.set(row.orderId, structuredClone(row));
    return result;
  }

  public async linksOfIncidents(
    tenantId: string,
    incidentIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly RepairLink[]>> {
    const wanted = new Set(incidentIds);
    const result = new Map<string, RepairLink[]>();
    for (const row of this.rows)
      if (row.tenantId === tenantId && wanted.has(row.incidentId))
        result.set(row.incidentId, [...(result.get(row.incidentId) ?? []), structuredClone(row)]);
    return result;
  }

  private write(change: RepairChange): boolean {
    if (change.kind === 'link') {
      const { link } = change;
      if (this.rows.some((row) => row.tenantId === link.tenantId && row.orderId === link.orderId))
        return false;
      this.rows = [...this.rows, structuredClone(link)];
      return true;
    }
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (row) =>
        !(
          row.tenantId === change.tenantId &&
          row.incidentId === change.incidentId &&
          row.id === change.linkId
        ),
    );
    return this.rows.length === before - 1;
  }

  public apply(mutation: IncidentMutation, change: RepairChange): Promise<IncidentApplyResult> {
    return this.base.apply(mutation, { run: async () => this.write(change) });
  }
}
