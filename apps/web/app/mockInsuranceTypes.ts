import type { InsurancePolicy, InsurancePort } from './types';

/**
 * In-memory insurance policies with the semantics of the real backend (`packages/domain/insurance`): optimistic
 * versions (409 `stale_version`), read-only archived policies (409 `immutable`), a status derived from the end date and
 * the server clock, immutable revisions appended by renewals, a live vehicle of the company checked on create and
 * renew (a uniform 422 `invalid_vehicle`), and the deductible gated by `view_costs`: hidden on every read without it,
 * and any request that mentions it a 403 (decided before the value is looked at). Permissions of the operations
 * themselves are enforced by the caller (`mockApi`).
 */
export interface MockInsuranceStore {
  readonly port: InsurancePort;
  /** Another actor edits the policy on the server: its version moves on, so the caller's copy is stale. */
  changeExternally(id: string, change: Partial<Pick<InsurancePolicy, 'insurer'>>): void;
  /** Another actor archives the policy on the server. */
  archiveExternally(id: string): void;
  /** Policies as stored (the deductible included), for assertions. */
  snapshot(): readonly InsurancePolicy[];
}
