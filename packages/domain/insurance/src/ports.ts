import { type ExpiryFilter } from '../../documents/src/index.js';
import { type CoverageType, type Policy, type PolicyRevision } from './types.js';

export interface PolicyFilter {
  readonly vehicleId?: string;
  readonly coverageType?: CoverageType;
  /** Derived status as a range of `endsOn`. */
  readonly expiry?: ExpiryFilter;
  /** Policies whose period contains this day (`startsOn <= day <= endsOn`). */
  readonly coversOn?: string;
  readonly includeArchived: boolean;
}

export interface PolicyWindow {
  readonly limit: number;
  readonly offset: number;
}

export interface PolicySlice {
  readonly items: readonly Policy[];
  /** Number of policies matching the filter, not only the window. */
  readonly total: number;
}

export interface PolicyRevisionSlice {
  readonly items: readonly PolicyRevision[];
  readonly total: number;
}

/**
 * Persistence port. Every method is tenant-scoped: a policy of another tenant is simply absent.
 * `insert` and `replace` also write the revision snapshot, atomically with the policy.
 */
export interface PolicyStore {
  insert(policy: Policy, revision: PolicyRevision): Promise<void>;
  find(tenantId: string, id: string): Promise<Policy | null>;
  /** Ordered by end date, then id. */
  list(tenantId: string, filter: PolicyFilter, window: PolicyWindow): Promise<PolicySlice>;
  /** Atomic compare-and-set: writes `next` (and the optional new revision) only while the stored version is `expectedVersion`; false otherwise. */
  replace(next: Policy, expectedVersion: number, revision?: PolicyRevision): Promise<boolean>;
  /** Newest revision first. */
  revisions(tenantId: string, policyId: string, window: PolicyWindow): Promise<PolicyRevisionSlice>;
}

/**
 * Port to the vehicle module. `assertLive` resolves only when `vehicleId` is a live (not
 * archived) vehicle of `tenantId`; unknown, foreign and archived vehicles are indistinguishable:
 * it throws `PolicyError('invalid_vehicle', 'vehicle_id')`. Other failures propagate unchanged.
 */
export interface PolicyVehicleGate {
  assertLive(tenantId: string, vehicleId: string): Promise<void>;
}
