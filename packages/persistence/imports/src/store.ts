import 'reflect-metadata';
import { type DataSource, type EntityManager, type FindOptionsWhere } from 'typeorm';
import {
  isImportEntity,
  isImportMode,
  isImportStatus,
  isRowIssueCode,
  isRowOutcome,
  type ImportEvent,
  type ImportEventKind,
  type ImportEventSlice,
  type ImportJob,
  type ImportJobFilter,
  type ImportJobSlice,
  type ImportRowResult,
  type ImportRowSlice,
  type ImportStore,
  type ImportWindow,
  type RowFilter,
} from '../../../domain/imports/src/index.js';
import { IMPORTS_RUNTIME_ACCOUNT } from './data-source.js';
import { appendLocalAuditAndDelivery, type AuditEvent } from '../../audit/src/index.js';
import { ImportEventEntity, ImportJobEntity, ImportRowEntity } from './entities.js';
import {
  ImportStoreError,
  isDuplicateKey,
  isLockContention,
  sanitizeStoreError,
  type ImportStoreErrorCode,
} from './errors.js';

/** Structured report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: ImportStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmImportStoreOptions {
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}

const integrity = (): never => {
  throw new ImportStoreError('integrity');
};

const EVENT_KINDS: readonly string[] = ['started', 'validated', 'imported', 'failed'];

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const toJob = (row: ImportJobEntity): ImportJob => ({
  id: row.id,
  tenantId: row.tenantId,
  entity: isImportEntity(row.entity) ? row.entity : integrity(),
  mode: isImportMode(row.mode) ? row.mode : integrity(),
  status: isImportStatus(row.status) ? row.status : integrity(),
  idempotencyKey: row.idempotencyKey,
  fingerprint: row.fingerprint,
  totalRows: row.totalRows,
  validRows: row.validRows,
  invalidRows: row.invalidRows,
  importedRows: row.importedRows,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  finishedAt: iso(row.finishedAt),
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

const toResult = (row: ImportRowEntity): ImportRowResult => ({
  tenantId: row.tenantId,
  jobId: row.jobId,
  rowNumber: row.rowNumber,
  outcome: isRowOutcome(row.outcome) ? row.outcome : integrity(),
  code: row.code === null ? null : isRowIssueCode(row.code) ? row.code : integrity(),
  columns: row.columnNames === null ? [] : row.columnNames.split(','),
  entityId: row.entityId,
  at: row.at.toISOString(),
});

const toEvent = (row: ImportEventEntity): ImportEvent => ({
  tenantId: row.tenantId,
  jobId: row.jobId,
  seq: row.seq,
  kind: EVENT_KINDS.includes(row.kind) ? (row.kind as ImportEventKind) : integrity(),
  actorId: row.actorId,
  acceptedRows: row.acceptedRows,
  rejectedRows: row.rejectedRows,
  at: row.at.toISOString(),
});

/** Columns that change when a job finishes (never the tenant, the id, the entity, the mode, the key or the fingerprint). */
const finishColumns = (job: ImportJob) => ({
  status: job.status,
  validRows: job.validRows,
  invalidRows: job.invalidRows,
  importedRows: job.importedRows,
  finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt),
  version: job.version,
  updatedAt: new Date(job.updatedAt),
});

const toJobRow = (job: ImportJob): ImportJobEntity => ({
  tenantId: job.tenantId,
  id: job.id,
  entity: job.entity,
  mode: job.mode,
  idempotencyKey: job.idempotencyKey,
  fingerprint: job.fingerprint,
  totalRows: job.totalRows,
  createdBy: job.createdBy,
  createdAt: new Date(job.createdAt),
  ...finishColumns(job),
});

const toResultRow = (result: ImportRowResult): ImportRowEntity => ({
  tenantId: result.tenantId,
  jobId: result.jobId,
  rowNumber: result.rowNumber,
  outcome: result.outcome,
  code: result.code,
  columnNames: result.columns.length === 0 ? null : result.columns.join(','),
  entityId: result.entityId,
  at: new Date(result.at),
});

const toEventRow = (event: ImportEvent): ImportEventEntity => ({
  tenantId: event.tenantId,
  jobId: event.jobId,
  seq: event.seq,
  kind: event.kind,
  actorId: event.actorId,
  acceptedRows: event.acceptedRows,
  rejectedRows: event.rejectedRows,
  at: new Date(event.at),
});

const auditEvent = (event: ImportEvent): AuditEvent => ({
  eventId: `${event.jobId}.event.${event.seq}`,
  tenantId: event.tenantId,
  action: `import.${event.kind}`,
  entityType: 'import_job',
  entityId: event.jobId,
  // Import events accept DATETIME(6); the shared audit store persists DATETIME(3), like this row
  // after conversion to a JavaScript Date. Keep audit time aligned with the persisted event.
  occurredAt: new Date(event.at).toISOString(),
  actor: { id: event.actorId, kind: 'user' },
  correlationId: `${event.jobId}.event.${event.seq}`,
  data: {},
});

/**
 * Persistent TypeORM/MySQL implementation of the `ImportStore` port.
 *
 * - Every statement names `company_id`: the primary keys, every index and every filter start with
 *   it, so a row of another company is unreachable, not merely hidden.
 * - The idempotency key is a unique key `(company_id, idempotency_key)`, not a read-then-write check:
 *   of two concurrent requests with the same key exactly one inserts the job, the other is told so.
 * - A job and its first event are one READ COMMITTED transaction, and so is its end (a conditional
 *   UPDATE on `(company_id, id, version)` plus the closing event). Row results and events are only
 *   inserted; a result that already exists is kept, never rewritten.
 * - No column holds an imported value, and the driver error is dropped: everything that leaves this
 *   class is the sanitized `ImportStoreError` (no SQL, no parameters).
 */
export class TypeOrmImportStore implements ImportStore {
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmImportStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Import store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !IMPORTS_RUNTIME_ACCOUNT.test(username))
      throw new Error('Import store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof ImportStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  /** One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. */
  private async transaction<T>(
    operation: string,
    work: (manager: EntityManager) => Promise<T>,
    onDuplicate?: () => T,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        if (onDuplicate && isDuplicateKey(error)) return onDuplicate();
        throw this.fail(operation, error);
      }
    }
  }

  /** Statements outside a transaction (autocommit). */
  private async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.fail(operation, error);
    }
  }

  public async insertJob(job: ImportJob, event: ImportEvent): Promise<boolean> {
    return this.transaction(
      'insertJob',
      async (manager) => {
        await manager.getRepository(ImportJobEntity).insert(toJobRow(job));
        await manager.getRepository(ImportEventEntity).insert(toEventRow(event));
        await appendLocalAuditAndDelivery(manager, auditEvent(event));
        return true;
      },
      () => false,
    );
  }

  public async findJob(tenantId: string, id: string): Promise<ImportJob | null> {
    return this.single('findJob', async () => {
      const row = await this.dataSource.getRepository(ImportJobEntity).findOneBy({ tenantId, id });
      return row ? toJob(row) : null;
    });
  }

  public async findByKey(tenantId: string, idempotencyKey: string): Promise<ImportJob | null> {
    return this.single('findByKey', async () => {
      const row = await this.dataSource
        .getRepository(ImportJobEntity)
        .findOneBy({ tenantId, idempotencyKey });
      return row ? toJob(row) : null;
    });
  }

  public async listJobs(
    tenantId: string,
    filter: ImportJobFilter,
    window: ImportWindow,
  ): Promise<ImportJobSlice> {
    return this.single('listJobs', async () => {
      const where: FindOptionsWhere<ImportJobEntity> = {
        tenantId,
        ...(filter.entity === undefined ? {} : { entity: filter.entity }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      };
      const [rows, total] = await this.dataSource.getRepository(ImportJobEntity).findAndCount({
        where,
        order: { createdAt: 'DESC', id: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toJob), total };
    });
  }

  public async appendRows(
    tenantId: string,
    jobId: string,
    rows: readonly ImportRowResult[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // The arguments scope the write: a row of another tenant or job is refused, never stored.
    if (rows.some((row) => row.tenantId !== tenantId || row.jobId !== jobId))
      throw new ImportStoreError('integrity');
    await this.single('appendRows', async () => {
      const repository = this.dataSource.getRepository(ImportRowEntity);
      const fresh = rows.map(toResultRow);
      try {
        await repository.insert(fresh);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Some of these rows already have a result (a retry or a concurrent attempt): keep it, add the rest.
        for (const row of fresh)
          try {
            await repository.insert(row);
          } catch (single) {
            if (!isDuplicateKey(single)) throw single;
          }
      }
    });
  }

  public async rows(
    tenantId: string,
    jobId: string,
    filter: RowFilter,
    window: ImportWindow,
  ): Promise<ImportRowSlice> {
    return this.single('rows', async () => {
      const [rows, total] = await this.dataSource.getRepository(ImportRowEntity).findAndCount({
        where: {
          tenantId,
          jobId,
          ...(filter.outcome === undefined ? {} : { outcome: filter.outcome }),
        },
        order: { rowNumber: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toResult), total };
    });
  }

  public async finishJob(
    next: ImportJob,
    expectedVersion: number,
    event: ImportEvent,
  ): Promise<boolean> {
    return this.transaction('finishJob', async (manager) => {
      const result = await manager
        .getRepository(ImportJobEntity)
        .update(
          { tenantId: next.tenantId, id: next.id, version: expectedVersion },
          finishColumns(next),
        );
      if (result.affected !== 1) return false;
      await manager.getRepository(ImportEventEntity).insert(toEventRow(event));
      await appendLocalAuditAndDelivery(manager, auditEvent(event));
      return true;
    });
  }

  public async claimJob(
    tenantId: string,
    jobId: string,
    expectedUpdatedAt: string,
    nextUpdatedAt: string,
  ): Promise<boolean> {
    return this.single('claimJob', async () => {
      // One conditional UPDATE: of any number of executors holding the same stamp, one changes the row.
      const result = await this.dataSource
        .getRepository(ImportJobEntity)
        .update(
          { tenantId, id: jobId, status: 'running', updatedAt: new Date(expectedUpdatedAt) },
          { updatedAt: new Date(nextUpdatedAt) },
        );
      return result.affected === 1;
    });
  }

  public async events(
    tenantId: string,
    jobId: string,
    window: ImportWindow,
  ): Promise<ImportEventSlice> {
    return this.single('events', async () => {
      const [rows, total] = await this.dataSource.getRepository(ImportEventEntity).findAndCount({
        where: { tenantId, jobId },
        order: { seq: 'DESC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toEvent), total };
    });
  }
}
