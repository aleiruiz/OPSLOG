/**
 * Bulk import of vehicles and employees (FLT-IMPORT: BRD FR-054, FR-074, US-016, screen S27,
 * SPECS §10 M2). A request carries the rows (JSON objects, or one CSV text) and one of three modes:
 * `dry_run` validates and writes nothing, `commit_all` imports only when every row is valid and
 * `commit_valid` imports the valid rows and reports the rest. Every request leaves an import job
 * with an append-only history: one result per row (a row number, an outcome, a code and column
 * names, never a value) and one event per lifecycle step. Rows are created through the existing
 * vehicle and employee services (the `ImportTarget` port), so their rules and the encryption of
 * personal data stay where they are; imported values are never stored by this module.
 */

export {
  IMPORT_ENTITIES,
  isImportEntity,
  IMPORT_MODES,
  isImportMode,
  IMPORT_STATUSES,
  isImportStatus,
  ROW_OUTCOMES,
  isRowOutcome,
  ROW_ISSUE_CODES,
  isRowIssueCode,
} from './types.js';
export type {
  ImportEntity,
  ImportMode,
  ImportStatus,
  RowOutcome,
  RowIssueCode,
  RowIssue,
  ImportEventKind,
  ImportJob,
  ImportRowResult,
  ImportEvent,
} from './types.js';
export { ImportError } from './errors.js';
export type { ImportErrorCode } from './errors.js';
export { MAX_ROWS, MAX_CSV_LENGTH, MAX_CELL_LENGTH, IMPORT_COLUMNS } from './columns.js';
export type { ColumnSpec } from './columns.js';
export { parseCsv, SUBMISSION_FIELDS, parseSubmission, importWritesPii } from './parsing.js';
export type { RawRow, Submission } from './parsing.js';
export { isFormula, prepareRow, fingerprintOf } from './rows.js';
export type { PreparedRow } from './rows.js';
export { InMemoryImportStore } from './store.js';
export type {
  ImportJobFilter,
  RowFilter,
  ImportWindow,
  ImportJobSlice,
  ImportRowSlice,
  ImportEventSlice,
  ImportStore,
} from './store.js';
export { DEFAULT_LEASE_MS } from './service-types.js';
export type {
  CreateOutcome,
  ImportTarget,
  ImportObserver,
  ImportServiceOptions,
  Submitted,
  ImportListQuery,
  ImportRowsQuery,
  ImportHistoryQuery,
} from './service-types.js';
export { ImportService } from './service.js';
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../documents/src/index.js';
