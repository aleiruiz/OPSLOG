import type { IncidentStatus, InsurerResult } from '../../cases/src/index.js';

/** A work order linked to the case when it closed: its id and the version it had, never an amount. */
export interface ClosedOrderRef {
  readonly orderId: string;
  readonly version: number;
  readonly status: string;
}

/**
 * The state of one cycle of a case at the moment it closed (SPECS §6.2, INC-WORKFLOW invariant 6).
 * The row is written with the closure and never changes: reopening opens a new cycle, and the next
 * closure adds a row of its own.
 */
export interface IncidentClosure {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly cycle: number;
  /** The state the case left: always `resolved`. */
  readonly statusBefore: IncidentStatus;
  /** The state `resolve` came from: the route this cycle took. */
  readonly resolvedFrom: IncidentStatus;
  readonly resolvedAt: string | null;
  readonly resolutionSummary: string | null;
  readonly totalLoss: boolean | null;
  readonly vehicleStatusDecision: string | null;
  readonly insurerResult: InsurerResult | null;
  readonly costAssumed: boolean | null;
  readonly closeApprovedBy: string | null;
  readonly closeApprovedAt: string | null;
  readonly orders: readonly ClosedOrderRef[];
  readonly closedAt: string;
  readonly closedBy: string;
}

/**
 * Where the closure rows live. `record` joins the transaction of the closure: `tx` is whatever the
 * incident store runs in (the ORM manager for MySQL, nothing in memory). It resolves `false` when the
 * cycle already has its row, which aborts the closure.
 */
export interface IncidentClosures {
  record(closure: IncidentClosure, tx: unknown): Promise<boolean>;
  /** Oldest cycle first. */
  list(tenantId: string, incidentId: string): Promise<readonly IncidentClosure[]>;
}

export interface ClosureCostsRequest {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly cycle: number;
  /** The instant of the closure, so the cost snapshot and the closure row carry the same one. */
  readonly closedAt: string;
}
/**
 * INC-COSTS keeps the consolidated costs of the cycle here, in the transaction of the closure, so a
 * failure leaves no closed case and no half snapshot. Until INC-COSTS exists nothing is kept.
 */
export interface IncidentClosureCosts {
  snapshot(request: ClosureCostsRequest, tx: unknown): Promise<void>;
}

/** Closures in memory: unit tests and the non-persistent composition. */
export class InMemoryIncidentClosures implements IncidentClosures {
  private readonly rows = new Map<string, IncidentClosure>();
  public async record(closure: IncidentClosure): Promise<boolean> {
    const key = JSON.stringify([closure.tenantId, closure.incidentId, closure.cycle]);
    if (this.rows.has(key)) return false;
    this.rows.set(key, structuredClone(closure));
    return true;
  }
  public async list(tenantId: string, incidentId: string): Promise<readonly IncidentClosure[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId && row.incidentId === incidentId)
      .sort((a, b) => a.cycle - b.cycle)
      .map((row) => structuredClone(row));
  }
}
