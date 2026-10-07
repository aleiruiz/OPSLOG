export const IMPORT_ENTITIES = ['vehicle', 'employee'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
export const isImportEntity = (value: unknown): value is ImportEntity =>
  typeof value === 'string' && (IMPORT_ENTITIES as readonly string[]).includes(value);

export const IMPORT_MODES = ['dry_run', 'commit_all', 'commit_valid'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];
export const isImportMode = (value: unknown): value is ImportMode =>
  typeof value === 'string' && (IMPORT_MODES as readonly string[]).includes(value);

/** S27: pending (`running`), validated, imported or failed. */
export const IMPORT_STATUSES = ['running', 'validated', 'imported', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const isImportStatus = (value: unknown): value is ImportStatus =>
  typeof value === 'string' && (IMPORT_STATUSES as readonly string[]).includes(value);

/** What happened to one row: `valid` (dry run), `invalid`, `imported`, or `skipped` (valid but not written because `commit_all` was rejected). */
export const ROW_OUTCOMES = ['valid', 'invalid', 'imported', 'skipped'] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];
export const isRowOutcome = (value: unknown): value is RowOutcome =>
  typeof value === 'string' && (ROW_OUTCOMES as readonly string[]).includes(value);

export const ROW_ISSUE_CODES = [
  'missing_value',
  'invalid_value',
  'formula_injection',
  'duplicate',
  'duplicate_in_file',
  'invalid_area',
] as const;
export type RowIssueCode = (typeof ROW_ISSUE_CODES)[number];
export const isRowIssueCode = (value: unknown): value is RowIssueCode =>
  typeof value === 'string' && (ROW_ISSUE_CODES as readonly string[]).includes(value);

/** Why a row is invalid and where: a code and column names of the template, never a value. */
export interface RowIssue {
  readonly code: RowIssueCode;
  readonly columns: readonly string[];
}

export type ImportEventKind = 'started' | 'validated' | 'imported' | 'failed';

export interface ImportJob {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly entity: ImportEntity;
  readonly mode: ImportMode;
  readonly status: ImportStatus;
  /** Client key that makes a retry return this job instead of a new one; required to commit. */
  readonly idempotencyKey: string | null;
  /** SHA-256 of the canonical rows without personal data: what a dry run and its confirmation must share. */
  readonly fingerprint: string;
  readonly totalRows: number;
  /** Rows that passed validation (also those imported or skipped). */
  readonly validRows: number;
  readonly invalidRows: number;
  readonly importedRows: number;
  /** `user-<subject>` that submitted. */
  readonly createdBy: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** Optimistic concurrency token: 1 while running, 2 once finished. */
  readonly version: number;
  readonly updatedAt: string;
}

/** One row of the append-only result history of a job. */
export interface ImportRowResult {
  readonly tenantId: string;
  readonly jobId: string;
  /** 1-based position of the row in the request. */
  readonly rowNumber: number;
  readonly outcome: RowOutcome;
  readonly code: RowIssueCode | null;
  readonly columns: readonly string[];
  /** Id of the vehicle or employee created, for `imported`. */
  readonly entityId: string | null;
  readonly at: string;
}

/** One row of the append-only lifecycle history of a job: seq 1 `started`, seq 2 its end. */
export interface ImportEvent {
  readonly tenantId: string;
  readonly jobId: string;
  readonly seq: number;
  readonly kind: ImportEventKind;
  readonly actorId: string;
  /** Rows accepted (valid for a dry run, imported otherwise) and rejected; null on `started`. */
  readonly acceptedRows: number | null;
  readonly rejectedRows: number | null;
  readonly at: string;
}
