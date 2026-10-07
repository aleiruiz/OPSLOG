/**
 * Areas (BRD §7.2.3, FR-040..042, BR-009, BR-021): the organizational tree of a company, up to
 * four levels deep. This package holds the pure rules, the persistence port with an in-memory
 * double, and the use cases. Authentication, permissions and audit belong to the composition.
 */

export {
  MAX_AREA_DEPTH,
  MAX_RESPONSIBLES,
  MAX_NAME_LENGTH,
  MAX_CODE_LENGTH,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  AREA_ACTIONS,
  AREA_FIELDS,
  isAreaAction,
  isAreaField,
} from './types.js';
export type { Area, AreaNode, AreaAction, AreaField, AreaHistoryEntry } from './types.js';
export { AreaError } from './errors.js';
export type { AreaErrorCode, AreaConflictField } from './errors.js';
export {
  requireOpaqueId,
  requireVersion,
  normalizeName,
  nameKey,
  normalizeCode,
  normalizeResponsibles,
  AREA_INPUT_FIELDS,
  parseNewArea,
  parseAreaPatch,
} from './validation.js';
export type { NewAreaData, AreaPatch } from './validation.js';
export {
  placementDepth,
  newArea,
  historyEntry,
  changedFields,
  applyPatch,
  applyActive,
} from './rules.js';
export { AREA_RESOURCES, NO_RESOURCES } from './ports.js';
export type {
  AreaFilter,
  AreaWindow,
  AreaSlice,
  AreaHistorySlice,
  AreaTx,
  AreaStore,
  AreaResourceCounter,
  AreaResource,
  AreaResourceCounters,
  AreaMemberDirectory,
} from './ports.js';
export { InMemoryAreaStore } from './store.js';
export { AreaService } from './service.js';
export type { AreaListQuery, AreaHistoryQuery, AreaUpdate, AreaServiceOptions } from './service.js';
