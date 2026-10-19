import 'reflect-metadata';
import { LessThanOrEqual, type DataSource, type EntityManager } from 'typeorm';
import { MySqlTenantOutboxStore } from '../../audit/src/index.js';
import type { OutboxTransaction } from '../../../platform/outbox/src/index.js';
import {
  exportEnvelope,
  type ExportEvent,
  type ExportJob,
  type ExportJobStore,
  type ExportSlice,
  type ExportStatus,
  type ExportWindow,
} from '../../../domain/exports/src/index.js';
import type { ReportFormat } from '../../../domain/reports/src/index.js';
import { EXPORT_RUNTIME_ACCOUNT } from './data-source.js';
import { ExportJobEntity } from './entities.js';

/** Where the event of a finished job is written; the tenant outbox, unless a test injects its own. */
export interface ExportOutbox {
  transaction<R>(manager: unknown, work: (tx: OutboxTransaction) => R | Promise<R>): Promise<R>;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());
const date = (value: string | null): Date | null => (value === null ? null : new Date(value));
const DUPLICATE_KEY = 1062;

function toJob(row: ExportJobEntity): ExportJob {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actorId: row.actorId,
    sessionId: row.sessionId,
    reportId: row.reportId,
    format: row.format as ReportFormat,
    filters: row.filters,
    columns: row.columns,
    sort: row.sort,
    direction: row.direction as 'asc' | 'desc',
    mode: row.mode as ExportJob['mode'],
    status: row.status as ExportStatus,
    rowCount: row.rowCount,
    byteSize: row.byteSize,
    sha256: row.sha256,
    fileName: row.fileName,
    failure: row.failure as ExportJob['failure'],
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    expiresAt: iso(row.expiresAt),
    leaseUntil: iso(row.leaseUntil),
  };
}

function toRow(job: ExportJob): ExportJobEntity {
  return Object.assign(new ExportJobEntity(), {
    tenantId: job.tenantId,
    id: job.id,
    actorId: job.actorId,
    sessionId: job.sessionId,
    reportId: job.reportId,
    format: job.format,
    filters: { ...job.filters },
    columns: [...job.columns],
    sort: job.sort,
    direction: job.direction,
    mode: job.mode,
    status: job.status,
    rowCount: job.rowCount,
    byteSize: job.byteSize,
    sha256: job.sha256,
    fileName: job.fileName,
    failure: job.failure,
    idempotencyKey: job.idempotencyKey,
    requestHash: job.requestHash,
    attempts: job.attempts,
    createdAt: new Date(job.createdAt),
    startedAt: date(job.startedAt),
    finishedAt: date(job.finishedAt),
    expiresAt: date(job.expiresAt),
    leaseUntil: date(job.leaseUntil),
  });
}

/** TypeORM adapter of the export jobs. Every statement names the company; none crosses it. */
export class TypeOrmExportJobStore implements ExportJobStore {
  private readonly outbox: ExportOutbox;
  public constructor(
    private readonly dataSource: DataSource,
    outbox?: ExportOutbox,
    private readonly now: () => Date = () => new Date(),
  ) {
    const username = (dataSource.options as { username?: string }).username ?? '';
    if (!EXPORT_RUNTIME_ACCOUNT.test(username))
      throw new Error('Export store requires its restricted runtime account');
    this.outbox =
      outbox ??
      new MySqlTenantOutboxStore(
        () => [],
        () => this.dataSource,
        () => this.dataSource,
      );
  }

  public async insert(job: ExportJob) {
    try {
      await this.dataSource.getRepository(ExportJobEntity).insert(toRow(job));
      return { job, created: true };
    } catch (error) {
      const errno =
        (error as { driverError?: { errno?: number }; errno?: number }).driverError?.errno ??
        (error as { errno?: number }).errno;
      if (errno !== DUPLICATE_KEY || job.idempotencyKey === null) throw error;
      const same = await this.findByKey(job.tenantId, job.actorId, job.idempotencyKey);
      if (!same) throw error;
      return { job: same, created: false };
    }
  }

  public async find(tenantId: string, id: string) {
    const row = await this.dataSource.getRepository(ExportJobEntity).findOneBy({ tenantId, id });
    return row ? toJob(row) : null;
  }

  public async findByKey(tenantId: string, actorId: string, key: string) {
    const row = await this.dataSource
      .getRepository(ExportJobEntity)
      .findOneBy({ tenantId, actorId, idempotencyKey: key });
    return row ? toJob(row) : null;
  }

  public async listByActor(
    tenantId: string,
    actorId: string,
    window: ExportWindow,
  ): Promise<ExportSlice> {
    const [rows, total] = await this.dataSource.getRepository(ExportJobEntity).findAndCount({
      where: { tenantId, actorId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: window.limit,
      skip: window.offset,
    });
    return { items: rows.map(toJob), total };
  }

  public async countOpen(tenantId: string, actorId: string) {
    const rows = (await this.dataSource.query(
      `SELECT actor_id, COUNT(*) AS open FROM \`opslog_export_jobs\` WHERE company_id = ? AND status IN ('queued','running') GROUP BY actor_id`,
      [tenantId],
    )) as { actor_id: string; open: string | number }[];
    return {
      tenant: rows.reduce((sum, row) => sum + Number(row.open), 0),
      actor: Number(rows.find((row) => row.actor_id === actorId)?.open ?? 0),
    };
  }

  public async claim(tenantId: string, now: Date, leaseMs: number, limit: number) {
    const repository = this.dataSource.getRepository(ExportJobEntity);
    const due = await repository
      .createQueryBuilder('j')
      .where('j.company_id = :tenantId', { tenantId })
      .andWhere("(j.status = 'queued' OR (j.status = 'running' AND j.lease_until <= :now))", {
        now,
      })
      .orderBy('j.created_at', 'ASC')
      .limit(limit)
      .getMany();
    const claimed: ExportJob[] = [];
    for (const row of due) {
      const result = await repository.update(
        row.status === 'queued'
          ? { tenantId, id: row.id, status: 'queued' }
          : { tenantId, id: row.id, status: 'running', leaseUntil: LessThanOrEqual(now) },
        {
          status: 'running',
          attempts: () => 'attempts + 1',
          startedAt: now,
          leaseUntil: new Date(now.getTime() + leaseMs),
        },
      );
      if (result.affected !== 1) continue;
      const fresh = await repository.findOneBy({ tenantId, id: row.id });
      if (fresh) claimed.push(toJob(fresh));
    }
    return claimed;
  }

  public async transition(next: ExportJob, expected: ExportStatus, event?: ExportEvent) {
    const row = toRow(next);
    return this.dataSource.transaction('READ COMMITTED', async (manager: EntityManager) => {
      const result = await manager.update(
        ExportJobEntity,
        { tenantId: next.tenantId, id: next.id, status: expected },
        {
          status: row.status,
          rowCount: row.rowCount,
          byteSize: row.byteSize,
          sha256: row.sha256,
          fileName: row.fileName,
          failure: row.failure,
          attempts: row.attempts,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          expiresAt: row.expiresAt,
          leaseUntil: row.leaseUntil,
        },
      );
      if (result.affected !== 1) return false;
      if (event)
        await this.outbox.transaction(manager, (tx) => {
          tx.enqueue(exportEnvelope(next, event, this.now()));
        });
      return true;
    });
  }

  public async expired(tenantId: string, now: Date, limit: number) {
    const rows = await this.dataSource.getRepository(ExportJobEntity).find({
      where: { tenantId, status: 'completed', expiresAt: LessThanOrEqual(now) },
      order: { expiresAt: 'ASC' },
      take: limit,
    });
    return rows.map(toJob);
  }
}
