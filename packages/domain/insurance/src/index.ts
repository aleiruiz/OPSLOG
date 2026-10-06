import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIST_LIMIT,
  MAX_EXPIRY_DATE,
  MAX_LIST_LIMIT,
  MIN_DATE,
  addDays,
  dateOf,
  expiryFilterOf,
  expiryOf,
  isDocumentStatus,
  matchesExpiry,
  revisionStatus,
  requireOpaqueId,
  requireVersion,
  type DocumentStatus,
  type Expiry,
  type ExpiryFilter,
  type RevisionStatus,
} from '../../documents/src/index.js';

/**
 * Insurance policies of vehicles (FLT-DOCS slice 2; BRD §8.4, FR-090, FR-091, BR-009, BR-025,
 * US-012). The expiry rules are the ones of documents (same window, same inclusive last day, same
 * derived status), reused from `@opslog/domain-documents` rather than copied.
 */
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, addDays, dateOf, expiryOf };
export type { DocumentStatus as PolicyStatus, Expiry, ExpiryFilter, RevisionStatus };

export const POLICY_STATUSES = ['valid', 'expiring', 'expired'] as const;
export const isPolicyStatus = isDocumentStatus;

/** Built-in coverage kinds (BRD §8.4: free text plus a configurable checklist, deferred). */
export const COVERAGE_TYPES = [
  'mandatory_liability',
  'third_party',
  'comprehensive',
  'other',
] as const;
export type CoverageType = (typeof COVERAGE_TYPES)[number];
export const isCoverageType = (value: unknown): value is CoverageType =>
  typeof value === 'string' && (COVERAGE_TYPES as readonly string[]).includes(value);

export type PolicyErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  | 'immutable'
  /** The vehicle is unknown, of another tenant or archived (all indistinguishable). */
  | 'invalid_vehicle';

/** Which input is invalid (`invalid_vehicle`). Never a value. */
export type PolicyConflictField = 'vehicle_id';

export class PolicyError extends Error {
  public constructor(
    public readonly code: PolicyErrorCode,
    public readonly field?: PolicyConflictField,
  ) {
    super(`Policy request rejected: ${code}`);
    this.name = 'PolicyError';
  }
}

/** Largest deductible amount in minor units (keeps every value an exact integer everywhere). */
export const MAX_DEDUCTIBLE_MINOR = 1_000_000_000_000;
/** 100 % in basis points. */
export const MAX_DEDUCTIBLE_BASIS_POINTS = 10_000;

/**
 * Deductible (BRD §8.4: amount or percentage plus currency). Money is an integer in the minor
 * unit of an ISO 4217 currency, never a float. It is financial data: gated by `view_costs`.
 */
export type Deductible =
  | { readonly kind: 'amount'; readonly amountMinor: number; readonly currency: string }
  | { readonly kind: 'percent'; readonly basisPoints: number };

/** The data that a renewal replaces; each version of it is an immutable revision (BR-025). */
export interface PolicyRevisionData {
  readonly policyNumber: string;
  readonly coverageType: CoverageType;
  /** `YYYY-MM-DD`: the first day of coverage, inclusive. */
  readonly startsOn: string;
  /** `YYYY-MM-DD`: the last day of coverage, inclusive. */
  readonly endsOn: string;
  readonly deductible: Deductible | null;
}

export interface PolicyRevision extends PolicyRevisionData {
  readonly tenantId: string;
  readonly policyId: string;
  /** 1 for the first record, +1 on every renewal. */
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
}

export interface Policy extends PolicyRevisionData {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes: string | null;
  /** Number of the current revision; the revision fields are a copy of that revision. */
  readonly revision: number;
  /** Optimistic concurrency token: starts at 1, +1 on every change. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

const invalid = (): never => {
  throw new PolicyError('invalid_input');
};

const INSURER = /^[^\u0000-\u001f\u007f]{2,80}$/u;
const NOTES = /^[^\u0000-\u001f\u007f]{1,500}$/u;
const POLICY_NUMBER = /^[A-Z0-9][A-Z0-9 ./-]{0,39}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    dateOf(parsed) !== value ||
    value < MIN_DATE ||
    value > MAX_EXPIRY_DATE
  )
    return invalid();
  return value;
}

export function normalizeInsurer(value: unknown): string {
  const text = trimmed(value).replace(/\s+/g, ' ');
  return INSURER.test(text) ? text : invalid();
}

function normalizeNotes(value: unknown): string {
  const text = trimmed(value);
  return NOTES.test(text) ? text : invalid();
}

export function normalizePolicyNumber(value: unknown): string {
  const text = trimmed(value).toUpperCase().replace(/\s+/g, ' ');
  return POLICY_NUMBER.test(text) ? text : invalid();
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const has = (fields: Fields, key: string): boolean => Object.hasOwn(fields, key);

/** Validates a deductible: exactly the keys of its kind, integers in range, an ISO currency. */
export function parseDeductible(value: unknown): Deductible {
  const kind = typeof value === 'object' && value !== null ? (value as Fields)['kind'] : undefined;
  if (kind === 'amount') {
    const fields = asFields(value, ['kind', 'amountMinor', 'currency']);
    const { amountMinor, currency } = fields;
    if (!isInteger(amountMinor, 1, MAX_DEDUCTIBLE_MINOR)) return invalid();
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) return invalid();
    return { kind: 'amount', amountMinor, currency };
  }
  if (kind === 'percent') {
    const fields = asFields(value, ['kind', 'basisPoints']);
    const { basisPoints } = fields;
    if (!isInteger(basisPoints, 1, MAX_DEDUCTIBLE_BASIS_POINTS)) return invalid();
    return { kind: 'percent', basisPoints };
  }
  return invalid();
}

/**
 * True when the input mentions the deductible at all, an explicit `null` included: the composition
 * then asks for `view_costs`. Only omitting the key is free (a renewal then carries it over), so a
 * caller without the permission can neither set, change nor erase the amount, and a malformed
 * value is a 403 before it is ever validated.
 */
export const writesDeductible = (input: unknown): boolean =>
  typeof input === 'object' &&
  input !== null &&
  !Array.isArray(input) &&
  Object.hasOwn(input, 'deductible');

export const REVISION_FIELDS = [
  'policyNumber',
  'coverageType',
  'startsOn',
  'endsOn',
  'deductible',
] as const;
export const CREATE_FIELDS = ['vehicleId', 'insurer', 'coverageNotes', ...REVISION_FIELDS] as const;
export const UPDATE_FIELDS = ['insurer', 'coverageNotes'] as const;
export const RENEW_FIELDS = REVISION_FIELDS;

function parsePeriod(fields: Fields): { startsOn: string; endsOn: string } {
  if (!has(fields, 'startsOn') || !has(fields, 'endsOn')) return invalid();
  const startsOn = normalizeDate(fields['startsOn']);
  const endsOn = normalizeDate(fields['endsOn']);
  return endsOn < startsOn ? invalid() : { startsOn, endsOn };
}

export interface NewPolicyData {
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes: string | null;
  readonly revision: PolicyRevisionData;
}

/** Validates a new policy. Unknown properties are rejected; a missing deductible means none. */
export function parseNewPolicy(input: unknown): NewPolicyData {
  const fields = asFields(input, CREATE_FIELDS);
  if (['vehicleId', 'insurer', 'policyNumber', 'coverageType'].some((key) => !has(fields, key)))
    return invalid();
  const coverageType = fields['coverageType'];
  if (!isCoverageType(coverageType)) return invalid();
  const notes = fields['coverageNotes'];
  const deductible = fields['deductible'];
  return {
    vehicleId: guardId(fields['vehicleId']),
    insurer: normalizeInsurer(fields['insurer']),
    coverageNotes: notes === undefined || notes === null ? null : normalizeNotes(notes),
    revision: {
      policyNumber: normalizePolicyNumber(fields['policyNumber']),
      coverageType,
      ...parsePeriod(fields),
      deductible:
        deductible === undefined || deductible === null ? null : parseDeductible(deductible),
    },
  };
}

/**
 * Validates a renewal. The new period is required; the policy number, the coverage type and the
 * deductible are carried over from the current revision when absent (an explicit `null`
 * deductible removes it). Carrying the deductible over lets a caller without `view_costs` renew
 * a policy without ever reading or erasing the amount.
 */
export function parseRenewal(input: unknown, current: PolicyRevisionData): PolicyRevisionData {
  const fields = asFields(input, RENEW_FIELDS);
  const coverageType = has(fields, 'coverageType') ? fields['coverageType'] : current.coverageType;
  if (!isCoverageType(coverageType)) return invalid();
  const deductible = fields['deductible'];
  return {
    policyNumber: has(fields, 'policyNumber')
      ? normalizePolicyNumber(fields['policyNumber'])
      : current.policyNumber,
    coverageType,
    ...parsePeriod(fields),
    deductible: !has(fields, 'deductible')
      ? current.deductible
      : deductible === null
        ? null
        : parseDeductible(deductible),
  };
}

export interface PolicyPatch {
  readonly insurer?: string;
  readonly coverageNotes?: string | null;
}

/** Only the insurer name and the notes are editable in place; at least one field is required. */
export function parsePolicyPatch(input: unknown): PolicyPatch {
  const fields = asFields(input, UPDATE_FIELDS);
  if (Object.keys(fields).length === 0) return invalid();
  return {
    ...(has(fields, 'insurer') ? { insurer: normalizeInsurer(fields['insurer']) } : {}),
    ...(has(fields, 'coverageNotes')
      ? {
          coverageNotes:
            fields['coverageNotes'] === null ? null : normalizeNotes(fields['coverageNotes']),
        }
      : {}),
  };
}

// ---- derived state ----------------------------------------------------------------------------

export { expiryFilterOf, matchesExpiry, revisionStatus };

/** Whether the policy covers `day` (`startsOn` and `endsOn` are both inclusive). BR-019 / FR-111. */
export const coversOn = (
  policy: Pick<PolicyRevisionData, 'startsOn' | 'endsOn'>,
  day: string,
): boolean => policy.startsOn <= day && day <= policy.endsOn;

// ---- pure state changes -----------------------------------------------------------------------

/** Archived policies are read-only. */
function assertEditable(policy: Policy): void {
  if (policy.archivedAt !== null) throw new PolicyError('immutable');
}

function assertVersion(policy: Policy, expectedVersion: number): void {
  if (policy.version !== expectedVersion) throw new PolicyError('stale_version');
}

const touched = (policy: Policy, now: Date): Pick<Policy, 'version' | 'updatedAt'> => ({
  version: policy.version + 1,
  updatedAt: now.toISOString(),
});

export const revisionDataOf = (policy: Policy): PolicyRevisionData => ({
  policyNumber: policy.policyNumber,
  coverageType: policy.coverageType,
  startsOn: policy.startsOn,
  endsOn: policy.endsOn,
  deductible: policy.deductible,
});

export function revisionOf(policy: Policy, actorId: string, now: Date): PolicyRevision {
  return {
    tenantId: policy.tenantId,
    policyId: policy.id,
    revision: policy.revision,
    ...revisionDataOf(policy),
    actorId,
    at: now.toISOString(),
  };
}

/** The first record of a policy: revision 1, version 1, not archived. */
export function newPolicy(tenantId: string, id: string, data: NewPolicyData, now: Date): Policy {
  return {
    id,
    tenantId,
    vehicleId: data.vehicleId,
    insurer: data.insurer,
    coverageNotes: data.coverageNotes,
    revision: 1,
    ...data.revision,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
  };
}

export function applyPatch(
  policy: Policy,
  patch: PolicyPatch,
  expectedVersion: number,
  now: Date,
): Policy {
  assertEditable(policy);
  assertVersion(policy, expectedVersion);
  return { ...policy, ...patch, ...touched(policy, now) };
}

/** BR-025 / US-012: a renewal is a new revision; the previous one stays in the history untouched. */
export function applyRenewal(
  policy: Policy,
  data: PolicyRevisionData,
  expectedVersion: number,
  now: Date,
): Policy {
  assertEditable(policy);
  assertVersion(policy, expectedVersion);
  return { ...policy, ...data, revision: policy.revision + 1, ...touched(policy, now) };
}

/** Soft delete (BR-009): the row and its revisions stay, hidden from default listings and read-only. */
export function applyArchive(policy: Policy, expectedVersion: number, now: Date): Policy {
  assertEditable(policy);
  assertVersion(policy, expectedVersion);
  return { ...policy, archivedAt: now.toISOString(), ...touched(policy, now) };
}

// ---- store port -------------------------------------------------------------------------------

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

// ---- service ----------------------------------------------------------------------------------

/**
 * Port to the vehicle module. `assertLive` resolves only when `vehicleId` is a live (not
 * archived) vehicle of `tenantId`; unknown, foreign and archived vehicles are indistinguishable:
 * it throws `PolicyError('invalid_vehicle', 'vehicle_id')`. Other failures propagate unchanged.
 */
export interface PolicyVehicleGate {
  assertLive(tenantId: string, vehicleId: string): Promise<void>;
}

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

/** The shared opaque-id and version guards raise `DocumentError`; policies raise their own error. */
function guardId(value: unknown): string {
  try {
    return requireOpaqueId(value);
  } catch {
    return invalid();
  }
}

function guardVersion(value: unknown): number {
  try {
    return requireVersion(value);
  } catch {
    return invalid();
  }
}
