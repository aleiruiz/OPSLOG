import { randomUUID } from 'node:crypto';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../../documents/src/index.js';
import { isImportEntity, isImportStatus, isRowOutcome } from './types.js';
import type {
  ImportEntity,
  ImportEvent,
  ImportEventKind,
  ImportJob,
  ImportRowResult,
  ImportStatus,
  RowIssue,
  RowOutcome,
} from './types.js';
import { ImportError, invalid } from './errors.js';
import { MAX_ROWS } from './columns.js';
import { guardId, isInteger, parseSubmission } from './parsing.js';
import type { Submission } from './parsing.js';
import { fingerprintOf, issue, prepareRow } from './rows.js';
import type { PreparedRow } from './rows.js';
import type {
  ImportEventSlice,
  ImportJobFilter,
  ImportJobSlice,
  ImportRowSlice,
  ImportStore,
  ImportWindow,
} from './store.js';
import { DEFAULT_LEASE_MS } from './ports.js';
import type {
  ImportHistoryQuery,
  ImportListQuery,
  ImportObserver,
  ImportRowsQuery,
  ImportServiceOptions,
  ImportTarget,
  Submitted,
} from './ports.js';

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

  /** A stamp strictly after `previous` (and not before now), so a claim always changes `updatedAt`. */
  private stampAfter(previous: string): string {
    return new Date(Math.max(this.now().getTime(), Date.parse(previous) + 1)).toISOString();
  }

  /**
   * Claims a running job for this executor (or renews the claim): one conditional write that only
   * one of the executors holding the same stamp wins. The loser gets `conflict`.
   */
  private async claim(job: ImportJob): Promise<ImportJob> {
    const updatedAt = this.stampAfter(job.updatedAt);
    if (!(await this.store.claimJob(job.tenantId, job.id, job.updatedAt, updatedAt)))
      throw new ImportError('conflict');
    return { ...job, updatedAt };
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
    let held = job;
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
        // Renew the claim as the run goes on, so a long run is not taken over; a lost claim stops it.
        if (this.now().getTime() - Date.parse(held.updatedAt) >= this.leaseMs / 4)
          held = await this.claim(held);
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
    return this.finish(held);
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
    // Someone may still be running it (the lease is measured from its last claim or renewal): not ours to run twice.
    if (!created && now.getTime() - Date.parse(job.updatedAt) < this.leaseMs)
      throw new ImportError('conflict');
    // Taking over an expired lease is a conditional write: of two retries only one executes.
    const mine = created ? job : await this.claim(job);
    return { job: await this.execute(actorId, mine, submission, observer), replayed: false };
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
