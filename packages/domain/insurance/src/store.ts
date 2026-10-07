import { matchesExpiry } from '../../documents/src/index.js';
import {
  type PolicyFilter,
  type PolicyRevisionSlice,
  type PolicySlice,
  type PolicyStore,
  type PolicyWindow,
} from './ports.js';
import { coversOn } from './rules.js';
import { type Policy, type PolicyRevision } from './types.js';

/** Plain code-unit order, so every store lists in the same order. */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemoryPolicyStore implements PolicyStore {
  private readonly policies = new Map<string, Policy>();
  private readonly revisionRows: PolicyRevision[] = [];

  public async insert(policy: Policy, revision: PolicyRevision): Promise<void> {
    this.policies.set(storeKey(policy.tenantId, policy.id), structuredClone(policy));
    this.revisionRows.push(structuredClone(revision));
  }

  public async find(tenantId: string, id: string): Promise<Policy | null> {
    const found = this.policies.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async list(
    tenantId: string,
    filter: PolicyFilter,
    window: PolicyWindow,
  ): Promise<PolicySlice> {
    const matching = [...this.policies.values()]
      .filter(
        (policy) =>
          policy.tenantId === tenantId &&
          (filter.includeArchived || policy.archivedAt === null) &&
          (filter.vehicleId === undefined || policy.vehicleId === filter.vehicleId) &&
          (filter.coverageType === undefined || policy.coverageType === filter.coverageType) &&
          (filter.expiry === undefined || matchesExpiry(policy.endsOn, filter.expiry)) &&
          (filter.coversOn === undefined || coversOn(policy, filter.coversOn)),
      )
      .sort((a, b) => compareKeys(a.endsOn, b.endsOn) || compareKeys(a.id, b.id));
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((policy) => structuredClone(policy)),
      total: matching.length,
    };
  }

  public async replace(
    next: Policy,
    expectedVersion: number,
    revision?: PolicyRevision,
  ): Promise<boolean> {
    const key = storeKey(next.tenantId, next.id);
    const current = this.policies.get(key);
    if (current?.version !== expectedVersion) return false;
    this.policies.set(key, structuredClone(next));
    if (revision) this.revisionRows.push(structuredClone(revision));
    return true;
  }

  public async revisions(
    tenantId: string,
    policyId: string,
    window: PolicyWindow,
  ): Promise<PolicyRevisionSlice> {
    const all = this.revisionRows
      .filter((row) => row.tenantId === tenantId && row.policyId === policyId)
      .sort((a, b) => b.revision - a.revision);
    return {
      items: all
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: all.length,
    };
  }
}
