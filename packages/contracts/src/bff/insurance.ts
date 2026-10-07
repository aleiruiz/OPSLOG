import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_COVERAGE_TYPES = [
  'mandatory_liability',
  'third_party',
  'comprehensive',
  'other',
] as const;
export type BffCoverageType = (typeof BFF_COVERAGE_TYPES)[number];

/** Derived from the end date and the server clock; never stored. */
export const BFF_POLICY_STATUSES = ['valid', 'expiring', 'expired'] as const;
export type BffPolicyStatus = (typeof BFF_POLICY_STATUSES)[number];

/** Status of a revision in the history: the current one is derived, older ones are `replaced`. */
export type BffPolicyRevisionStatus = BffPolicyStatus | 'replaced';

/**
 * Deductible: an amount in the minor unit of an ISO 4217 currency (an integer, never a float) or
 * a percentage in basis points (1500 is 15 %). Financial data, gated by `view_costs`.
 */
export type BffDeductible =
  | { readonly kind: 'amount'; readonly amountMinor: number; readonly currency: string }
  | { readonly kind: 'percent'; readonly basisPoints: number };

/**
 * An insurance policy of a vehicle. The company is implicit (the session's); `version` is the
 * concurrency token. The period, the policy number, the coverage type and the deductible belong to
 * the current `revision`; renewing appends a revision and keeps the earlier ones. Without
 * `view_costs` the `deductible` is `null` and `hasDeductible` tells whether one exists.
 */
export interface BffInsurancePolicy {
  readonly id: string;
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes: string | null;
  readonly revision: number;
  readonly policyNumber: string;
  readonly coverageType: BffCoverageType;
  /** `YYYY-MM-DD`; the first day of coverage, inclusive. */
  readonly startsOn: string;
  /** `YYYY-MM-DD`; the last day of coverage, inclusive. */
  readonly endsOn: string;
  readonly status: BffPolicyStatus;
  /** Whole days to the last day of coverage (0 on that day, negative once expired). */
  readonly daysToExpiry: number;
  /** Whether the period contains today; a policy that has not started is `valid` but not covering. */
  readonly covering: boolean;
  readonly hasDeductible: boolean;
  readonly deductible: BffDeductible | null;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

/** Creating a policy. A `deductible` needs `view_costs`; without one the policy has none. */
export interface BffInsurancePolicyInput {
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes?: string | null;
  readonly policyNumber: string;
  readonly coverageType: BffCoverageType;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly deductible?: BffDeductible | null;
}

/** Only the insurer name and the notes can be edited in place; at least one besides `version`. */
export interface BffInsurancePolicyPatch {
  readonly version: number;
  readonly insurer?: string;
  readonly coverageNotes?: string | null;
}

/**
 * A renewal: the new period is required. The policy number, the coverage type and the deductible
 * are carried over when omitted; an explicit `null` deductible removes it. Writing a deductible
 * needs `view_costs`.
 */
export interface BffInsurancePolicyRenewal {
  readonly version: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly policyNumber?: string;
  readonly coverageType?: BffCoverageType;
  readonly deductible?: BffDeductible | null;
}

export interface BffInsurancePoliciesQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly vehicleId?: string;
  readonly coverageType?: BffCoverageType;
  readonly status?: BffPolicyStatus;
  /** `YYYY-MM-DD`: only the policies whose period contains this day (BR-019). */
  readonly coversOn?: string;
  /** `true` to include archived policies (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

export interface BffInsurancePolicyRevision {
  readonly revision: number;
  readonly policyNumber: string;
  readonly coverageType: BffCoverageType;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: BffPolicyRevisionStatus;
  readonly hasDeductible: boolean;
  readonly deductible: BffDeductible | null;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly actorId: string;
  readonly at: ISODateTime;
}

export interface BffInsurancePolicyHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** Request and response types of the insurance routes. */
export interface InsuranceRouteTypes {
  'insurance.list': { query?: BffInsurancePoliciesQuery; response: Page<BffInsurancePolicy> };
  'insurance.create': { body: BffInsurancePolicyInput; response: BffInsurancePolicy };
  'insurance.get': { params: { id: string }; response: BffInsurancePolicy };
  'insurance.update': {
    params: { id: string };
    body: BffInsurancePolicyPatch;
    response: BffInsurancePolicy;
  };
  'insurance.renew': {
    params: { id: string };
    body: BffInsurancePolicyRenewal;
    response: BffInsurancePolicy;
  };
  'insurance.archive': {
    params: { id: string };
    body: { version: number };
    response: BffInsurancePolicy;
  };
  'insurance.history': {
    params: { id: string };
    query?: BffInsurancePolicyHistoryQuery;
    response: Page<BffInsurancePolicyRevision>;
  };
}

export const INSURANCE_ROUTES = {
  'insurance.list': {
    method: 'GET',
    path: ['api', 'insurance-policies'],
    kind: 'session',
    status: 200,
  },
  'insurance.create': {
    method: 'POST',
    path: ['api', 'insurance-policies'],
    kind: 'session-csrf',
    status: 201,
  },
  'insurance.get': {
    method: 'GET',
    path: ['api', 'insurance-policies', ':id'],
    kind: 'session',
    status: 200,
  },
  'insurance.update': {
    method: 'PUT',
    path: ['api', 'insurance-policies', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'insurance.renew': {
    method: 'POST',
    path: ['api', 'insurance-policies', ':id', 'renew'],
    kind: 'session-csrf',
    status: 200,
  },
  'insurance.archive': {
    method: 'POST',
    path: ['api', 'insurance-policies', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'insurance.history': {
    method: 'GET',
    path: ['api', 'insurance-policies', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof InsuranceRouteTypes, BffRouteDefinition>;
