import { NOTES, OPAQUE_ID, normalizeText, todayOf } from '../documents/rules';
import { demoPolicies } from '../insurance/fixtures';
import { INSURER } from '../insurance/rules';
import {
  NOW,
  badRequest,
  conflict,
  forbidden,
  invalidVehicle,
  isCoverage,
  notFound,
  ok,
  onlyKeys,
  parseDeductible,
  parseNumber,
  parsePeriod,
  seedRevisions,
  validVersion,
} from './mockInsuranceSupport';
import {
  deriveView,
  isValidListQuery,
  matchesListQuery,
  revisionViews,
} from './mockInsuranceViews';
import type { MockInsuranceStore } from './mockInsuranceTypes';
import type {
  InsuranceListQuery,
  InsurancePolicy,
  InsurancePolicyInput,
  InsurancePolicyPatch,
  InsurancePolicyRenewal,
  InsurancePolicyRevision,
  InsurancePort,
  Page,
} from './types';

export type { MockInsuranceStore };

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
  const view = (policy: InsurancePolicy): InsurancePolicy =>
    deriveView(policy, today(), canViewCosts());

  let rows: InsurancePolicy[] = seed.map((policy) => ({ ...policy }));
  let sequence = rows.length;
  // Earlier revisions of a seeded policy are synthetic: one year apart, oldest first.
  const revisions = seedRevisions(rows);

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
      if (!isValidListQuery(query, limit, offset)) return badRequest();
      const matches = rows
        .map(view)
        .filter((policy) => matchesListQuery(policy, query))
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
      const all = revisionViews(revisions.get(id) ?? [], current, view, canViewCosts());
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
