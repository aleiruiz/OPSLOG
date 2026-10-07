/**
 * Insurance policies of vehicles (FLT-DOCS slice 2; BRD §8.4, FR-090, FR-091, BR-009, BR-025,
 * US-012). The expiry rules are the ones of documents (same window, same inclusive last day, same
 * derived status), reused from `@opslog/domain-documents` rather than copied.
 */
export {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  addDays,
  dateOf,
  expiryFilterOf,
  expiryOf,
  matchesExpiry,
  revisionStatus,
} from '../../documents/src/index.js';
export type {
  DocumentStatus as PolicyStatus,
  Expiry,
  ExpiryFilter,
  RevisionStatus,
} from '../../documents/src/index.js';
export {
  POLICY_STATUSES,
  isPolicyStatus,
  COVERAGE_TYPES,
  type CoverageType,
  isCoverageType,
  MAX_DEDUCTIBLE_MINOR,
  MAX_DEDUCTIBLE_BASIS_POINTS,
  type Deductible,
  type PolicyRevisionData,
  type PolicyRevision,
  type Policy,
  type NewPolicyData,
  type PolicyPatch,
} from './types.js';
export { type PolicyErrorCode, type PolicyConflictField, PolicyError } from './errors.js';
export {
  normalizeInsurer,
  normalizePolicyNumber,
  parseDeductible,
  writesDeductible,
  REVISION_FIELDS,
  CREATE_FIELDS,
  UPDATE_FIELDS,
  RENEW_FIELDS,
  parseNewPolicy,
  parseRenewal,
  parsePolicyPatch,
} from './validation.js';
export {
  coversOn,
  revisionDataOf,
  revisionOf,
  newPolicy,
  applyPatch,
  applyRenewal,
  applyArchive,
} from './rules.js';
export {
  type PolicyFilter,
  type PolicyWindow,
  type PolicySlice,
  type PolicyRevisionSlice,
  type PolicyStore,
  type PolicyVehicleGate,
} from './ports.js';
export { InMemoryPolicyStore } from './store.js';
export {
  type PolicyListQuery,
  type PolicyHistoryQuery,
  type PolicyServiceOptions,
  PolicyService,
} from './service.js';
