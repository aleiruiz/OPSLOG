import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  dateOf,
  expiryFilterOf,
  expiryOf,
  revisionStatus,
  type Expiry,
  type RevisionStatus,
} from '../../documents/src/index.js';
import { PolicyError } from './errors.js';
import {
  type PolicyFilter,
  type PolicySlice,
  type PolicyStore,
  type PolicyVehicleGate,
  type PolicyWindow,
} from './ports.js';
import {
  applyArchive,
  applyPatch,
  applyRenewal,
  coversOn,
  newPolicy,
  revisionOf,
} from './rules.js';
import { isCoverageType, isPolicyStatus, type Policy, type PolicyRevision } from './types.js';
import {
  guardId,
  guardVersion,
  invalid,
  isInteger,
  normalizeDate,
  parseNewPolicy,
  parsePolicyPatch,
  parseRenewal,
} from './validation.js';

export interface PolicyListQuery {
  readonly vehicleId?: unknown;
  readonly coverageType?: unknown;
  readonly status?: unknown;
  readonly coversOn?: unknown;
  readonly includeArchived?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface PolicyHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface PolicyServiceOptions {
  /**
   * Checks that the vehicle of a new policy, or of a renewal, is a live vehicle of the tenant.
   * Without it the vehicle is not checked (only for tests of this package); the platform
   * composition always supplies it. The check is best effort (check, then act): a vehicle
   * archived concurrently can still receive the policy, which is the same as the policy having
   * been created just before the archive (archiving a vehicle does not cascade).
   */
  readonly vehicles?: PolicyVehicleGate;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function windowOf(query: PolicyHistoryQuery): PolicyWindow {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
  return { limit, offset };
}

/**
 * Policy use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class enforces the domain rules. The tenant is always an
 * argument taken from the server-side session, never part of the input being validated.
 */
export class PolicyService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly vehicles: PolicyVehicleGate | undefined;

  public constructor(
    private readonly store: PolicyStore,
    options: PolicyServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.vehicles = options.vehicles;
  }

  /** The policy of this tenant, or `not_found` (also for ids of other tenants). */
  private async load(tenantId: string, id: unknown): Promise<Policy> {
    const policy = await this.store.find(guardId(tenantId), guardId(id));
    if (policy?.tenantId !== tenantId) throw new PolicyError('not_found');
    return policy;
  }

  /** Writes `next`; a lost race reads as `stale_version` (or `not_found` when the row is gone). */
  private async commit(
    next: Policy,
    expectedVersion: number,
    revision?: PolicyRevision,
  ): Promise<Policy> {
    if (await this.store.replace(next, expectedVersion, revision)) return next;
    const current = await this.store.find(next.tenantId, next.id);
    throw new PolicyError(current ? 'stale_version' : 'not_found');
  }

  public async create(tenantId: string, actorId: string, input: unknown): Promise<Policy> {
    guardId(tenantId);
    guardId(actorId);
    const now = this.now();
    const data = parseNewPolicy(input);
    await this.vehicles?.assertLive(tenantId, data.vehicleId);
    const policy = newPolicy(tenantId, this.newId(), data, now);
    await this.store.insert(policy, revisionOf(policy, actorId, now));
    return policy;
  }

  public get(tenantId: string, id: unknown): Promise<Policy> {
    return this.load(tenantId, id);
  }

  public async list(tenantId: string, query: PolicyListQuery = {}): Promise<PolicySlice> {
    guardId(tenantId);
    const window = windowOf(query);
    if (query.coverageType !== undefined && !isCoverageType(query.coverageType)) return invalid();
    if (query.status !== undefined && !isPolicyStatus(query.status)) return invalid();
    if (query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean')
      return invalid();
    const filter: PolicyFilter = {
      includeArchived: query.includeArchived ?? false,
      ...(query.vehicleId === undefined ? {} : { vehicleId: guardId(query.vehicleId) }),
      ...(query.coverageType === undefined ? {} : { coverageType: query.coverageType }),
      ...(query.coversOn === undefined ? {} : { coversOn: normalizeDate(query.coversOn) }),
      ...(query.status === undefined
        ? {}
        : { expiry: expiryFilterOf(query.status, dateOf(this.now())) }),
    };
    return this.store.list(tenantId, filter, window);
  }

  public async update(
    tenantId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Policy> {
    const now = this.now();
    const patch = parsePolicyPatch(input);
    const version = guardVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyPatch(current, patch, version, now), version);
  }

  /** BR-025 / US-012: appends a revision with the new period and keeps the previous ones. */
  public async renew(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Policy> {
    guardId(actorId);
    const now = this.now();
    const version = guardVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    const data = parseRenewal(input, current);
    // Cheap checks first: a stale or archived policy never reaches the vehicle module.
    applyRenewal(current, data, version, now);
    await this.vehicles?.assertLive(tenantId, current.vehicleId);
    const next = applyRenewal(current, data, version, now);
    return this.commit(next, version, revisionOf(next, actorId, now));
  }

  public async archive(tenantId: string, id: unknown, expectedVersion: unknown): Promise<Policy> {
    const version = guardVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyArchive(current, version, this.now()), version);
  }

  /** Revisions, newest first, each with its status as of today. */
  public async history(
    tenantId: string,
    id: unknown,
    query: PolicyHistoryQuery = {},
  ): Promise<{
    readonly items: readonly (PolicyRevision & { readonly status: RevisionStatus })[];
    readonly total: number;
  }> {
    const policy = await this.load(tenantId, id);
    const window = windowOf(query);
    const slice = await this.store.revisions(tenantId, policy.id, window);
    const today = dateOf(this.now());
    // The current revision comes from the rows themselves (newest first, so the first row of the
    // first page), not from a second read of the policy that a concurrent renewal could outdate.
    // Later pages only hold older rows, which are all replaced.
    const current =
      window.offset === 0 ? (slice.items[0]?.revision ?? 0) : Number.POSITIVE_INFINITY;
    return {
      total: slice.total,
      items: slice.items.map((row) => ({
        ...row,
        status: revisionStatus({ revision: row.revision, expiresOn: row.endsOn }, current, today),
      })),
    };
  }

  /** Derived expiry status as of today (UTC date of the service clock). */
  public expiry(policy: Pick<Policy, 'endsOn'>): Expiry {
    return expiryOf(policy.endsOn, dateOf(this.now()));
  }

  /** Whether the policy covers today (UTC date of the service clock). */
  public covering(policy: Pick<Policy, 'startsOn' | 'endsOn'>): boolean {
    return coversOn(policy, dateOf(this.now()));
  }
}
