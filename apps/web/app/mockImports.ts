import type { ApiError } from '@opslog/contracts';
import { BFF_IMPORT_OUTCOMES, BFF_IMPORT_STATUSES } from '@opslog/contracts';
import { parseCsv } from '../imports/csv';
import { demoImports, type DemoImport } from '../imports/fixtures';
import {
  IDEMPOTENCY_KEY,
  MAX_CELL_LENGTH,
  MAX_CSV_LENGTH,
  MAX_HEADER_COLUMNS,
  MAX_ROWS,
  columnsOf,
  isEntity,
  isMode,
  templateOf,
} from '../imports/rules';
import { NAME } from '../employees/rules';
import { ECONOMIC_NUMBER, OPAQUE_ID, PLATE, normalizePlate } from '../vehicles/rules';
import type {
  ImportEntity,
  ImportEvent,
  ImportInput,
  ImportJob,
  ImportMode,
  ImportRow,
  ImportRowCode,
  ImportsPort,
  Page,
  Result,
} from './types';

/**
 * In-memory bulk import with the semantics of the real backend (`packages/domain/imports`): a validation (`dry_run`)
 * creates nothing and is stored as a job; `commit_valid` imports the valid rows and reports the others; `commit_all`
 * imports nothing when any row is invalid (job `failed`, valid rows `skipped`); a commit needs an idempotency key and
 * the same key with the same file returns the stored job (`replayed: true`) while another file or mode is a 409
 * `conflict`; a `dryRunJobId` must belong to a validation of the same file (409 otherwise, 404 when unknown); a row
 * issue names the columns and never a value; a cell that starts with `=` or `@` (or `+` / `-` outside a phone) is
 * `formula_injection`. Records are created through the same mock stores as an individual create. Permissions of the
 * operations themselves (`create`, plus `view_pii` for personal-data columns) are enforced by the caller (`mockApi`).
 */
export interface MockImportStore {
  readonly port: ImportsPort;
  /** Jobs as stored, newest first, for assertions. */
  snapshot(): readonly ImportJob[];
}

export interface MockImportEnvironment {
  /** Whether an area id is an active area of the company. */
  readonly isActiveArea: (areaId: string) => boolean;
  /** Unique keys the company already holds, as `column:value` (economic number, plate, VIN; employee number). */
  readonly existingKeys: (entity: ImportEntity) => ReadonlySet<string>;
  /** Creates the record the way an individual create does; the caller's stores validate it. */
  readonly createRecord: (
    entity: ImportEntity,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<Result<{ readonly id: string }>>;
  /** The signed-in user, recorded in the job and the history. */
  readonly actorId: () => string;
}

const NOW = '2026-10-06T12:00:00.000Z';
let correlation = 0;

function failure(status: ApiError['status'], code: string, message: string): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: { code, status, message, correlationId: `corr-mock-import-${correlation}` },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');
const notFound = () => failure(404, 'not_found', 'Resource not found');
const conflict = () => failure(409, 'conflict', 'Conflict');

type RawRow = Readonly<Record<string, string | number | null>>;

const INPUT_KEYS = ['entity', 'mode', 'idempotencyKey', 'dryRunJobId', 'rows', 'csv'];
const PHONE_LIKE = /^\+[0-9][0-9 ().-]{5,24}$/;
const DIGITS = /^\d{1,7}$/;

const isFormula = (column: string, text: string): boolean =>
  /^[=@]/.test(text) || (/^[+-]/.test(text) && !(column === 'phone' && PHONE_LIKE.test(text)));

interface Issue {
  readonly code: ImportRowCode;
  readonly columns: readonly string[];
}

/** The columns of a request that hold personal data (what the caller needs `view_pii` for). */
export function importWritesPii(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const fields = input as Readonly<Record<string, unknown>>;
  if (fields['entity'] !== 'employee') return false;
  const pii = templateOf('employee').pii;
  if (typeof fields['csv'] === 'string') {
    const header = parseCsv(fields['csv'])?.[0] ?? [];
    return header.some((name) => pii.includes(name.trim()));
  }
  const rows = fields['rows'];
  return (
    Array.isArray(rows) &&
    rows.some(
      (row) => typeof row === 'object' && row !== null && Object.keys(row).some((key) => pii.includes(key)),
    )
  );
}

function rowsOf(input: Readonly<Record<string, unknown>>, entity: ImportEntity): RawRow[] | null {
  const allowed = columnsOf(entity);
  if (typeof input['csv'] === 'string') {
    if (input['csv'].length > MAX_CSV_LENGTH) return null;
    const table = parseCsv(input['csv']);
    const [header, ...body] = table ?? [];
    if (!header || header.length > MAX_HEADER_COLUMNS) return null;
    const names = header.map((name) => name.trim());
    if (
      new Set(names).size !== names.length ||
      names.some((name) => !allowed.includes(name)) ||
      templateOf(entity).required.some((name) => !names.includes(name))
    )
      return null;
    if (body.some((cells) => cells.length !== names.length)) return null;
    return body.map((cells) => Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ''])));
  }
  const rows = input['rows'];
  if (!Array.isArray(rows)) return null;
  const list: RawRow[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
    if (Object.keys(row).some((key) => !allowed.includes(key))) return null;
    list.push(row as RawRow);
  }
  return list;
}

/** The create request of a row, or the issue that makes it invalid (columns only). */
function prepare(
  entity: ImportEntity,
  raw: RawRow,
): { input: Record<string, unknown> } | { issue: Issue } {
  const template = templateOf(entity);
  const values: Record<string, unknown> = {};
  const formulas: string[] = [];
  const bad: string[] = [];
  for (const column of columnsOf(entity)) {
    const cell = Object.hasOwn(raw, column) ? raw[column] : undefined;
    if (cell === undefined || cell === null) continue;
    const text = typeof cell === 'number' ? String(cell) : cell.trim();
    if (typeof cell === 'number' && (!Number.isSafeInteger(cell) || cell < 0)) {
      bad.push(column);
      continue;
    }
    if (text === '') continue;
    if (text.length > MAX_CELL_LENGTH) bad.push(column);
    else if (isFormula(column, text)) formulas.push(column);
    else values[column] = text;
  }
  if (formulas.length > 0) return { issue: { code: 'formula_injection', columns: formulas } };
  const missing = template.required.filter(
    (column) => !Object.hasOwn(values, column) && !bad.includes(column),
  );
  if (missing.length > 0) return { issue: { code: 'missing_value', columns: missing } };
  for (const column of entity === 'vehicle' ? ['year', 'odometerKm'] : []) {
    const text = values[column];
    if (typeof text !== 'string') continue;
    if (DIGITS.test(text)) values[column] = Number(text);
    else bad.push(column);
  }
  if (entity === 'vehicle') {
    if (typeof values['economicNumber'] === 'string' && !ECONOMIC_NUMBER.test(values['economicNumber']))
      bad.push('economicNumber');
    if (typeof values['plate'] === 'string' && !PLATE.test(normalizePlate(values['plate'])))
      bad.push('plate');
  } else {
    if (!['driver', 'dispatcher', 'other'].includes(String(values['kind']))) bad.push('kind');
    for (const column of ['firstName', 'lastName'])
      if (typeof values[column] === 'string' && !NAME.test(values[column])) bad.push(column);
  }
  if (bad.length > 0) return { issue: { code: 'invalid_value', columns: [...new Set(bad)] } };
  return { input: values };
}

/** Unique keys of a prepared row, as `column:value`. */
function keysOf(entity: ImportEntity, input: Readonly<Record<string, unknown>>): string[] {
  const keys: string[] = [];
  const push = (column: string, value: unknown, normalize = (text: string) => text) => {
    if (typeof value === 'string') keys.push(`${column}:${normalize(value)}`);
  };
  if (entity === 'vehicle') {
    push('economicNumber', input['economicNumber'], (text) => text.toLowerCase());
    push('plate', input['plate'], (text) => normalizePlate(text));
    push('vin', input['vin'], (text) => text.toUpperCase());
  } else push('employeeNumber', input['employeeNumber'], (text) => text.toLowerCase());
  return keys;
}

/** Stable text of the rows: personal-data columns count only as present or absent, never as a value. */
function fingerprintOf(entity: ImportEntity, rows: readonly RawRow[]): string {
  const pii = templateOf(entity).pii;
  return JSON.stringify([
    entity,
    rows.map((row) =>
      Object.keys(row)
        .sort()
        .map((column) => {
          const cell = row[column];
          const text = typeof cell === 'string' ? cell.trim() : cell === null ? '' : String(cell);
          return [column, pii.includes(column) ? text !== '' : text];
        }),
    ),
  ]);
}

interface Stored {
  job: ImportJob;
  rows: ImportRow[];
  events: ImportEvent[];
  fingerprint: string;
  key: string | null;
}

const offsetOf = (cursor: string | undefined): number =>
  cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(cursor)?.[1]);

function pageOf<T>(
  all: readonly T[],
  query: { limit?: number; cursor?: string },
  sort: Page<T>['sort'],
): Result<Page<T>> {
  const limit = query.limit ?? 25;
  const offset = offsetOf(query.cursor);
  if (![25, 50, 100].includes(limit) || !Number.isSafeInteger(offset)) return badRequest();
  const next = offset + limit;
  return ok({
    items: all.slice(offset, next),
    nextCursor: next < all.length ? `mock:${next}` : null,
    total: all.length,
    sort,
  });
}

export function createMockImportStore(
  env: MockImportEnvironment,
  seed: readonly DemoImport[] = demoImports(),
  now: () => string = () => NOW,
): MockImportStore {
  // Newest first, like the listing.
  let stored: Stored[] = seed.map((entry) => ({
    job: { ...entry.job },
    rows: entry.rows.map((row) => ({ ...row })),
    events: entry.events.map((event) => ({ ...event })),
    fingerprint: `seed:${entry.job.id}`,
    key: entry.job.mode === 'dry_run' ? null : `seed-key-${entry.job.id}`,
  }));
  let sequence = stored.length;

  const find = (id: string) => stored.find((item) => item.job.id === id);

  const port: ImportsPort = {
    list: async (query = {}) => {
      if (
        (query.entity !== undefined && !isEntity(query.entity)) ||
        (query.status !== undefined && !BFF_IMPORT_STATUSES.includes(query.status))
      )
        return badRequest();
      const matches = stored
        .filter(
          (item) =>
            (query.entity === undefined || item.job.entity === query.entity) &&
            (query.status === undefined || item.job.status === query.status),
        )
        .map((item) => ({ ...item.job }));
      return pageOf(matches, query, { field: 'createdAt', direction: 'desc' });
    },
    get: async (id) => {
      const item = find(id);
      return item ? ok({ ...item.job }) : notFound();
    },
    rows: async (id, query = {}) => {
      const item = find(id);
      if (!item) return notFound();
      if (query.outcome !== undefined && !BFF_IMPORT_OUTCOMES.includes(query.outcome))
        return badRequest();
      return pageOf(
        item.rows
          .filter((row) => query.outcome === undefined || row.outcome === query.outcome)
          .sort((a, b) => a.rowNumber - b.rowNumber),
        query,
        { field: 'rowNumber', direction: 'asc' },
      );
    },
    history: async (id, query = {}) => {
      const item = find(id);
      if (!item) return notFound();
      return pageOf([...item.events].sort((a, b) => b.seq - a.seq), query, {
        field: 'seq',
        direction: 'desc',
      });
    },
    submit: async (input: ImportInput) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      const { entity, mode, idempotencyKey: key, dryRunJobId } = fields;
      if (!Object.keys(fields).every((name) => INPUT_KEYS.includes(name))) return badRequest();
      if (!isEntity(entity) || !isMode(mode)) return badRequest();
      if (Object.hasOwn(fields, 'rows') === Object.hasOwn(fields, 'csv')) return badRequest();
      if (key !== undefined && (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)))
        return badRequest();
      if (mode !== 'dry_run' && key === undefined) return badRequest();
      if (dryRunJobId !== undefined && (mode === 'dry_run' || typeof dryRunJobId !== 'string' || !OPAQUE_ID.test(dryRunJobId)))
        return badRequest();
      const raw = rowsOf(fields, entity);
      if (raw === null || raw.length < 1 || raw.length > MAX_ROWS) return badRequest();
      const fingerprint = fingerprintOf(entity, raw);

      if (typeof key === 'string') {
        const earlier = stored.find((item) => item.key === key);
        if (earlier) {
          if (earlier.fingerprint !== fingerprint || earlier.job.mode !== mode) return conflict();
          if (earlier.job.finishedAt === null) return conflict();
          return ok({ job: { ...earlier.job }, replayed: true });
        }
      }
      if (typeof dryRunJobId === 'string') {
        const preview = find(dryRunJobId);
        if (!preview) return notFound();
        if (preview.fingerprint !== fingerprint) return conflict();
      }

      // Row by row: the issue of the row, or the keys it would take (checked in the file and against the company).
      const taken = env.existingKeys(entity);
      const seen = new Set<string>();
      const prepared = raw.map((row) => {
        const outcome = prepare(entity, row);
        if ('issue' in outcome) return { issue: outcome.issue, input: null };
        const area = String(outcome.input['areaId']);
        if (!env.isActiveArea(area))
          return { issue: { code: 'invalid_area', columns: ['areaId'] } as Issue, input: null };
        const keys = keysOf(entity, outcome.input);
        const inFile = keys.find((item) => seen.has(item));
        if (inFile)
          return {
            issue: { code: 'duplicate_in_file', columns: [inFile.split(':')[0] as string] } as Issue,
            input: null,
          };
        keys.forEach((item) => seen.add(item));
        const existing = keys.find((item) => taken.has(item));
        if (existing)
          return {
            issue: { code: 'duplicate', columns: [existing.split(':')[0] as string] } as Issue,
            input: null,
          };
        return { issue: null, input: outcome.input };
      });

      sequence += 1;
      const id = `imp-nueva-${sequence}`;
      const at = now();
      const actor = env.actorId();
      const valid = prepared.filter((row) => row.issue === null).length;
      const invalid = prepared.length - valid;
      const commit = mode === 'commit_valid' || (mode === 'commit_all' && invalid === 0);
      const results: ImportRow[] = [];
      let imported = 0;
      for (const [index, row] of prepared.entries()) {
        const rowNumber = index + 1;
        if (row.issue) {
          results.push({
            rowNumber,
            outcome: 'invalid',
            code: row.issue.code,
            columns: [...row.issue.columns],
            entityId: null,
            at,
          });
        } else if (!commit) {
          results.push({
            rowNumber,
            outcome: mode === 'dry_run' ? 'valid' : 'skipped',
            code: null,
            columns: [],
            entityId: null,
            at,
          });
        } else {
          const created = await env.createRecord(entity, row.input as Record<string, unknown>);
          if (created.ok) {
            imported += 1;
            results.push({
              rowNumber,
              outcome: 'imported',
              code: null,
              columns: [],
              entityId: created.value.id,
              at,
            });
          } else {
            const code: ImportRowCode =
              created.error.code === 'duplicate'
                ? 'duplicate'
                : created.error.code === 'invalid_area'
                  ? 'invalid_area'
                  : 'invalid_value';
            results.push({
              rowNumber,
              outcome: 'invalid',
              code,
              columns: (created.error.fieldErrors ?? []).map((item) =>
                item.field.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase()),
              ),
              entityId: null,
              at,
            });
          }
        }
      }
      const status: ImportJob['status'] =
        mode === 'dry_run' ? 'validated' : mode === 'commit_all' && invalid > 0 ? 'failed' : 'imported';
      const stillValid = results.filter((row) => row.outcome !== 'invalid').length;
      const job: ImportJob = {
        id,
        entity,
        mode: mode as ImportMode,
        status,
        totalRows: prepared.length,
        validRows: stillValid,
        invalidRows: prepared.length - stillValid,
        importedRows: imported,
        createdBy: actor,
        createdAt: at,
        finishedAt: at,
        version: 2,
      };
      const events: ImportEvent[] = [
        { seq: 1, kind: 'started', actorId: actor, acceptedRows: null, rejectedRows: null, at },
        {
          seq: 2,
          kind: status === 'validated' ? 'validated' : status === 'failed' ? 'failed' : 'imported',
          actorId: actor,
          acceptedRows: job.validRows,
          rejectedRows: job.invalidRows,
          at,
        },
      ];
      stored = [
        { job, rows: results, events, fingerprint, key: typeof key === 'string' ? key : null },
        ...stored,
      ];
      return ok({ job: { ...job }, replayed: false });
    },
  };

  return { port, snapshot: () => stored.map((item) => ({ ...item.job })) };
}
