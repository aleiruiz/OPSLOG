import type { ApiError } from '@opslog/contracts';
import { BFF_COVERAGE_TYPES, BFF_POLICY_STATUSES } from '@opslog/contracts';
import {
  EXPIRING_WINDOW_DAYS,
  MAX_EXPIRY_DATE,
  MIN_DATE,
  NOTES,
  OPAQUE_ID,
  REFERENCE_NUMBER,
  isDateBetween,
  normalizeReference,
  normalizeText,
  todayOf,
} from '../documents/rules';
import { demoPolicies } from '../insurance/fixtures';
import { CURRENCY, INSURER, MAX_BASIS_POINTS, MAX_DEDUCTIBLE_MINOR } from '../insurance/rules';
import type {
  CoverageType,
  Deductible,
  InsuranceListQuery,
  InsurancePolicy,
  InsurancePolicyInput,
  InsurancePolicyPatch,
  InsurancePolicyRenewal,
  InsurancePolicyRevision,
  InsurancePort,
  Page,
  Result,
} from './types';

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

const NOW = '2026-10-06T12:00:00.000Z';
const DAY_MS = 86_400_000;
let correlation = 0;

function failure(
  status: ApiError['status'],
  code: string,
  message: string,
  field?: string,
): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      correlationId: `corr-mock-policy-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');
const notFound = () => failure(404, 'not_found', 'Resource not found');
const forbidden = () => failure(403, 'forbidden', 'Permission denied');
const invalidVehicle = () => failure(422, 'invalid_vehicle', 'Unprocessable request', 'vehicle_id');
const conflict = (code: 'stale_version' | 'immutable') => failure(409, code, 'Conflict');

const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

const onlyKeys = (fields: Readonly<Record<string, unknown>>, allowed: readonly string[]) =>
  Object.keys(fields).every((key) => allowed.includes(key));

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function parseDeductible(value: unknown): Deductible | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Readonly<Record<string, unknown>>;
  if (fields['kind'] === 'amount') {
    const { amountMinor, currency } = fields;
    return onlyKeys(fields, ['kind', 'amountMinor', 'currency']) &&
      isInt(amountMinor, 1, MAX_DEDUCTIBLE_MINOR) &&
      typeof currency === 'string' &&
      CURRENCY.test(currency)
      ? { kind: 'amount', amountMinor, currency }
      : null;
  }
  if (fields['kind'] === 'percent') {
    const { basisPoints } = fields;
    return onlyKeys(fields, ['kind', 'basisPoints']) && isInt(basisPoints, 1, MAX_BASIS_POINTS)
      ? { kind: 'percent', basisPoints }
      : null;
  }
  return null;
}

interface Period {
  readonly startsOn: string;
  readonly endsOn: string;
}

function parsePeriod(fields: Readonly<Record<string, unknown>>): Period | null {
  const { startsOn, endsOn } = fields;
  return typeof startsOn === 'string' &&
    typeof endsOn === 'string' &&
    isDateBetween(startsOn, MIN_DATE, MAX_EXPIRY_DATE) &&
    isDateBetween(endsOn, MIN_DATE, MAX_EXPIRY_DATE) &&
    endsOn >= startsOn
    ? { startsOn, endsOn }
    : null;
}

const parseNumber = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = normalizeReference(value);
  return REFERENCE_NUMBER.test(text) ? text : null;
};
const isCoverage = (value: unknown): value is CoverageType =>
  typeof value === 'string' && (BFF_COVERAGE_TYPES as readonly string[]).includes(value);

interface RevisionData extends Period {
  readonly policyNumber: string;
  readonly coverageType: CoverageType;
  readonly deductible: Deductible | null;
}
interface StoredRevision extends RevisionData {
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
}

export function createMockInsuranceStore(
  seed: readonly InsurancePolicy[] = demoPolicies(),
  options: {
    now?: () => Date;
    /** Whether the vehicle exists in the company and is not archived (the backend refuses any other). */
    isLiveVehicle?: (vehicleId: string) => boolean;
    /** Whether the signed-in role holds `view_costs`. */
    canViewCosts?: () => boolean;
    actorId?: () => string;
  } = {},
): MockInsuranceStore {
  const now = options.now ?? (() => new Date(NOW));
  const isLiveVehicle = options.isLiveVehicle ?? (() => true);
  const canViewCosts = options.canViewCosts ?? (() => true);
  const actorId = options.actorId ?? (() => 'user-admin');
  const today = () => todayOf(now());

  /** What the server derives at read time, with the deductible hidden from a role without `view_costs`. */
  const view = (policy: InsurancePolicy): InsurancePolicy => {
    const days = Math.round(
      (Date.parse(`${policy.endsOn}T00:00:00.000Z`) - Date.parse(`${today()}T00:00:00.000Z`)) /
        DAY_MS,
    );
    return {
      ...policy,
      status: days < 0 ? 'expired' : days <= EXPIRING_WINDOW_DAYS ? 'expiring' : 'valid',
      daysToExpiry: days,
      covering: policy.startsOn <= today() && today() <= policy.endsOn,
      hasDeductible: policy.deductible !== null,
      deductible: canViewCosts() ? policy.deductible : null,
    };
  };

  let rows: InsurancePolicy[] = seed.map((policy) => ({ ...policy }));
  let sequence = rows.length;
  // Earlier revisions of a seeded policy are synthetic: one year apart, oldest first.
  const revisions = new Map<string, StoredRevision[]>(
    rows.map((policy) => [
      policy.id,
      Array.from({ length: policy.revision }, (_, index): StoredRevision => {
        const revision = index + 1;
        const back = (policy.revision - revision) * 365 * DAY_MS;
        const move = (day: string) =>
          new Date(Date.parse(`${day}T00:00:00.000Z`) - back).toISOString().slice(0, 10);
        return {
          revision,
          policyNumber: policy.policyNumber,
          coverageType: policy.coverageType,
          startsOn: move(policy.startsOn),
          endsOn: move(policy.endsOn),
          deductible: policy.deductible,
          actorId: 'user-admin',
          at: policy.createdAt,
        };
      }),
    ]),
  );

  const index = (id: string) => rows.findIndex((policy) => policy.id === id);
  const replace = (id: string, next: InsurancePolicy) => {
    rows = rows.map((policy) => (policy.id === id ? next : policy));
    return next;
  };
  const bump = (policy: InsurancePolicy, change: Partial<InsurancePolicy>): InsurancePolicy => ({
    ...policy,
    ...change,
    version: policy.version + 1,
    updatedAt: NOW,
  });

  const port: InsurancePort = {
    list: async (query: InsuranceListQuery = {}) => {
      const limit = query.limit ?? 25;
      const offset =
        query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
      if (
        ![25, 50, 100].includes(limit) ||
        !Number.isSafeInteger(offset) ||
        (query.vehicleId !== undefined && !OPAQUE_ID.test(query.vehicleId)) ||
        (query.coverageType !== undefined && !isCoverage(query.coverageType)) ||
        (query.status !== undefined && !BFF_POLICY_STATUSES.includes(query.status)) ||
        (query.coversOn !== undefined &&
          !isDateBetween(query.coversOn, MIN_DATE, MAX_EXPIRY_DATE)) ||
        (query.includeArchived !== undefined && !['true', 'false'].includes(query.includeArchived))
      )
        return badRequest();
      const matches = rows
        .map(view)
        .filter(
          (policy) =>
            (query.includeArchived === 'true' || policy.archivedAt === null) &&
            (query.vehicleId === undefined || policy.vehicleId === query.vehicleId) &&
            (query.coverageType === undefined || policy.coverageType === query.coverageType) &&
            (query.status === undefined || policy.status === query.status) &&
            (query.coversOn === undefined ||
              (policy.startsOn <= query.coversOn && query.coversOn <= policy.endsOn)),
        )
        .sort((a, b) =>
          a.endsOn < b.endsOn ? -1 : a.endsOn > b.endsOn ? 1 : a.id < b.id ? -1 : 1,
        );
      const next = offset + limit;
      const page: Page<InsurancePolicy> = {
        items: matches.slice(offset, next),
        nextCursor: next < matches.length ? `mock:${next}` : null,
        total: matches.length,
        sort: { field: 'endsOn', direction: 'asc' },
      };
      return ok(page);
    },
    get: async (id) => {
      const found = rows[index(id)];
      return found ? ok(view(found)) : notFound();
    },
    create: async (input: InsurancePolicyInput) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      // The permission is decided before the value is looked at: without it a bad value is never a 400.
      if (Object.hasOwn(fields, 'deductible') && !canViewCosts()) return forbidden();
      const { vehicleId, insurer, coverageNotes, coverageType, deductible } = fields;
      const cleanInsurer = typeof insurer === 'string' ? normalizeText(insurer) : null;
      const notes =
        coverageNotes === undefined || coverageNotes === null
          ? null
          : typeof coverageNotes === 'string'
            ? coverageNotes.trim()
            : undefined;
      const period = parsePeriod(fields);
      const policyNumber = parseNumber(fields['policyNumber']);
      const parsedDeductible =
        deductible === undefined || deductible === null ? null : parseDeductible(deductible);
      if (
        !onlyKeys(fields, [
          'vehicleId',
          'insurer',
          'coverageNotes',
          'policyNumber',
          'coverageType',
          'startsOn',
          'endsOn',
          'deductible',
        ]) ||
        typeof vehicleId !== 'string' ||
        !OPAQUE_ID.test(vehicleId) ||
        cleanInsurer === null ||
        !INSURER.test(cleanInsurer) ||
        notes === undefined ||
        (notes !== null && !NOTES.test(notes)) ||
        policyNumber === null ||
        !isCoverage(coverageType) ||
        period === null ||
        (deductible !== undefined && deductible !== null && parsedDeductible === null)
      )
        return badRequest();
      if (!isLiveVehicle(vehicleId)) return invalidVehicle();
      sequence += 1;
      const id = `pol-nueva-${sequence}`;
      const policy: InsurancePolicy = {
        id,
        vehicleId,
        insurer: cleanInsurer,
        coverageNotes: notes,
        revision: 1,
        policyNumber,
        coverageType,
        ...period,
        status: 'valid',
        daysToExpiry: 0,
        covering: false,
        hasDeductible: false,
        deductible: parsedDeductible,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      };
      rows = [...rows, policy];
      revisions.set(id, [
        {
          revision: 1,
          policyNumber,
          coverageType,
          ...period,
          deductible: parsedDeductible,
          actorId: actorId(),
          at: NOW,
        },
      ]);
      return ok(view(policy));
    },
    update: async (id, patch: InsurancePolicyPatch) => {
      const { version, ...rest } = patch as unknown as Record<string, unknown>;
      const current = rows[index(id)];
      if (!current) return notFound();
      const insurer = rest['insurer'];
      const rawNotes = rest['coverageNotes'];
      const cleanInsurer = typeof insurer === 'string' ? normalizeText(insurer) : undefined;
      const notes = typeof rawNotes === 'string' ? rawNotes.trim() : rawNotes;
      if (
        !validVersion(version) ||
        Object.keys(rest).length === 0 ||
        !onlyKeys(rest, ['insurer', 'coverageNotes']) ||
        (insurer !== undefined && (cleanInsurer === undefined || !INSURER.test(cleanInsurer))) ||
        (rawNotes !== undefined &&
          rawNotes !== null &&
          (typeof notes !== 'string' || !NOTES.test(notes)))
      )
        return badRequest();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      return ok(
        view(
          replace(
            id,
            bump(current, {
              ...(cleanInsurer === undefined ? {} : { insurer: cleanInsurer }),
              ...(notes === undefined ? {} : { coverageNotes: notes as string | null }),
            }),
          ),
        ),
      );
    },
    renew: async (id, renewal: InsurancePolicyRenewal) => {
      const { version, ...rest } = renewal as unknown as Record<string, unknown>;
      const current = rows[index(id)];
      if (!current) return notFound();
      if (Object.hasOwn(rest, 'deductible') && !canViewCosts()) return forbidden();
      const period = parsePeriod(rest);
      const policyNumber = Object.hasOwn(rest, 'policyNumber')
        ? parseNumber(rest['policyNumber'])
        : current.policyNumber;
      const coverageType = Object.hasOwn(rest, 'coverageType')
        ? rest['coverageType']
        : current.coverageType;
      const deductible = !Object.hasOwn(rest, 'deductible')
        ? current.deductible
        : rest['deductible'] === null
          ? null
          : parseDeductible(rest['deductible']);
      if (
        !validVersion(version) ||
        !onlyKeys(rest, ['policyNumber', 'coverageType', 'startsOn', 'endsOn', 'deductible']) ||
        period === null ||
        policyNumber === null ||
        !isCoverage(coverageType) ||
        (Object.hasOwn(rest, 'deductible') && rest['deductible'] !== null && deductible === null)
      )
        return badRequest();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      if (!isLiveVehicle(current.vehicleId)) return invalidVehicle();
      const revision = current.revision + 1;
      revisions.set(id, [
        ...(revisions.get(id) ?? []),
        {
          revision,
          policyNumber,
          coverageType,
          ...period,
          deductible,
          actorId: actorId(),
          at: NOW,
        },
      ]);
      return ok(
        view(
          replace(
            id,
            bump(current, { revision, policyNumber, coverageType, ...period, deductible }),
          ),
        ),
      );
    },
    archive: async (id, version) => {
      const current = rows[index(id)];
      if (!current) return notFound();
      if (!validVersion(version)) return badRequest();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      return ok(view(replace(id, bump(current, { archivedAt: NOW }))));
    },
    history: async (id, query = {}) => {
      const limit = query.limit ?? 25;
      const offset =
        query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
      const current = rows[index(id)];
      if (!current) return notFound();
      if (![25, 50, 100].includes(limit) || !Number.isSafeInteger(offset)) return badRequest();
      const all: InsurancePolicyRevision[] = [...(revisions.get(id) ?? [])]
        .sort((a, b) => b.revision - a.revision)
        .map((entry) => ({
          revision: entry.revision,
          policyNumber: entry.policyNumber,
          coverageType: entry.coverageType,
          startsOn: entry.startsOn,
          endsOn: entry.endsOn,
          status:
            entry.revision === current.revision
              ? view({ ...current, endsOn: entry.endsOn }).status
              : ('replaced' as const),
          hasDeductible: entry.deductible !== null,
          deductible: canViewCosts() ? entry.deductible : null,
          actorId: entry.actorId,
          at: entry.at,
        }));
      const next = offset + limit;
      return ok({
        items: all.slice(offset, next),
        nextCursor: next < all.length ? `mock:${next}` : null,
        total: all.length,
        sort: { field: 'revision', direction: 'desc' as const },
      } satisfies Page<InsurancePolicyRevision>);
    },
  };

  return {
    port,
    changeExternally: (id, change) => {
      const current = rows[index(id)];
      if (current) replace(id, bump(current, change));
    },
    archiveExternally: (id) => {
      const current = rows[index(id)];
      if (current) replace(id, bump(current, { archivedAt: NOW }));
    },
    snapshot: () => rows.map((policy) => ({ ...policy })),
  };
}
