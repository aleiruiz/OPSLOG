import type { IncidentClosureCosts } from './closures.js';
import type {
  CostPresence,
  CostTotals,
  IncidentCostPresence,
  IncidentCostTotals,
  IncidentRepairs,
  RepairsSnapshot,
} from './ports.js';

/**
 * Ports of INC-COSTS while it does not exist: they answer "not available", so nobody reaches
 * `repair`, cancels or closes on the strength of costs nobody can read. With a D20 threshold the
 * totals call for an approval (ADR-0014).
 */
export const FAIL_CLOSED_REPAIRS: IncidentRepairs = {
  linkedOrders: async (): Promise<RepairsSnapshot> => ({ available: false }),
};
export const FAIL_CLOSED_COSTS: IncidentCostPresence = {
  presence: async (): Promise<CostPresence> => ({ available: false }),
};
export const FAIL_CLOSED_TOTALS: IncidentCostTotals = {
  totals: async (): Promise<CostTotals> => ({ available: false }),
};

/**
 * Without INC-COSTS no cost exists, so there is nothing to snapshot with the closure. The risk of
 * closing without reading costs is covered by `FAIL_CLOSED_TOTALS`: with a D20 threshold, the closure
 * asks for an approval.
 */
export const NO_CLOSURE_COSTS: IncidentClosureCosts = {
  snapshot: async (): Promise<void> => {},
  recordApproval: async (): Promise<void> => {},
  approvalStale: async (): Promise<boolean> => false,
};
