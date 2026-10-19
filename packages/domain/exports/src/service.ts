import { createHash, randomUUID } from 'node:crypto';
import type { Permission } from '../../identity/src/index.js';
import type { ExportCell, ExportTable } from '../../../platform/exports/src/index.js';
import {
  ReportError,
  SENSITIVITY_PERMISSION,
  type ReportContext,
  type ReportEngine,
  type ReportPlan,
  type ReportRequest,
  type ReportResult,
} from '../../reports/src/index.js';
import { ExportError } from './errors.js';
import type {
  ArtifactStore,
  ExportAuditEntry,
  ExportAuthority,
  ExportCompany,
  ExportJobStore,
  ExportSlice,
  Renderer,
} from './ports.js';
import {
  DEFAULT_LIST_LIMIT,
  DIRECT_BUDGET_MS,
  DIRECT_MAX_ROWS,
  EXPORT_TTL_DAYS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_LIST_LIMIT,
  MAX_OPEN_PER_ACTOR,
  MAX_OPEN_PER_TENANT,
  type ExportFailure,
  type ExportJob,
} from './types.js';
import type { ReportFormat } from '../../reports/src/index.js';

const DAY_MS = 86_400_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** The person asking, as the API established it from the session. */
export interface ExportActor {
  readonly tenantId: string;
  /** Identity subject. */
  readonly actorId: string;
  /** Digest of the session. */
  readonly sessionId: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly correlationId: string;
}

export interface ExportInput extends ReportRequest {
  readonly reportId: string;
  readonly format: ReportFormat;
  readonly idempotencyKey?: string | undefined;
}

export interface ExportDownload {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly fileName: string;
}

export interface ExportServiceDeps {
  readonly store: ExportJobStore;
  readonly engine: ReportEngine;
  readonly artifacts: ArtifactStore;
  readonly render: Renderer;
  readonly authority: ExportAuthority;
  readonly audit: (entry: ExportAuditEntry) => Promise<void>;
  readonly company: ExportCompany;
  readonly now: () => Date;
  readonly newId?: () => string;
  /** Monotonic milliseconds, to estimate whether a report fits the direct budget. */
  readonly clock?: () => number;
  readonly directMaxRows?: number;
  readonly directBudgetMs?: number;
}

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The view of a job: a completed one past its date reads `expired` even before the purge ran. */
export function viewOf(job: ExportJob, now: Date): ExportJob {
  return job.status === 'completed' && job.expiresAt !== null && job.expiresAt <= now.toISOString()
    ? { ...job, status: 'expired' }
    : job;
}

/** Permission the file needs to be read again: the columns it holds may be sensitive. */
function missingPermission(
  plan: Pick<ReportPlan, 'definition' | 'columns'>,
  permissions: ReadonlySet<Permission>,
): boolean {
  if (!permissions.has('export') || !permissions.has(plan.definition.view)) return true;
  return plan.columns.some(
    (column) => column.sensitivity && !permissions.has(SENSITIVITY_PERMISSION[column.sensitivity]),
  );
}

/**
 * Report exports: direct up to 5.000 rows when the estimate fits 10 s, a job of the worker otherwise.
 * A file is never produced without checking, at that moment, that the person still has the session,
 * the membership and the permissions for every column of the file; the same check guards the download.
 */
export class ExportService {
  private readonly newId: () => string;
  private readonly clock: () => number;

  public constructor(private readonly deps: ExportServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.clock = deps.clock ?? (() => performance.now());
  }

  /** Asks for a file. The result is a completed job (direct) or a queued one (the worker will run it). */
  public async request(
    actor: ExportActor,
    input: ExportInput,
  ): Promise<{ readonly job: ExportJob; readonly replayed: boolean }> {
    if (!actor.permissions.has('export')) throw new ExportError('forbidden');
    const { engine, store } = this.deps;
    const plan = engine.plan(input.reportId, actor.permissions, input);
    if (!plan.definition.formats.includes(input.format))
      throw new ReportError('invalid_input', 'format');
    if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(input.idempotencyKey))
      throw new ExportError('invalid_input', 'idempotencyKey');
    const requestHash = hash([
      input.reportId,
      input.format,
      [...plan.filters].sort(([a], [b]) => a.localeCompare(b)),
      plan.columns.map((c) => c.id),
      plan.sort,
    ]);
    if (input.idempotencyKey !== undefined) {
      const earlier = await store.findByKey(actor.tenantId, actor.actorId, input.idempotencyKey);
      if (earlier) {
        if (earlier.requestHash !== requestHash) throw new ExportError('idempotency_conflict');
        return { job: viewOf(earlier, this.deps.now()), replayed: true };
      }
    }
    const open = await store.countOpen(actor.tenantId, actor.actorId);
    if (open.actor >= MAX_OPEN_PER_ACTOR || open.tenant >= MAX_OPEN_PER_TENANT)
      throw new ExportError('too_many_open');

    const ctx = await engine.context(actor.tenantId, actor.permissions);
    const started = this.clock();
    const result = await engine.run(ctx, plan);
    const elapsed = this.clock() - started;
    const direct =
      result.total <= (this.deps.directMaxRows ?? DIRECT_MAX_ROWS) &&
      elapsed * 2 <= (this.deps.directBudgetMs ?? DIRECT_BUDGET_MS);

    const now = this.deps.now();
    const base: ExportJob = {
      id: this.newId(),
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      sessionId: actor.sessionId,
      reportId: input.reportId,
      format: input.format,
      filters: Object.fromEntries(
        [...plan.filters].map(([id]) => [id, (input.filters ?? {})[id] as string]),
      ),
      columns: plan.columns.map((c) => c.id),
      sort: plan.sort.column,
      direction: plan.sort.direction,
      mode: direct ? 'direct' : 'job',
      status: direct ? 'running' : 'queued',
      rowCount: null,
      byteSize: null,
      sha256: null,
      fileName: null,
      failure: null,
      idempotencyKey: input.idempotencyKey ?? null,
      requestHash,
      attempts: 0,
      createdAt: now.toISOString(),
      startedAt: direct ? now.toISOString() : null,
      finishedAt: null,
      expiresAt: null,
      leaseUntil: direct ? new Date(now.getTime() + LEASE_MS).toISOString() : null,
    };
    const inserted = await store.insert(base);
    if (!inserted.created) return { job: viewOf(inserted.job, now), replayed: true };
    if (!direct) return { job: inserted.job, replayed: false };
    const finished = await this.produce(inserted.job, ctx, plan, result, actor.correlationId);
    return { job: finished, replayed: false };
  }

  /** The worker's turn: runs the jobs of one company that are due. Returns how many it handled. */
  public async runDue(tenantId: string, limit = 2): Promise<number> {
    const claimed = await this.deps.store.claim(tenantId, this.deps.now(), LEASE_MS, limit);
    for (const job of claimed) await this.runClaimed(job);
    return claimed.length;
  }

  private async runClaimed(job: ExportJob): Promise<void> {
    const correlationId = `${job.tenantId}.export.${job.id}`;
    if (job.attempts > MAX_ATTEMPTS)
      return void (await this.fail(job, 'generation_failed', correlationId));
    const permissions = await this.deps.authority.check(job);
    // Session, membership and permissions as they are now: if they are gone, no data is produced.
    if (!permissions) return void (await this.fail(job, 'session_ended', correlationId));
    try {
      const plan = this.deps.engine.plan(job.reportId, permissions, {
        filters: job.filters,
        columns: job.columns,
        sort: job.sort,
        direction: job.direction,
      });
      // A reader who lost a sensitive column does not get a lighter file by surprise.
      if (plan.columns.length !== job.columns.length || missingPermission(plan, permissions))
        return void (await this.fail(job, 'permission_revoked', correlationId));
      const ctx = await this.deps.engine.context(job.tenantId, permissions);
      const result = await this.deps.engine.run(ctx, plan);
      await this.produce(job, ctx, plan, result, correlationId);
    } catch (error) {
      if (error instanceof ReportError && error.code === 'too_many_rows')
        return void (await this.fail(job, 'too_many_rows', correlationId));
      if (
        error instanceof ReportError &&
        (error.code === 'forbidden' || error.code === 'invalid_input')
      )
        return void (await this.fail(job, 'permission_revoked', correlationId));
      // A transient failure goes back to the queue until the tries run out.
      if (job.attempts >= MAX_ATTEMPTS)
        return void (await this.fail(job, 'generation_failed', correlationId));
      await this.deps.store.transition({ ...job, status: 'queued', leaseUntil: null }, 'running');
    }
  }

  /** Renders, stores and completes a running job. Failures after the file exists remove the file. */
  private async produce(
    job: ExportJob,
    ctx: ReportContext,
    plan: ReportPlan,
    result: ReportResult,
    correlationId: string,
  ): Promise<ExportJob> {
    const now = this.deps.now();
    try {
      const author = await this.deps.company.author(job.tenantId, job.actorId);
      const table: ExportTable = {
        title: plan.definition.title,
        columns: result.columns.map((c) => ({ label: c.label, kind: c.kind })),
        rows: result.rows.map((row): ExportCell[] => result.columns.map((c) => row[c.id] ?? null)),
        meta: {
          companyName: this.deps.company.name(job.tenantId),
          generatedAt: now,
          timeZone: ctx.timeZone,
          authorLabel: author,
          filterNames: plan.definition.filters
            .filter((f) => plan.filters.has(f.id))
            .map((f) => f.label),
        },
      };
      const rendered = await this.deps.render(job.format, table);
      const sha256 = createHash('sha256').update(rendered.bytes).digest('hex');
      await this.deps.artifacts.put(
        job.tenantId,
        job.id,
        rendered.bytes,
        rendered.contentType,
        sha256,
      );
      const done: ExportJob = {
        ...job,
        status: 'completed',
        rowCount: result.total,
        byteSize: rendered.bytes.byteLength,
        sha256,
        fileName: `${job.reportId}-${ctx.today.replaceAll('-', '')}.${rendered.extension}`,
        finishedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + EXPORT_TTL_DAYS * DAY_MS).toISOString(),
        leaseUntil: null,
      };
      const written = await this.deps.store.transition(done, 'running', {
        type: 'export.completed',
        payload: {
          jobId: job.id,
          reportId: job.reportId,
          format: job.format,
          rowCount: result.total,
        },
      });
      if (!written) {
        await this.deps.artifacts.delete(job.tenantId, job.id);
        return job;
      }
      await this.audit(done, 'export.completed', correlationId);
      return done;
    } catch (error) {
      await this.deps.artifacts.delete(job.tenantId, job.id).catch(() => undefined);
      if (job.mode === 'direct') return this.fail(job, 'generation_failed', correlationId);
      throw error;
    }
  }

  private async fail(
    job: ExportJob,
    failure: ExportFailure,
    correlationId: string,
  ): Promise<ExportJob> {
    const now = this.deps.now();
    const failed: ExportJob = {
      ...job,
      status: 'failed',
      failure,
      finishedAt: now.toISOString(),
      leaseUntil: null,
    };
    const written = await this.deps.store.transition(failed, 'running', {
      type: 'export.failed',
      payload: { jobId: job.id, reportId: job.reportId, format: job.format, code: failure },
    });
    if (written) await this.audit(failed, 'export.failed', correlationId);
    return written ? failed : job;
  }

  private audit(job: ExportJob, action: string, correlationId: string): Promise<void> {
    // The audit trail keeps the action, the job and the actor; report, format, rows and the names of
    // the filters are on the job itself, which the entity id points to.
    return this.deps.audit({
      tenantId: job.tenantId,
      actorId: job.actorId,
      action: `${action}:${job.reportId}:${job.format}`,
      jobId: job.id,
      correlationId,
    });
  }

  /** Status of one job of the person; another person's job, or another company's, is not found. */
  public async get(actor: ExportActor, id: string): Promise<ExportJob> {
    const job = await this.deps.store.find(actor.tenantId, id);
    if (!job || job.actorId !== actor.actorId) throw new ExportError('not_found');
    return viewOf(job, this.deps.now());
  }

  /** «Mis exportaciones»: the person's own, newest first. */
  public async list(
    actor: ExportActor,
    window: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<ExportSlice> {
    const limit = window.limit ?? DEFAULT_LIST_LIMIT;
    const offset = window.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIST_LIMIT ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new ExportError('invalid_input', 'limit');
    const slice = await this.deps.store.listByActor(actor.tenantId, actor.actorId, {
      limit,
      offset,
    });
    return { total: slice.total, items: slice.items.map((job) => viewOf(job, this.deps.now())) };
  }

  /**
   * The bytes of a finished file, through the authenticated proxy. The permissions are checked again
   * now, for every column the file holds; a refusal is audited. Past its date, the file is gone (410).
   */
  public async download(actor: ExportActor, id: string): Promise<ExportDownload> {
    const job = await this.deps.store.find(actor.tenantId, id);
    if (!job || job.actorId !== actor.actorId) throw new ExportError('not_found');
    const now = this.deps.now();
    const current = viewOf(job, now);
    if (current.status === 'expired') {
      await this.expire(job);
      throw new ExportError('expired');
    }
    if (current.status !== 'completed') throw new ExportError('not_ready');
    const definition = this.deps.engine.catalog.get(job.reportId);
    const plan = definition
      ? {
          definition,
          columns: definition.columns.filter((column) => job.columns.includes(column.id)),
        }
      : null;
    if (!plan || missingPermission(plan, actor.permissions)) {
      await this.audit(job, 'export.download_denied', actor.correlationId);
      throw new ExportError('forbidden');
    }
    const bytes = await this.deps.artifacts.get(job.tenantId, job.id);
    if (!bytes) {
      // Memory storage lost it on restart: the job reads as expired from now on.
      await this.expire(job);
      throw new ExportError('expired');
    }
    await this.audit(job, 'export.downloaded', actor.correlationId);
    return {
      bytes,
      contentType: CONTENT_TYPE[job.format],
      fileName: job.fileName ?? `${job.reportId}.${job.format}`,
    };
  }

  private async expire(job: ExportJob): Promise<void> {
    await this.deps.artifacts.delete(job.tenantId, job.id).catch(() => undefined);
    await this.deps.store.transition({ ...job, status: 'expired' }, 'completed');
  }

  /** The purge job: removes the files past their date and marks the jobs `expired`. */
  public async purge(tenantId: string, limit = 100): Promise<number> {
    const due = await this.deps.store.expired(tenantId, this.deps.now(), limit);
    for (const job of due) await this.expire(job);
    return due.length;
  }
}

const CONTENT_TYPE: Readonly<Record<ReportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};
