import { BFF_POLICY_STATUSES } from '@opslog/contracts';
import {
  EXPIRING_WINDOW_DAYS,
  MAX_EXPIRY_DATE,
  MIN_DATE,
  OPAQUE_ID,
  isDateBetween,
} from '../documents/rules';
import { DAY_MS, isCoverage, type StoredRevision } from './mockInsuranceSupport';
import type { InsuranceListQuery, InsurancePolicy, InsurancePolicyRevision } from './types';

/** What the server derives at read time, with the deductible hidden from a role without `view_costs`. */
export const deriveView = (
  policy: InsurancePolicy,
  today: string,
  canViewCosts: boolean,
): InsurancePolicy => {
  const days = Math.round(
    (Date.parse(`${policy.endsOn}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS,
  );
  return {
    ...policy,
    status: days < 0 ? 'expired' : days <= EXPIRING_WINDOW_DAYS ? 'expiring' : 'valid',
    daysToExpiry: days,
    covering: policy.startsOn <= today && today <= policy.endsOn,
    hasDeductible: policy.deductible !== null,
    deductible: canViewCosts ? policy.deductible : null,
  };
};

/** Whether the list query (and its decoded page window) is well-formed. */
export const isValidListQuery = (query: InsuranceListQuery, limit: number, offset: number) =>
  [25, 50, 100].includes(limit) &&
  Number.isSafeInteger(offset) &&
  !(query.vehicleId !== undefined && !OPAQUE_ID.test(query.vehicleId)) &&
  !(query.coverageType !== undefined && !isCoverage(query.coverageType)) &&
  !(query.status !== undefined && !BFF_POLICY_STATUSES.includes(query.status)) &&
  !(query.coversOn !== undefined && !isDateBetween(query.coversOn, MIN_DATE, MAX_EXPIRY_DATE)) &&
  !(query.includeArchived !== undefined && !['true', 'false'].includes(query.includeArchived));

export const matchesListQuery = (policy: InsurancePolicy, query: InsuranceListQuery) =>
  (query.includeArchived === 'true' || policy.archivedAt === null) &&
  (query.vehicleId === undefined || policy.vehicleId === query.vehicleId) &&
  (query.coverageType === undefined || policy.coverageType === query.coverageType) &&
  (query.status === undefined || policy.status === query.status) &&
  (query.coversOn === undefined ||
    (policy.startsOn <= query.coversOn && query.coversOn <= policy.endsOn));

/** Revisions of a policy, newest first, as the history port returns them. */
export const revisionViews = (
  stored: readonly StoredRevision[],
  current: InsurancePolicy,
  view: (policy: InsurancePolicy) => InsurancePolicy,
  canViewCosts: boolean,
): InsurancePolicyRevision[] =>
  [...stored]
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
      deductible: canViewCosts ? entry.deductible : null,
      actorId: entry.actorId,
      at: entry.at,
    }));
