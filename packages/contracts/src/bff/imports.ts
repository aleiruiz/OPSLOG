import type { ISODateTime, Page } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export const BFF_IMPORT_ENTITIES = ['vehicle', 'employee'] as const;
export type BffImportEntity = (typeof BFF_IMPORT_ENTITIES)[number];

/**
 * `dry_run` validates and writes nothing; `commit_all` imports only when every row is valid;
 * `commit_valid` imports the valid rows and reports the rest. Both commits need an `idempotencyKey`.
 */
export const BFF_IMPORT_MODES = ['dry_run', 'commit_all', 'commit_valid'] as const;
export type BffImportMode = (typeof BFF_IMPORT_MODES)[number];

/** Pending (`running`), validated, imported or failed (S27). */
export const BFF_IMPORT_STATUSES = ['running', 'validated', 'imported', 'failed'] as const;
export type BffImportStatus = (typeof BFF_IMPORT_STATUSES)[number];

/** `valid` (dry run), `invalid`, `imported`, or `skipped` (valid, but a `commit_all` was rejected). */
export const BFF_IMPORT_OUTCOMES = ['valid', 'invalid', 'imported', 'skipped'] as const;
export type BffImportOutcome = (typeof BFF_IMPORT_OUTCOMES)[number];

export const BFF_IMPORT_ROW_CODES = [
  'missing_value',
  'invalid_value',
  'formula_injection',
  'duplicate',
  'duplicate_in_file',
  'invalid_area',
] as const;
export type BffImportRowCode = (typeof BFF_IMPORT_ROW_CODES)[number];

/** The import template of each entity: the column names of a row (the fields of its create request). */
export const BFF_IMPORT_TEMPLATES = {
  vehicle: {
    required: ['economicNumber', 'plate', 'make', 'model', 'year', 'areaId', 'odometerKm'],
    optional: ['vin', 'registeredOn'],
  },
  employee: {
    required: ['kind', 'firstName', 'lastName', 'areaId'],
    optional: [
      'employeeNumber',
      'position',
      'hireDate',
      'idType',
      'nationalId',
      'phone',
      'email',
      'licenseNumber',
      'licenseType',
      'licenseExpiresOn',
    ],
  },
} as const;

/** At most this many rows per request, and at most this many bytes in the body of `imports.create`. */
export const BFF_IMPORT_MAX_ROWS = 500;
export const BFF_IMPORT_MAX_BODY_BYTES = 600_000;

/**
 * One import request: the rows as objects (cells are text or numbers, empty or `null` means absent)
 * or the same table as one CSV text with a header line; exactly one of `rows` and `csv`. A commit
 * needs the `idempotencyKey` (8 to 64 characters): the same key with the same request returns the
 * stored job instead of importing again. `dryRunJobId` makes a commit check that the rows are the
 * ones a finished dry run validated. Employee rows with personal-data columns also need `view_pii`.
 */
export interface BffImportInput {
  readonly entity: BffImportEntity;
  readonly mode: BffImportMode;
  readonly idempotencyKey?: string;
  readonly dryRunJobId?: string;
  readonly rows?: readonly Readonly<Record<string, string | number | null>>[];
  readonly csv?: string;
}

/** An import job: counts and states only, never a submitted value. The company is implicit. */
export interface BffImportJob {
  readonly id: string;
  readonly entity: BffImportEntity;
  readonly mode: BffImportMode;
  readonly status: BffImportStatus;
  readonly totalRows: number;
  /** Rows that passed validation (also those imported or skipped). */
  readonly validRows: number;
  readonly invalidRows: number;
  readonly importedRows: number;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly createdBy: string;
  readonly createdAt: ISODateTime;
  readonly finishedAt: ISODateTime | null;
  readonly version: number;
}

export interface BffImportSubmitted {
  readonly job: BffImportJob;
  /** True when the idempotency key already belonged to a finished job: nothing was run again. */
  readonly replayed: boolean;
}

/** The result of one row: where and why, by column name; never a value. */
export interface BffImportRow {
  /** 1-based position in the request. */
  readonly rowNumber: number;
  readonly outcome: BffImportOutcome;
  readonly code: BffImportRowCode | null;
  readonly columns: readonly string[];
  /** Id of the vehicle or employee created, for `imported`. */
  readonly entityId: string | null;
  readonly at: ISODateTime;
}

/** One row of the append-only lifecycle history of a job. */
export interface BffImportEvent {
  readonly seq: number;
  readonly kind: 'started' | 'validated' | 'imported' | 'failed';
  readonly actorId: string;
  readonly acceptedRows: number | null;
  readonly rejectedRows: number | null;
  readonly at: ISODateTime;
}

export interface BffImportsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly entity?: BffImportEntity;
  readonly status?: BffImportStatus;
}

export interface BffImportRowsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly outcome?: BffImportOutcome;
}

export interface BffImportHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** Request and response types of the imports routes. */
export interface ImportsRouteTypes {
  'imports.list': { query?: BffImportsQuery; response: Page<BffImportJob> };
  'imports.create': { body: BffImportInput; response: BffImportSubmitted };
  'imports.get': { params: { id: string }; response: BffImportJob };
  'imports.rows': {
    params: { id: string };
    query?: BffImportRowsQuery;
    response: Page<BffImportRow>;
  };
  'imports.history': {
    params: { id: string };
    query?: BffImportHistoryQuery;
    response: Page<BffImportEvent>;
  };
}

export const IMPORTS_ROUTES = {
  'imports.list': { method: 'GET', path: ['api', 'imports'], kind: 'session', status: 200 },
  'imports.create': {
    method: 'POST',
    path: ['api', 'imports'],
    kind: 'session-csrf',
    status: 201,
    maxBodyBytes: BFF_IMPORT_MAX_BODY_BYTES,
  },
  'imports.get': { method: 'GET', path: ['api', 'imports', ':id'], kind: 'session', status: 200 },
  'imports.rows': {
    method: 'GET',
    path: ['api', 'imports', ':id', 'rows'],
    kind: 'session',
    status: 200,
  },
  'imports.history': {
    method: 'GET',
    path: ['api', 'imports', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof ImportsRouteTypes, BffRouteDefinition>;
