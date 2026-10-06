import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, requireOpaqueId } from '../../documents/src/index.js';

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
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT };

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

export type ImportErrorCode =
  | 'invalid_input'
  | 'not_found'
  /** The idempotency key was used for a different request, or the dry run no longer matches the rows. */
  | 'conflict';

export class ImportError extends Error {
  public constructor(public readonly code: ImportErrorCode) {
    super(`Import request rejected: ${code}`);
    this.name = 'ImportError';
  }
}

const invalid = (): never => {
  throw new ImportError('invalid_input');
};

export const MAX_ROWS = 500;
/** Characters of a CSV text (about 250 KiB for ASCII). */
export const MAX_CSV_LENGTH = 256_000;
export const MAX_CELL_LENGTH = 200;
const MAX_HEADER_COLUMNS = 16;

/**
 * The template of each entity: the column names a row may carry (the names of the create request of
 * the entity). `pii` columns are personal data: they are accepted, sealed by the employee service
 * and never fingerprinted, stored or reported. `integers` are numeric in the create request.
 */
export interface ColumnSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly integers: readonly string[];
  readonly pii: readonly string[];
}
export const IMPORT_COLUMNS: Readonly<Record<ImportEntity, ColumnSpec>> = {
  vehicle: {
    required: ['economicNumber', 'plate', 'make', 'model', 'year', 'areaId', 'odometerKm'],
    optional: ['vin', 'registeredOn'],
    integers: ['year', 'odometerKm'],
    pii: [],
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
    integers: [],
    pii: ['idType', 'nationalId', 'phone', 'email', 'licenseNumber'],
  },
};
const columnsOf = (entity: ImportEntity): readonly string[] => [
  ...IMPORT_COLUMNS[entity].required,
  ...IMPORT_COLUMNS[entity].optional,
];

// ---- records ----------------------------------------------------------------------------------

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

// ---- request parsing --------------------------------------------------------------------------

type Fields = Readonly<Record<string, unknown>>;
export type RawRow = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

const guardId = (value: unknown): string => {
  try {
    return requireOpaqueId(value);
  } catch {
    return invalid();
  }
};

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * RFC 4180 reader: comma separated, double-quoted cells with `""` escapes, CRLF or LF, an optional
 * byte-order mark, blank lines skipped. Anything else (a quote inside an unquoted cell, text after
 * a closing quote, an unterminated quote) is `invalid_input`.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = (): void => {
    endCell();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
        wasQuoted = true;
      }
    } else if (char === '"') {
      if (cell !== '' || wasQuoted) return invalid();
      quoted = true;
    } else if (wasQuoted && char !== ',' && char !== '\n' && char !== '\r') {
      return invalid();
    } else if (char === ',') endCell();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (source.charAt(i + 1) === '\n') i += 1;
      endRow();
    } else cell += char;
  }
  if (quoted) return invalid();
  if (cell !== '' || wasQuoted || row.length > 0) endRow();
  return rows;
}

export interface Submission {
  readonly entity: ImportEntity;
  readonly mode: ImportMode;
  readonly idempotencyKey: string | null;
  /** The dry run this commit confirms, when the caller wants the snapshot checked. */
  readonly dryRunJobId: string | null;
  /** Every column that appears in the request. */
  readonly columns: readonly string[];
  readonly rows: readonly RawRow[];
}

export const SUBMISSION_FIELDS = [
  'entity',
  'mode',
  'idempotencyKey',
  'dryRunJobId',
  'rows',
  'csv',
] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

function rowsOfCsv(text: string, entity: ImportEntity): readonly RawRow[] {
  const table = parseCsv(text);
  const [header, ...body] = table;
  if (header === undefined || header.length > MAX_HEADER_COLUMNS) return invalid();
  const names = header.map((name) => name.trim());
  const allowed = columnsOf(entity);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.includes(name)) ||
    IMPORT_COLUMNS[entity].required.some((name) => !names.includes(name))
  )
    return invalid();
  return body.map((cells) => {
    if (cells.length !== names.length) return invalid();
    return Object.fromEntries(names.map((name, index) => [name, cells[index]])) as RawRow;
  });
}

function rowsOfObjects(value: unknown, entity: ImportEntity): readonly RawRow[] {
  if (!Array.isArray(value)) return invalid();
  const allowed = columnsOf(entity);
  return value.map((row: unknown): RawRow => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return invalid();
    if (Object.keys(row).some((key) => !allowed.includes(key))) return invalid();
    return row as RawRow;
  });
}

/** Validates the shape of an import request (rows are judged one by one later). Unknown properties are rejected. */
export function parseSubmission(input: unknown): Submission {
  const fields = asFields(input, SUBMISSION_FIELDS);
  const entity = fields['entity'];
  const mode = fields['mode'];
  if (!isImportEntity(entity) || !isImportMode(mode)) return invalid();
  const hasRows = Object.hasOwn(fields, 'rows');
  const hasCsv = Object.hasOwn(fields, 'csv');
  if (hasRows === hasCsv) return invalid();
  const key = fields['idempotencyKey'];
  if (key !== undefined && (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)))
    return invalid();
  if (mode !== 'dry_run' && key === undefined) return invalid();
  const preview = fields['dryRunJobId'];
  if (preview !== undefined && mode === 'dry_run') return invalid();
  const csv = fields['csv'];
  if (hasCsv && (typeof csv !== 'string' || csv.length > MAX_CSV_LENGTH)) return invalid();
  const rows = hasCsv ? rowsOfCsv(csv as string, entity) : rowsOfObjects(fields['rows'], entity);
  if (rows.length < 1 || rows.length > MAX_ROWS) return invalid();
  return {
    entity,
    mode,
    idempotencyKey: key === undefined ? null : key,
    dryRunJobId: preview === undefined ? null : guardId(preview),
    columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
    rows,
  };
}

/** True when the request, taken as an employee import, carries personal data columns (needs the PII permission). */
export function importWritesPii(input: unknown): boolean {
  try {
    const submission = parseSubmission(input);
    return submission.columns.some((column) =>
      IMPORT_COLUMNS[submission.entity].pii.includes(column),
    );
  } catch {
    return false;
  }
}

// ---- row validation ---------------------------------------------------------------------------

const FORMULA_LEAD = /^[=@]/;
const SIGN_LEAD = /^[+-]/;
const PHONE_LIKE = /^\+[0-9][0-9 ().-]{5,24}$/;
const DIGITS = /^\d{1,7}$/;

/**
 * Spreadsheet formula injection: a cell that starts (after trimming, so tabs and carriage returns
 * count) with `=`, `@`, `+` or `-` would run as a formula when the data is opened in a spreadsheet.
 * The one legitimate exception is an international phone number in the `phone` column.
 */
export function isFormula(column: string, text: string): boolean {
  if (FORMULA_LEAD.test(text)) return true;
  return SIGN_LEAD.test(text) && !(column === 'phone' && PHONE_LIKE.test(text));
}

export interface PreparedRow {
  /** 1-based position in the request. */
  readonly rowNumber: number;
  /** The create request of the entity (typed values), or null when the row has an issue. */
  readonly input: Readonly<Record<string, unknown>> | null;
  readonly issue: RowIssue | null;
}

const issue = (code: RowIssueCode, columns: readonly string[]): RowIssue => ({ code, columns });

/**
 * Turns one raw row into the create request of its entity: cells are trimmed, empty cells are
 * absent, numeric columns are read as integers. An issue names the columns at fault, never a value.
 */
export function prepareRow(entity: ImportEntity, rowNumber: number, raw: RawRow): PreparedRow {
  const spec = IMPORT_COLUMNS[entity];
  const values: Record<string, unknown> = {};
  const formulas: string[] = [];
  const bad: string[] = [];
  for (const column of columnsOf(entity)) {
    const cell = Object.hasOwn(raw, column) ? raw[column] : undefined;
    if (cell === undefined || cell === null) continue;
    let text: string;
    if (typeof cell === 'number') {
      if (!Number.isSafeInteger(cell) || cell < 0) {
        bad.push(column);
        continue;
      }
      text = String(cell);
    } else if (typeof cell === 'string') text = cell.trim();
    else {
      bad.push(column);
      continue;
    }
    if (text === '') continue;
    if (text.length > MAX_CELL_LENGTH) bad.push(column);
    else if (isFormula(column, text)) formulas.push(column);
    else values[column] = text;
  }
  if (formulas.length > 0)
    return { rowNumber, input: null, issue: issue('formula_injection', formulas) };
  const missing = spec.required.filter(
    (column) => !Object.hasOwn(values, column) && !bad.includes(column),
  );
  if (missing.length > 0) return { rowNumber, input: null, issue: issue('missing_value', missing) };
  for (const column of spec.integers) {
    const text = values[column];
    if (typeof text !== 'string') continue;
    if (DIGITS.test(text)) values[column] = Number(text);
    else bad.push(column);
  }
  if (bad.length > 0)
    return { rowNumber, input: null, issue: issue('invalid_value', [...new Set(bad)]) };
  return { rowNumber, input: values, issue: null };
}

/** Stable SHA-256 of the rows: personal data columns count only as present or absent, never as values. */
export function fingerprintOf(submission: Pick<Submission, 'entity' | 'rows'>): string {
  const pii = IMPORT_COLUMNS[submission.entity].pii;
  const canonical = submission.rows.map((row) =>
    Object.keys(row)
      .sort()
      .map((column) => {
        const cell = row[column];
        const text = typeof cell === 'string' ? cell.trim() : cell === null ? '' : String(cell);
        return [column, pii.includes(column) ? text !== '' : text];
      }),
  );
  return createHash('sha256')
    .update(JSON.stringify([submission.entity, canonical]))
    .digest('hex');
}

// ---- store port -------------------------------------------------------------------------------

export interface ImportJobFilter {
  readonly entity?: ImportEntity;
  readonly status?: ImportStatus;
}
export interface RowFilter {
  readonly outcome?: RowOutcome;
}
export interface ImportWindow {
  readonly limit: number;
  readonly offset: number;
}
export interface ImportJobSlice {
  readonly items: readonly ImportJob[];
  /** Number of jobs matching the filter, not only the window. */
  readonly total: number;
}
export interface ImportRowSlice {
  readonly items: readonly ImportRowResult[];
  readonly total: number;
}
export interface ImportEventSlice {
  readonly items: readonly ImportEvent[];
  readonly total: number;
}

/**
 * Persistence port. Every method is tenant-scoped: a job of another tenant is simply absent. Row
 * results and events are only ever appended; a job is only ever finished (never edited, never
 * deleted).
 */
export interface ImportStore {
  /** Inserts the job and its first event. False when the tenant already has a job with the same idempotency key. */
  insertJob(job: ImportJob, event: ImportEvent): Promise<boolean>;
  findJob(tenantId: string, id: string): Promise<ImportJob | null>;
  findByKey(tenantId: string, idempotencyKey: string): Promise<ImportJob | null>;
  /** Newest first, then id. */
  listJobs(
    tenantId: string,
    filter: ImportJobFilter,
    window: ImportWindow,
  ): Promise<ImportJobSlice>;
  /** Appends results; a row number that already has a result keeps it (a retry never rewrites history). */
  appendRows(tenantId: string, jobId: string, rows: readonly ImportRowResult[]): Promise<void>;
  /** By row number. */
  rows(
    tenantId: string,
    jobId: string,
    filter: RowFilter,
    window: ImportWindow,
  ): Promise<ImportRowSlice>;
  /** Atomic compare-and-set of the end of a job: writes `next` and `event` only while the stored version is `expectedVersion`; false otherwise. */
  finishJob(next: ImportJob, expectedVersion: number, event: ImportEvent): Promise<boolean>;
  /** Newest event first. */
  events(tenantId: string, jobId: string, window: ImportWindow): Promise<ImportEventSlice>;
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemoryImportStore implements ImportStore {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly results = new Map<string, ImportRowResult>();
  private readonly eventRows: ImportEvent[] = [];

  public async insertJob(job: ImportJob, event: ImportEvent): Promise<boolean> {
    const taken =
      job.idempotencyKey !== null &&
      [...this.jobs.values()].some(
        (other) => other.tenantId === job.tenantId && other.idempotencyKey === job.idempotencyKey,
      );
    if (taken || this.jobs.has(storeKey(job.tenantId, job.id))) return false;
    this.jobs.set(storeKey(job.tenantId, job.id), structuredClone(job));
    this.eventRows.push(structuredClone(event));
    return true;
  }

  public async findJob(tenantId: string, id: string): Promise<ImportJob | null> {
    const found = this.jobs.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async findByKey(tenantId: string, idempotencyKey: string): Promise<ImportJob | null> {
    const found = [...this.jobs.values()].find(
      (job) => job.tenantId === tenantId && job.idempotencyKey === idempotencyKey,
    );
    return found ? structuredClone(found) : null;
  }

  public async listJobs(
    tenantId: string,
    filter: ImportJobFilter,
    window: ImportWindow,
  ): Promise<ImportJobSlice> {
    const matching = [...this.jobs.values()]
      .filter(
        (job) =>
          job.tenantId === tenantId &&
          (filter.entity === undefined || job.entity === filter.entity) &&
          (filter.status === undefined || job.status === filter.status),
      )
      .sort((a, b) => compareKeys(b.createdAt, a.createdAt) || compareKeys(a.id, b.id));
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((job) => structuredClone(job)),
      total: matching.length,
    };
  }

  public async appendRows(
    tenantId: string,
    jobId: string,
    rows: readonly ImportRowResult[],
  ): Promise<void> {
    for (const row of rows) {
      const key = `${storeKey(tenantId, jobId)}#${row.rowNumber}`;
      if (!this.results.has(key)) this.results.set(key, structuredClone(row));
    }
  }

  public async rows(
    tenantId: string,
    jobId: string,
    filter: RowFilter,
    window: ImportWindow,
  ): Promise<ImportRowSlice> {
    const matching = [...this.results.values()]
      .filter(
        (row) =>
          row.tenantId === tenantId &&
          row.jobId === jobId &&
          (filter.outcome === undefined || row.outcome === filter.outcome),
      )
      .sort((a, b) => a.rowNumber - b.rowNumber);
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: matching.length,
    };
  }

  public async finishJob(
    next: ImportJob,
    expectedVersion: number,
    event: ImportEvent,
  ): Promise<boolean> {
    const key = storeKey(next.tenantId, next.id);
    if (this.jobs.get(key)?.version !== expectedVersion) return false;
    this.jobs.set(key, structuredClone(next));
    this.eventRows.push(structuredClone(event));
    return true;
  }

  public async events(
    tenantId: string,
    jobId: string,
    window: ImportWindow,
  ): Promise<ImportEventSlice> {
    const all = this.eventRows
      .filter((row) => row.tenantId === tenantId && row.jobId === jobId)
      .sort((a, b) => b.seq - a.seq);
    return {
      items: all
        .slice(window.offset, window.offset + window.limit)
        .map((row) => structuredClone(row)),
      total: all.length,
    };
  }
}

// ---- service ----------------------------------------------------------------------------------

/** What creating one row through the entity service produced: the new id, or why the row was refused. */
export type CreateOutcome = { readonly id: string } | { readonly issue: RowIssue };

/**
 * Port to the module of one entity (vehicles or employees). The composition implements it over the
 * existing services, so every rule of those modules (unique keys per tenant, active area, sealing
 * of personal data) applies exactly as on their own create. Failures that are not a verdict about
 * the row (a store outage) are thrown, never turned into an issue.
 */
export interface ImportTarget {
  /** Columns whose value the entity service would refuse (empty when the row is valid). */
  invalidColumns(input: Readonly<Record<string, unknown>>, now: Date): readonly string[];
  /** Normalized natural keys `[column, key]` of a valid row, to find repeats inside the request. */
  keys(input: Readonly<Record<string, unknown>>): readonly (readonly [string, string])[];
  /** Read-only checks against stored data (existing keys, active area); aligned with `inputs`. */
  precheck(
    tenantId: string,
    inputs: readonly Readonly<Record<string, unknown>>[],
  ): Promise<readonly (RowIssue | null)[]>;
  /** Creates the row through the entity service. */
  create(
    tenantId: string,
    actorId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CreateOutcome>;
}

/** Told about every vehicle or employee a job creates, as it is created (the composition audits it). */
export interface ImportObserver {
  created(entity: ImportEntity, id: string): void;
}

/** How long a `running` job counts as being executed by someone: a retry inside it is a `conflict`, after it the job is resumed. */
export const DEFAULT_LEASE_MS = 120_000;

export interface ImportServiceOptions {
  readonly targets: Readonly<Record<ImportEntity, ImportTarget>>;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface Submitted {
  readonly job: ImportJob;
  /** True when the idempotency key already belonged to a finished job: nothing was run again. */
  readonly replayed: boolean;
}

export interface ImportListQuery {
  readonly entity?: unknown;
  readonly status?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}
export interface ImportRowsQuery {
  readonly outcome?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}
export interface ImportHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

function windowOf(query: ImportHistoryQuery): ImportWindow {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
  return { limit, offset };
}

/** Every result of a job (a job has at most `MAX_ROWS`). */
const EVERYTHING: ImportWindow = { limit: MAX_ROWS, offset: 0 };

const NO_FILTER = {} as const;

const jobStartedEvent = (job: ImportJob): ImportEvent => ({
  tenantId: job.tenantId,
  jobId: job.id,
  seq: 1,
  kind: 'started',
  actorId: job.createdBy,
  acceptedRows: null,
  rejectedRows: null,
  at: job.createdAt,
});

/**
 * Import use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class enforces the domain rules. The tenant is always an argument
 * taken from the server-side session, never part of the input being validated.
 */
export class ImportService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly targets: Readonly<Record<ImportEntity, ImportTarget>>;
  private readonly leaseMs: number;

  public constructor(
    private readonly store: ImportStore,
    options: ImportServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.targets = options.targets;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  /** The job of this tenant, or `not_found` (also for ids of other tenants). */
  private async load(tenantId: string, id: unknown): Promise<ImportJob> {
    const found = await this.store.findJob(guardId(tenantId), guardId(id));
    if (found?.tenantId !== tenantId) throw new ImportError('not_found');
    return found;
  }

  /** A confirmation must refer to a finished dry run of the same entity over the same rows. */
  private async assertPreview(
    tenantId: string,
    submission: Submission,
    fingerprint: string,
  ): Promise<void> {
    const preview = await this.load(tenantId, submission.dryRunJobId);
    if (
      preview.mode !== 'dry_run' ||
      preview.status !== 'validated' ||
      preview.fingerprint !== fingerprint
    )
      throw new ImportError('conflict');
  }

  /**
   * Validates every row (shape, then the entity's own rules, then repeats inside the request) and
   * returns one prepared row each. Pure: nothing is read or written.
   */
  private evaluate(target: ImportTarget, submission: Submission, now: Date): PreparedRow[] {
    const seen = new Set<string>();
    return submission.rows.map((raw, index): PreparedRow => {
      const rowNumber = index + 1;
      const prepared = prepareRow(submission.entity, rowNumber, raw);
      if (prepared.input === null) return prepared;
      const wrong = target.invalidColumns(prepared.input, now);
      if (wrong.length > 0) return { rowNumber, input: null, issue: issue('invalid_value', wrong) };
      const keys = target
        .keys(prepared.input)
        .map(([column, key]) => [column, `${column}\u0000${key}`] as const);
      const repeated = keys.filter(([, key]) => seen.has(key)).map(([column]) => column);
      if (repeated.length > 0)
        return { rowNumber, input: null, issue: issue('duplicate_in_file', repeated) };
      for (const [, key] of keys) seen.add(key);
      return prepared;
    });
  }

  private result(
    job: ImportJob,
    rowNumber: number,
    verdict: { outcome: RowOutcome; issue?: RowIssue; entityId?: string },
  ): ImportRowResult {
    return {
      tenantId: job.tenantId,
      jobId: job.id,
      rowNumber,
      outcome: verdict.outcome,
      code: verdict.issue?.code ?? null,
      columns: verdict.issue?.columns ?? [],
      entityId: verdict.entityId ?? null,
      at: this.now().toISOString(),
    };
  }

  /**
   * Runs (or resumes) a job: rows that already have a result are not run again, so a retry after a
   * crash continues where the first attempt stopped. Ends with the single `finishJob` write.
   */
  private async execute(
    actorId: string,
    job: ImportJob,
    submission: Submission,
    observer: ImportObserver | undefined,
  ): Promise<ImportJob> {
    const { tenantId } = job;
    const target = this.targets[job.entity];
    const recorded = new Map(
      (await this.store.rows(tenantId, job.id, NO_FILTER, EVERYTHING)).items.map((row) => [
        row.rowNumber,
        row,
      ]),
    );
    const open = this.evaluate(target, submission, this.now()).filter(
      (row) => !recorded.has(row.rowNumber),
    );
    const checkable = open.filter((row) => row.issue === null);
    const found = await target.precheck(
      tenantId,
      checkable.map((row) => row.input as Readonly<Record<string, unknown>>),
    );
    const stored = new Map(checkable.map((row, index) => [row.rowNumber, found[index] ?? null]));
    const pending = open.map((row) => ({
      rowNumber: row.rowNumber,
      input: row.input,
      issue: row.issue ?? stored.get(row.rowNumber) ?? null,
    }));
    const rejected = [...recorded.values()].filter((row) => row.outcome === 'invalid').length;
    const reject =
      job.mode === 'commit_all' &&
      rejected + pending.filter((row) => row.issue !== null).length > 0;
    if (job.mode === 'dry_run' || reject) {
      await this.store.appendRows(
        tenantId,
        job.id,
        pending.map((row) =>
          row.issue
            ? this.result(job, row.rowNumber, { outcome: 'invalid', issue: row.issue })
            : this.result(job, row.rowNumber, {
                outcome: job.mode === 'dry_run' ? 'valid' : 'skipped',
              }),
        ),
      );
    } else {
      await this.store.appendRows(
        tenantId,
        job.id,
        pending
          .filter((row) => row.issue !== null)
          .map((row) =>
            this.result(job, row.rowNumber, { outcome: 'invalid', issue: row.issue as RowIssue }),
          ),
      );
      for (const row of pending.filter((candidate) => candidate.issue === null)) {
        const created = await target.create(
          tenantId,
          actorId,
          row.input as Readonly<Record<string, unknown>>,
        );
        if ('issue' in created)
          await this.store.appendRows(tenantId, job.id, [
            this.result(job, row.rowNumber, { outcome: 'invalid', issue: created.issue }),
          ]);
        else {
          observer?.created(job.entity, created.id);
          await this.store.appendRows(tenantId, job.id, [
            this.result(job, row.rowNumber, { outcome: 'imported', entityId: created.id }),
          ]);
        }
      }
    }
    return this.finish(job);
  }

  private async finish(job: ImportJob): Promise<ImportJob> {
    const all = (await this.store.rows(job.tenantId, job.id, NO_FILTER, EVERYTHING)).items;
    const count = (outcome: RowOutcome): number =>
      all.filter((row) => row.outcome === outcome).length;
    const imported = count('imported');
    const invalidRows = count('invalid');
    const validRows = all.length - invalidRows;
    const status: ImportStatus =
      job.mode === 'dry_run' ? 'validated' : imported > 0 ? 'imported' : 'failed';
    const at = this.now().toISOString();
    const next: ImportJob = {
      ...job,
      status,
      validRows,
      invalidRows,
      importedRows: imported,
      finishedAt: at,
      version: job.version + 1,
      updatedAt: at,
    };
    const event: ImportEvent = {
      tenantId: job.tenantId,
      jobId: job.id,
      seq: 2,
      kind: status as ImportEventKind,
      actorId: job.createdBy,
      acceptedRows: job.mode === 'dry_run' ? validRows : imported,
      rejectedRows: invalidRows,
      at,
    };
    if (await this.store.finishJob(next, job.version, event)) return next;
    // Another attempt with the same key finished first: its result stands.
    return (await this.store.findJob(job.tenantId, job.id)) ?? next;
  }

  /**
   * Runs an import request. A dry run writes nothing but its own job. A commit needs an
   * idempotency key: the same key with the same request returns the stored job (`replayed`) or, if
   * the first attempt stopped midway for longer than the lease, resumes it (within the lease it is
   * a `conflict`: the first attempt may still be running); the same key with a different request is
   * a `conflict` too. `dryRunJobId` makes the commit check that the rows are the ones that were validated.
   */
  public async submit(
    tenantId: string,
    actorId: string,
    input: unknown,
    observer?: ImportObserver,
  ): Promise<Submitted> {
    guardId(tenantId);
    guardId(actorId);
    const now = this.now();
    const submission = parseSubmission(input);
    const fingerprint = fingerprintOf(submission);
    if (submission.dryRunJobId !== null)
      await this.assertPreview(tenantId, submission, fingerprint);
    const key = submission.idempotencyKey;
    let job = key === null ? null : await this.store.findByKey(tenantId, key);
    let created = false;
    if (job === null) {
      const fresh: ImportJob = {
        id: this.newId(),
        tenantId,
        entity: submission.entity,
        mode: submission.mode,
        status: 'running',
        idempotencyKey: key,
        fingerprint,
        totalRows: submission.rows.length,
        validRows: 0,
        invalidRows: 0,
        importedRows: 0,
        createdBy: actorId,
        createdAt: now.toISOString(),
        finishedAt: null,
        version: 1,
        updatedAt: now.toISOString(),
      };
      created = await this.store.insertJob(fresh, jobStartedEvent(fresh));
      // Lost the race for the key: the winner's job decides.
      job = created ? fresh : key === null ? null : await this.store.findByKey(tenantId, key);
    }
    if (job === null || job.fingerprint !== fingerprint || job.mode !== submission.mode)
      throw new ImportError('conflict');
    if (job.status !== 'running') return { job, replayed: !created };
    // Someone is still running it (an attempt that lost the race, or a quick retry): not ours to run twice.
    if (!created && now.getTime() - Date.parse(job.createdAt) < this.leaseMs)
      throw new ImportError('conflict');
    return { job: await this.execute(actorId, job, submission, observer), replayed: false };
  }

  public get(tenantId: string, id: unknown): Promise<ImportJob> {
    return this.load(tenantId, id);
  }

  public async list(tenantId: string, query: ImportListQuery = {}): Promise<ImportJobSlice> {
    guardId(tenantId);
    const window = windowOf(query);
    if (query.entity !== undefined && !isImportEntity(query.entity)) return invalid();
    if (query.status !== undefined && !isImportStatus(query.status)) return invalid();
    const filter: ImportJobFilter = {
      ...(query.entity === undefined ? {} : { entity: query.entity }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    return this.store.listJobs(tenantId, filter, window);
  }

  /** The per-row report of a job (`outcome: 'invalid'` is the error report), by row number. */
  public async rows(
    tenantId: string,
    id: unknown,
    query: ImportRowsQuery = {},
  ): Promise<ImportRowSlice> {
    const job = await this.load(tenantId, id);
    const window = windowOf(query);
    if (query.outcome !== undefined && !isRowOutcome(query.outcome)) return invalid();
    return this.store.rows(
      tenantId,
      job.id,
      query.outcome === undefined ? NO_FILTER : { outcome: query.outcome },
      window,
    );
  }

  /** Lifecycle events of one job, newest first. */
  public async history(
    tenantId: string,
    id: unknown,
    query: ImportHistoryQuery = {},
  ): Promise<ImportEventSlice> {
    const job = await this.load(tenantId, id);
    return this.store.events(tenantId, job.id, windowOf(query));
  }
}
