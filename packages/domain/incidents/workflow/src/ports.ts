import type { IncidentReferences } from '../../cases/src/index.js';
import type { IncidentClosureCosts, IncidentClosures } from './closures.js';
import type { EvidenceCategory, EvidenceStage } from '../../third-parties/src/index.js';

/** The evidence linked to a case, as far as the requirements care: where it belongs and whether it is clean. */
export interface EvidenceFact {
  /** The id of the link (the one `detach` takes). */
  readonly id: string;
  readonly category: EvidenceCategory;
  readonly stage: EvidenceStage;
  /** Only a `clean` file counts: one in quarantine or a rejected one never satisfies a requirement. */
  readonly clean: boolean;
  /** The file still waits for its scan: a case cannot close with evidence nobody has judged. */
  readonly pending: boolean;
}
export interface IncidentEvidenceFacts {
  evidence(tenantId: string, incidentId: string): Promise<readonly EvidenceFact[]>;
}

/** An order of the workshop linked to the case as a corrective repair (INC-COSTS owns the link). */
export interface LinkedRepairOrder {
  readonly orderId: string;
  readonly status: 'scheduled' | 'assigned' | 'in_progress' | 'completed' | 'closed' | 'cancelled';
  readonly version: number;
  /** The order has costs registered. */
  readonly hasCosts: boolean;
}
/** `available: false` while INC-COSTS is not connected: every requirement that depends on it fails closed. */
export type RepairsSnapshot =
  | { readonly available: true; readonly orders: readonly LinkedRepairOrder[] }
  | { readonly available: false };
export interface IncidentRepairs {
  /**
   * `tx` joins the transaction of the command that decides on the orders (the store's, or nothing in
   * memory). A real implementation must THROW when the links or an order cannot be read: answering
   * `available: false` is only for the fail-closed variant, because `requirements.ts` treats an
   * unavailable snapshot as "no linked orders" on routes that never went through `repair`.
   */
  linkedOrders(tenantId: string, incidentId: string, tx?: unknown): Promise<RepairsSnapshot>;
}

export type CostPresence =
  | {
      readonly available: true;
      /** Any cost line or recovery of the case itself. */
      readonly hasCosts: boolean;
      /** At least one own line of the `repair` category. */
      readonly hasRepairLine: boolean;
    }
  | { readonly available: false };
export interface IncidentCostPresence {
  presence(tenantId: string, incidentId: string): Promise<CostPresence>;
}

/** An exact amount in the minor unit of its currency (digits, optionally negative for net recoveries). */
export interface Money {
  readonly currency: string;
  readonly amountMinor: string;
}
export type CostTotals =
  | { readonly available: true; readonly companyBorne: readonly Money[] }
  | { readonly available: false };
/** What the company bears by currency: repairs plus expenses minus recoveries (ADR-0014). */
export interface IncidentCostTotals {
  /** `tx` joins the transaction of the command that decides on the totals (the store's, or nothing in memory). */
  totals(tenantId: string, incidentId: string, tx?: unknown): Promise<CostTotals>;
}

export interface CostThreshold {
  readonly amountMinor: string;
  readonly currency: string;
}
export type ReportPhotoMode = 'photo_or_justification' | 'photo_required';
/** Company settings the workflow reads. A read that fails is an error (500), never a default. */
export interface WorkflowSettings {
  reportPhoto(tenantId: string): Promise<ReportPhotoMode>;
  closeCostThreshold(tenantId: string): Promise<CostThreshold | null>;
}

/** Members of the tenant, to check a responsible. `null` is an unknown or foreign member. */
export interface ResponsibleDirectory {
  permissionsOf(tenantId: string, memberId: string): Promise<readonly string[] | null>;
}

/**
 * Other causes that keep a vehicle out of service (SPECS §5.3, D11): an open workshop order of the
 * vehicle, or another case that is not over and says the vehicle cannot operate. A read that fails is
 * an error (500), never "free".
 */
export interface IncidentVehicleBlocks {
  blocked(tenantId: string, vehicleId: string, exceptIncidentId: string): Promise<boolean>;
}

export interface WorkflowPorts {
  readonly references: Pick<IncidentReferences, 'policyRevisions' | 'timeZone'>;
  readonly evidence: IncidentEvidenceFacts;
  readonly settings: WorkflowSettings;
  readonly members: ResponsibleDirectory;
  readonly repairs: IncidentRepairs;
  readonly costs: IncidentCostPresence;
  readonly totals: IncidentCostTotals;
  readonly blocks: IncidentVehicleBlocks;
  /** Where the snapshot of a closed cycle is kept, in the transaction of the closure. */
  readonly closures: IncidentClosures;
  /** INC-COSTS keeps its own snapshot of the closed cycle in the same transaction. */
  readonly closureCosts: IncidentClosureCosts;
}
