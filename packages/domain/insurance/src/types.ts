import { isDocumentStatus } from '../../documents/src/index.js';

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

export interface NewPolicyData {
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes: string | null;
  readonly revision: PolicyRevisionData;
}

export interface PolicyPatch {
  readonly insurer?: string;
  readonly coverageNotes?: string | null;
}
