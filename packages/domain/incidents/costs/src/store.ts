import type {
  IncidentApplyResult,
  IncidentMutation,
  IncidentStore,
} from '../../cases/src/index.js';
import type { CostChange, CostLine, CostSnapshot, IncidentCostStore, Money } from './ports.js';

const scope = (tenantId: string, incidentId: string) =>
  `${tenantId.length}:${tenantId}${incidentId}`;

/** In-memory lines, estimates and snapshots, written through the incident store like the MySQL adapter. */
export class InMemoryIncidentCostStore implements IncidentCostStore {
  private readonly lineRows = new Map<string, CostLine[]>();
  private readonly estimates = new Map<string, Money>();
  private readonly closed = new Map<string, CostSnapshot[]>();
  public constructor(private readonly base: IncidentStore) {}

  public async lines(tenantId: string, incidentId: string): Promise<readonly CostLine[]> {
    return structuredClone(this.lineRows.get(scope(tenantId, incidentId)) ?? []);
  }

  public async estimate(tenantId: string, incidentId: string): Promise<Money | null> {
    return structuredClone(this.estimates.get(scope(tenantId, incidentId)) ?? null);
  }

  public async snapshots(tenantId: string, incidentId: string): Promise<readonly CostSnapshot[]> {
    return structuredClone(this.closed.get(scope(tenantId, incidentId)) ?? []);
  }

  public async saveSnapshot(snapshot: CostSnapshot): Promise<void> {
    const key = scope(snapshot.tenantId, snapshot.incidentId);
    const list = this.closed.get(key) ?? [];
    // Append-only: a cycle that already has its snapshot keeps it.
    if (list.some((row) => row.cycle === snapshot.cycle)) return;
    this.closed.set(key, [...list, structuredClone(snapshot)]);
  }

  public apply(mutation: IncidentMutation, change: CostChange): Promise<IncidentApplyResult> {
    return this.base.apply(mutation, {
      run: async () => {
        const key = scope(change.tenantId, change.incidentId);
        this.lineRows.set(key, structuredClone([...change.lines]));
        if (change.estimate) this.estimates.set(key, structuredClone(change.estimate));
        else this.estimates.delete(key);
        return true;
      },
    });
  }
}
