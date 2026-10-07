/**
 * Driver-vehicle assignments (FLT-VEH slice: BRD §8.7, FR-075, FR-076, FR-053, BR-002, BR-003,
 * BR-014, US-013). An assignment links a vehicle to an employee of kind `driver` with a type
 * (`principal`, `secondary`, `temporary`), a start, an optional end and a reason. The history is
 * never rewritten: an assignment is only ever closed (it is never edited or deleted) and every
 * change appends an event.
 */
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../documents/src/index.js';
export {
  ASSIGNMENT_TYPES,
  type AssignmentType,
  isAssignmentType,
  ASSIGNMENT_STATUSES,
  type AssignmentStatus,
  isAssignmentStatus,
  type EndKind,
  type AssignmentEventKind,
  type Assignment,
  type AssignmentEvent,
  MAX_REASON_LENGTH,
  type NewAssignmentData,
} from './types.js';
export {
  type AssignmentErrorCode,
  type AssignmentConflictField,
  AssignmentError,
} from './errors.js';
export {
  normalizeReason,
  CREATE_FIELDS,
  END_FIELDS,
  parseNewAssignment,
  parseEnd,
} from './validation.js';
export {
  isCurrent,
  isCurrentPrincipal,
  newAssignment,
  assignedEvent,
  applyEnd,
  endedEvent,
} from './rules.js';
export {
  type AssignmentFilter,
  type AssignmentWindow,
  type AssignmentSlice,
  type AssignmentEventSlice,
  type AssignmentClosing,
  type AssignmentStore,
  type AssignmentVehicleGate,
  type AssignmentEmployeeGate,
} from './ports.js';
export { InMemoryAssignmentStore } from './store.js';
export {
  type AssignmentListQuery,
  type AssignmentHistoryQuery,
  type AssignmentServiceOptions,
  type Assigned,
  AssignmentService,
} from './service.js';
