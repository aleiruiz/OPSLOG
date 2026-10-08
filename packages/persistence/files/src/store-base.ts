import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '../../../platform/audit/src/index.js';
import {
  FileError,
  requireOpaqueId,
  type FileRecord,
  type FileRecordStore,
  type FileStatus,
} from '../../../domain/files/src/index.js';
import type { FileUploadIntent } from '../../../platform/files/src/pipeline.js';
import { createFileAuditEvent } from '../../../platform/files/src/pipeline.js';
import { appendLocalAuditAndDelivery } from '../../audit/src/index.js';
import { FILES_RUNTIME_ACCOUNT } from './data-source.js';
import {
  FileHistoryEntity,
  FileRecordEntity,
  FileSagaEntity,
  type FileSagaStage,
} from './entities.js';

import { FILE_TYPES } from '../../../domain/files/src/index.js';
import type { DataSource, EntityManager } from 'typeorm';

const statuses: readonly FileStatus[] = ['pending_upload', 'pending_scan', 'clean', 'rejected'];
export function fileOf(row: FileRecordEntity): FileRecord {
  if (
    !statuses.includes(row.status) ||
    (row.kind !== 'original' && row.kind !== 'derivative') ||
    (row.sensitivity !== 'standard' && row.sensitivity !== 'pii') ||
    !Object.prototype.hasOwnProperty.call(FILE_TYPES, row.contentType) ||
    (row.rejectionReason !== null &&
      row.rejectionReason !== 'malware' &&
      row.rejectionReason !== 'integrity')
  )
    throw new FileError('integrity_failed');
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    ...(row.originalId === null ? {} : { originalId: row.originalId }),
    status: row.status,
    sensitivity: row.sensitivity,
    contentType: row.contentType as FileRecord['contentType'],
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    displayName: row.displayName,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    ...(row.scannedAt === null ? {} : { scannedAt: row.scannedAt.toISOString() }),
    ...(row.rejectionReason === null ? {} : { rejectionReason: row.rejectionReason }),
  };
}

function rowOf(record: FileRecord): FileRecordEntity {
  return {
    tenantId: record.tenantId,
    id: record.id,
    kind: record.kind,
    originalId: record.originalId ?? null,
    status: record.status,
    sensitivity: record.sensitivity,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    displayName: record.displayName,
    width: record.width ?? null,
    height: record.height ?? null,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    scannedAt: record.scannedAt === undefined ? null : new Date(record.scannedAt),
    rejectionReason: record.rejectionReason ?? null,
  };
}

function systemEvent(record: FileRecord, action: string): AuditEvent {
  return createFileAuditEvent(
    {
      tenantId: record.tenantId,
      actorId: 'worker-files',
      actorKind: 'system',
      correlationId: `file-${record.id}`.slice(0, 120),
    },
    action,
    record.id,
    new Date(),
  );
}

/** Tenant-local file records, saga queue and audit transitions on one MySQL DataSource. */
export abstract class TypeOrmFileSagaStoreBase implements FileRecordStore {
  public constructor(
    protected readonly dataSource: DataSource,
    protected readonly tenantId: string,
  ) {
    requireOpaqueId(tenantId);
    if (
      dataSource.options.type !== 'mysql' ||
      dataSource.options.synchronize === true ||
      typeof dataSource.options.database !== 'string' ||
      !/^opslog_t_[a-z0-9_]{1,100}$/i.test(dataSource.options.database)
    )
      throw new Error('File saga store requires its tenant-exclusive MySQL database');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !FILES_RUNTIME_ACCOUNT.test(username))
      throw new Error('File saga store requires its tenant-scoped runtime account');
  }

  protected assertTenant(...tenantIds: readonly string[]): void {
    if (tenantIds.some((tenantId) => tenantId !== this.tenantId)) throw new FileError('not_found');
  }

  protected assertRecordEvent(record: FileRecord, event: AuditEvent): void {
    this.assertTenant(record.tenantId, event.tenantId);
    if (event.entityType !== 'file' || event.entityId !== record.id)
      throw new FileError('invalid_input');
  }

  protected transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction('READ COMMITTED', work);
  }

  protected async history(
    manager: EntityManager,
    record: FileRecord,
    fromStatus: FileStatus | null,
    toStatus: FileStatus,
    at: Date,
    actorId = record.createdBy,
  ): Promise<void> {
    const repository = manager.getRepository(FileHistoryEntity);
    const version =
      (await repository.countBy({ tenantId: record.tenantId, fileId: record.id })) + 1;
    await repository.insert({
      tenantId: record.tenantId,
      id: randomUUID(),
      fileId: record.id,
      version,
      fromStatus,
      toStatus,
      actorId,
      at,
    });
  }

  protected async appendEvent(manager: EntityManager, event: AuditEvent): Promise<void> {
    await appendLocalAuditAndDelivery(manager, event);
  }

  public async insert(record: FileRecord): Promise<void> {
    this.assertTenant(record.tenantId);
    const event = systemEvent(record, 'file.record_created');
    await this.transaction(async (manager) => {
      await manager.getRepository(FileRecordEntity).insert(rowOf(record));
      await this.history(
        manager,
        record,
        null,
        record.status,
        new Date(record.createdAt),
        event.actor.id,
      );
      await this.appendEvent(manager, event);
    });
  }

  public async get(tenantId: string, id: string): Promise<FileRecord | null> {
    this.assertTenant(tenantId);
    const row = await this.dataSource.getRepository(FileRecordEntity).findOneBy({ tenantId, id });
    return row ? fileOf(row) : null;
  }

  public async replaceIfStatus(expected: FileStatus, next: FileRecord): Promise<boolean> {
    this.assertTenant(next.tenantId);
    const event = systemEvent(next, `file.status_${next.status}`);
    return this.transaction(async (manager) => {
      const result = await manager.getRepository(FileRecordEntity).update(
        { tenantId: next.tenantId, id: next.id, status: expected },
        {
          status: next.status,
          scannedAt: next.scannedAt === undefined ? null : new Date(next.scannedAt),
          rejectionReason: next.rejectionReason ?? null,
        },
      );
      if (result.affected !== 1) return false;
      await this.history(manager, next, expected, next.status, new Date(), event.actor.id);
      await this.appendEvent(manager, event);
      return true;
    });
  }

  public async beginUpload(
    record: FileRecord,
    event: AuditEvent,
    expiresAt: number,
  ): Promise<void> {
    this.assertRecordEvent(record, event);
    if (record.status !== 'pending_upload') throw new FileError('invalid_input');
    await this.transaction(async (manager) => {
      await manager.getRepository(FileRecordEntity).insert(rowOf(record));
      await this.history(
        manager,
        record,
        null,
        record.status,
        new Date(record.createdAt),
        event.actor.id,
      );
      await manager.getRepository(FileSagaEntity).insert({
        tenantId: record.tenantId,
        fileId: record.id,
        stage: 'upload',
        state: 'pending',
        attempts: 0,
        availableAt: new Date(record.createdAt),
        leaseUntil: null,
        expiresAt: new Date(expiresAt),
        scanOutcome: null,
        rejectionReason: null,
        updatedAt: new Date(record.createdAt),
      });
      await this.appendEvent(manager, event);
    });
  }

  public async finishUpload(
    record: FileRecord,
    event: AuditEvent,
    scanAt: number,
  ): Promise<FileRecord> {
    this.assertRecordEvent(record, event);
    return this.transaction(async (manager) => {
      const records = manager.getRepository(FileRecordEntity);
      const current = await records.findOne({
        where: { tenantId: record.tenantId, id: record.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new FileError('not_found');
      if (current.status === 'pending_scan') return fileOf(current);
      if (current.status !== 'pending_upload') throw new FileError('conflict');
      const next = { ...current, status: 'pending_scan' as const };
      await records.update(
        { tenantId: record.tenantId, id: record.id },
        { status: 'pending_scan' },
      );
      await this.history(
        manager,
        fileOf(current),
        'pending_upload',
        'pending_scan',
        new Date(scanAt),
        event.actor.id,
      );
      await manager
        .getRepository(FileSagaEntity)
        .update(
          { tenantId: record.tenantId, fileId: record.id, stage: 'upload' },
          { state: 'completed', leaseUntil: null, updatedAt: new Date(scanAt) },
        );
      await manager.getRepository(FileSagaEntity).insert({
        tenantId: record.tenantId,
        fileId: record.id,
        stage: 'scan',
        state: 'pending',
        attempts: 0,
        availableAt: new Date(scanAt),
        leaseUntil: null,
        expiresAt: null,
        scanOutcome: null,
        rejectionReason: null,
        updatedAt: new Date(scanAt),
      });
      await this.appendEvent(manager, event);
      return fileOf(next);
    });
  }

  protected async claimStage<T extends FileSagaStage>(
    stage: T,
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<FileSagaEntity[]> {
    return this.transaction(async (manager) => {
      const selected = await manager
        .getRepository(FileSagaEntity)
        .createQueryBuilder('job')
        .where('job.tenantId = :tenantId', { tenantId: this.tenantId })
        .andWhere('job.stage = :stage', { stage })
        .andWhere(
          "((job.state IN ('pending', 'retry') AND job.availableAt <= :now) OR (job.state = 'processing' AND job.leaseUntil <= :now))",
          { now: new Date(now) },
        )
        .orderBy('job.availableAt', 'ASC')
        .addOrderBy('job.tenantId', 'ASC')
        .addOrderBy('job.fileId', 'ASC')
        .take(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      const repository = manager.getRepository(FileSagaEntity);
      const leaseUntil = new Date(now + leaseMs);
      for (const row of selected) {
        row.state = 'processing';
        row.attempts += 1;
        row.leaseUntil = leaseUntil;
        row.updatedAt = new Date(now);
        await repository.save(row);
      }
      return selected;
    });
  }

  public async claimUploads(
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<readonly FileUploadIntent[]> {
    const rows = await this.claimStage('upload', now, leaseMs, limit);
    return rows.map((row) => ({
      tenantId: row.tenantId,
      fileId: row.fileId,
      attempts: row.attempts,
      expiresAt: row.expiresAt?.getTime() ?? now,
    }));
  }

  public async deferUpload(intent: FileUploadIntent, nextAttemptAt: number): Promise<void> {
    this.assertTenant(intent.tenantId);
    await this.dataSource.getRepository(FileSagaEntity).update(
      {
        tenantId: intent.tenantId,
        fileId: intent.fileId,
        stage: 'upload',
        state: 'processing',
        attempts: intent.attempts,
      },
      {
        state: 'retry',
        availableAt: new Date(nextAttemptAt),
        leaseUntil: null,
        updatedAt: new Date(),
      },
    );
  }

  public async failUpload(
    intent: FileUploadIntent,
    record: FileRecord,
    event: AuditEvent,
  ): Promise<void> {
    this.assertRecordEvent(record, event);
    this.assertTenant(intent.tenantId);
    await this.transaction(async (manager) => {
      const records = manager.getRepository(FileRecordEntity);
      const result = await records.update(
        { tenantId: intent.tenantId, id: intent.fileId, status: 'pending_upload' },
        { status: 'rejected', rejectionReason: 'integrity', scannedAt: new Date() },
      );
      if (result.affected !== 1) return;
      await this.history(manager, record, 'pending_upload', 'rejected', new Date(), event.actor.id);
      await manager
        .getRepository(FileSagaEntity)
        .update(
          { tenantId: intent.tenantId, fileId: intent.fileId, stage: 'upload' },
          { state: 'completed', leaseUntil: null, updatedAt: new Date() },
        );
      await manager.getRepository(FileSagaEntity).insert({
        tenantId: intent.tenantId,
        fileId: intent.fileId,
        stage: 'cleanup_quarantine',
        state: 'pending',
        attempts: 0,
        availableAt: new Date(),
        leaseUntil: null,
        expiresAt: null,
        scanOutcome: null,
        rejectionReason: null,
        updatedAt: new Date(),
      });
      await this.appendEvent(manager, event);
    });
  }
}
