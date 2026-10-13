import type {
  IncidentApplyResult,
  IncidentMutation,
  IncidentStore,
} from '../../cases/src/index.js';
import type { IncidentRepairStore, RepairChange, RepairLink } from './ports.js';

/** In-memory links, written through the incident store so a lost race leaves them untouched. */
export class InMemoryIncidentRepairStore implements IncidentRepairStore {
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
  ): Promise<readonly RepairLink[]> {
    return structuredClone(
      this.rows.filter((row) => row.tenantId === tenantId && orderIds.includes(row.orderId)),
    );
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
