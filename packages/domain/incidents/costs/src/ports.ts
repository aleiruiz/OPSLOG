import type { IncidentApplyResult, IncidentMutation } from '../../cases/src/index.js';
import type { CostCategory, CostKind } from './catalog.js';

/** Exact amount in the minor unit of its ISO 4217 currency, as digits. Currencies are never added together. */
export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface CostLine {
  readonly id: string;
  readonly kind: CostKind;
  readonly category: CostCategory;
  readonly amount: Money;
  readonly note: string | null;
}

/** One row per currency: the company bears repairs plus expenses minus recoveries. May be negative. */
export interface CurrencyTotals {
  readonly currency: string;
  readonly repairs: string;
  readonly expenses: string;
  readonly recoveries: string;
  readonly companyBorne: string;
}

export interface ClosedOrder {
  readonly orderId: string;
  readonly version: number;
  readonly status: string;
}

/** The consolidated costs of a closed cycle. Append-only: reopening never changes it. */
export interface CostSnapshot {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly cycle: number;
  readonly closedAt: string;
  readonly totals: readonly CurrencyTotals[];
  readonly orders: readonly ClosedOrder[];
}

/** Replaces all the own lines and sets or clears the initial estimate, in one transaction. */
export interface CostChange {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly lines: readonly CostLine[];
  readonly estimate: Money | null;
  /** Estimate updates need the actor and the instant. */
  readonly actorId: string;
  readonly at: string;
}

/**
 * Optional batch read of the own lines for the reports: the same answer as `lines`, for many cases
 * in a bounded number of reads. A case without lines is absent from the answer.
 */
export interface IncidentCostBatchReads {
  linesOfIncidents(
    tenantId: string,
    incidentIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly CostLine[]>>;
}

export type ApprovalKind = 'assumption' | 'close';

export interface IncidentCostStore {
  /** Own lines in the order the caller gave them. `tx` joins the transaction of a command. */
  lines(tenantId: string, incidentId: string, tx?: unknown): Promise<readonly CostLine[]>;
  estimate(tenantId: string, incidentId: string, tx?: unknown): Promise<Money | null>;
  /** Oldest cycle first. */
  snapshots(tenantId: string, incidentId: string): Promise<readonly CostSnapshot[]>;
  /** Joins the transaction of the closure; a second snapshot of the same cycle never replaces the first. */
  saveSnapshot(snapshot: CostSnapshot, tx: unknown): Promise<void>;
  /** What the company bore (per currency) when the approval was given, or `null` if none was recorded. */
  approval(
    tenantId: string,
    incidentId: string,
    kind: ApprovalKind,
    tx?: unknown,
  ): Promise<readonly Money[] | null>;
  /** Replaces the record of that kind, in the transaction of the approval. */
  saveApproval(
    tenantId: string,
    incidentId: string,
    kind: ApprovalKind,
    borne: readonly Money[],
    tx: unknown,
  ): Promise<void>;
  /** The incident mutation (version CAS, timeline, audit, outbox) and the lines in one transaction. */
  apply(mutation: IncidentMutation, change: CostChange): Promise<IncidentApplyResult>;
}

/** The deductible of the policy revision that covered the event, as insurance keeps it. */
export type PolicyDeductible =
  | { readonly kind: 'amount'; readonly amountMinor: string; readonly currency: string }
  | { readonly kind: 'percent'; readonly basisPoints: number };
export interface PolicyDeductibles {
  /** `null` when the revision has none. A read that fails throws. */
  deductible(
    tenantId: string,
    policyId: string,
    revision: number,
  ): Promise<PolicyDeductible | null>;
}
