import type { ApiError } from '@opslog/contracts';
import { BFF_IMPORT_OUTCOMES, BFF_IMPORT_STATUSES } from '@opslog/contracts';
import { demoImports, type DemoImport } from '../imports/fixtures';
import { IDEMPOTENCY_KEY, MAX_ROWS, isEntity, isMode } from '../imports/rules';
import { OPAQUE_ID } from '../vehicles/rules';
import {
  INPUT_KEYS,
  fingerprintOf,
  keysOf,
  prepare,
  rowsOf,
  type Issue,
} from './mockImportsSupport';
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
 * `conflict`; a `dryRunJobId` must belong to a completed `dry_run` in `validated` state with the same file
 * fingerprint (409 otherwise, 404 when unknown); a row
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
      return pageOf(
        [...item.events].sort((a, b) => b.seq - a.seq),
        query,
        {
          field: 'seq',
          direction: 'desc',
        },
      );
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
      if (
        dryRunJobId !== undefined &&
        (mode === 'dry_run' || typeof dryRunJobId !== 'string' || !OPAQUE_ID.test(dryRunJobId))
      )
        return badRequest();
      if (mode !== 'dry_run' && dryRunJobId === undefined) return badRequest();
      const raw = rowsOf(fields, entity);
      if (raw === null || raw.length < 1 || raw.length > MAX_ROWS) return badRequest();
      const fingerprint = fingerprintOf(entity, raw);

      if (mode !== 'dry_run') {
        const preview = find(dryRunJobId as string);
        if (!preview) return notFound();
        if (
          preview.job.mode !== 'dry_run' ||
          preview.job.status !== 'validated' ||
          preview.job.finishedAt === null ||
          preview.fingerprint !== fingerprint
        )
          return conflict();
      }

      if (typeof key === 'string') {
        const earlier = stored.find((item) => item.key === key);
        if (earlier) {
          if (earlier.fingerprint !== fingerprint || earlier.job.mode !== mode) return conflict();
          if (earlier.job.finishedAt === null) return conflict();
          return ok({ job: { ...earlier.job }, replayed: true });
        }
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
            issue: {
              code: 'duplicate_in_file',
              columns: [inFile.split(':')[0] as string],
            } as Issue,
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
        mode === 'dry_run'
          ? 'validated'
          : mode === 'commit_all' && invalid > 0
            ? 'failed'
            : 'imported';
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

export { importWritesPii } from './mockImportsSupport';
