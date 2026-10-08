import type { AuditEvent } from '../../../platform/audit/src/index.js';
import { FileError, type FileRecord } from '../../../domain/files/src/index.js';
import type { FileCleanupIntent } from '../../../platform/files/src/pipeline.js';
import type { ScanJob, ScanQueue } from '../../../platform/files/src/scanner.js';
import { FileRecordEntity, FileSagaEntity } from './entities.js';
import { TypeOrmFileSagaStoreBase } from './store-base.js';

/** Tenant-local scan queue, recovery journal and audit transitions. */
export class TypeOrmFileSagaStore extends TypeOrmFileSagaStoreBase implements ScanQueue {
  public async enqueue(tenantId: string, fileId: string, at: number): Promise<void> {
    this.assertTenant(tenantId);
    const records = this.dataSource.getRepository(FileRecordEntity);
    if (!(await records.exists({ where: { tenantId, id: fileId } })))
      throw new FileError('not_found');
    await this.dataSource.getRepository(FileSagaEntity).upsert(
      {
        tenantId,
        fileId,
        stage: 'scan',
        state: 'pending',
        attempts: 0,
        availableAt: new Date(at),
        leaseUntil: null,
        expiresAt: null,
        scanOutcome: null,
        rejectionReason: null,
        updatedAt: new Date(at),
      },
      ['tenantId', 'fileId', 'stage'],
    );
  }

  public async claimDue(now: number, leaseMs: number, limit: number): Promise<readonly ScanJob[]> {
    const rows = await this.claimStage('scan', now, leaseMs, limit);
    return rows.map((row) => ({
      tenantId: row.tenantId,
      fileId: row.fileId,
      attempts: row.attempts,
      nextAttemptAt: row.availableAt.getTime(),
    }));
  }

  public async complete(tenantId: string, fileId: string): Promise<void> {
    this.assertTenant(tenantId);
    await this.dataSource
      .getRepository(FileSagaEntity)
      .update(
        { tenantId, fileId, stage: 'scan' },
        { state: 'completed', leaseUntil: null, updatedAt: new Date() },
      );
  }

  public async defer(tenantId: string, fileId: string, nextAttemptAt: number): Promise<void> {
    this.assertTenant(tenantId);
    await this.dataSource.getRepository(FileSagaEntity).update(
      { tenantId, fileId, stage: 'scan', state: 'processing' },
      {
        state: 'retry',
        availableAt: new Date(nextAttemptAt),
        leaseUntil: null,
        updatedAt: new Date(),
      },
    );
  }

  public async getScanOutcome(
    tenantId: string,
    fileId: string,
  ): Promise<null | {
    readonly result: 'clean' | 'rejected';
    readonly reason?: 'malware' | 'integrity';
  }> {
    this.assertTenant(tenantId);
    const row = await this.dataSource.getRepository(FileSagaEntity).findOneBy({
      tenantId,
      fileId,
      stage: 'scan',
    });
    if (!row?.scanOutcome) return null;
    if (row.scanOutcome === 'clean') return { result: 'clean' };
    if (row.rejectionReason !== 'malware' && row.rejectionReason !== 'integrity')
      throw new FileError('integrity_failed');
    return { result: 'rejected', reason: row.rejectionReason };
  }

  public async saveScanOutcome(
    record: FileRecord,
    outcome: { readonly result: 'clean' | 'rejected'; readonly reason?: 'malware' | 'integrity' },
    event: AuditEvent,
  ): Promise<void> {
    this.assertRecordEvent(record, event);
    await this.transaction(async (manager) => {
      const repository = manager.getRepository(FileSagaEntity);
      const row = await repository.findOne({
        where: { tenantId: record.tenantId, fileId: record.id, stage: 'scan' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new FileError('not_found');
      if (row.scanOutcome) {
        if (row.scanOutcome !== outcome.result || row.rejectionReason !== (outcome.reason ?? null))
          throw new FileError('conflict');
        return;
      }
      row.scanOutcome = outcome.result;
      row.rejectionReason = outcome.reason ?? null;
      row.updatedAt = new Date();
      await repository.save(row);
      await this.appendEvent(manager, event);
    });
  }

  public async finishScan(
    record: FileRecord,
    next: FileRecord,
    event: AuditEvent,
  ): Promise<boolean> {
    this.assertRecordEvent(record, event);
    this.assertTenant(next.tenantId);
    if (next.id !== record.id) throw new FileError('invalid_input');
    return this.transaction(async (manager) => {
      const records = manager.getRepository(FileRecordEntity);
      const current = await records.findOne({
        where: { tenantId: record.tenantId, id: record.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) return false;
      if (current.status !== 'pending_scan') {
        if (current.status !== 'clean') {
          await manager.getRepository(FileSagaEntity).upsert(
            {
              tenantId: record.tenantId,
              fileId: record.id,
              stage: 'cleanup_released',
              state: 'pending',
              attempts: 0,
              availableAt: new Date(),
              leaseUntil: null,
              expiresAt: null,
              scanOutcome: null,
              rejectionReason: null,
              updatedAt: new Date(),
            },
            ['tenantId', 'fileId', 'stage'],
          );
        }
        return false;
      }
      const result = await records.update(
        { tenantId: record.tenantId, id: record.id, status: 'pending_scan' },
        {
          status: next.status,
          scannedAt: next.scannedAt === undefined ? null : new Date(next.scannedAt),
          rejectionReason: next.rejectionReason ?? null,
        },
      );
      if (result.affected !== 1) return false;
      await this.history(
        manager,
        next,
        'pending_scan',
        next.status,
        new Date(next.scannedAt ?? new Date()),
        event.actor.id,
      );
      await manager
        .getRepository(FileSagaEntity)
        .update(
          { tenantId: record.tenantId, fileId: record.id, stage: 'scan' },
          { state: 'completed', leaseUntil: null, updatedAt: new Date() },
        );
      await manager.getRepository(FileSagaEntity).upsert(
        {
          tenantId: record.tenantId,
          fileId: record.id,
          stage: 'cleanup_quarantine',
          state: 'pending',
          attempts: 0,
          availableAt: new Date(),
          leaseUntil: null,
          expiresAt: null,
          scanOutcome: null,
          rejectionReason: null,
          updatedAt: new Date(),
        },
        ['tenantId', 'fileId', 'stage'],
      );
      if (next.status === 'rejected') {
        await manager.getRepository(FileSagaEntity).upsert(
          {
            tenantId: record.tenantId,
            fileId: record.id,
            stage: 'cleanup_released',
            state: 'pending',
            attempts: 0,
            availableAt: new Date(),
            leaseUntil: null,
            expiresAt: null,
            scanOutcome: null,
            rejectionReason: null,
            updatedAt: new Date(),
          },
          ['tenantId', 'fileId', 'stage'],
        );
      }
      await this.appendEvent(manager, event);
      return true;
    });
  }

  public async deferScan(job: ScanJob, nextAttemptAt: number, event: AuditEvent): Promise<void> {
    this.assertTenant(job.tenantId, event.tenantId);
    await this.transaction(async (manager) => {
      const repository = manager.getRepository(FileSagaEntity);
      const result = await repository.update(
        {
          tenantId: job.tenantId,
          fileId: job.fileId,
          stage: 'scan',
          state: 'processing',
          attempts: job.attempts,
        },
        {
          state: 'retry',
          availableAt: new Date(nextAttemptAt),
          leaseUntil: null,
          updatedAt: new Date(),
        },
      );
      if (result.affected === 1) await this.appendEvent(manager, event);
    });
  }

  public async claimCleanups(
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<readonly FileCleanupIntent[]> {
    const quarantine = await this.claimStage('cleanup_quarantine', now, leaseMs, limit);
    const released = await this.claimStage('cleanup_released', now, leaseMs, limit);
    return [...quarantine, ...released].map((row) => ({
      tenantId: row.tenantId,
      fileId: row.fileId,
      kind: row.stage === 'cleanup_released' ? 'released' : 'quarantine',
    }));
  }

  public async finishCleanup(intent: FileCleanupIntent): Promise<void> {
    this.assertTenant(intent.tenantId);
    const stage = intent.kind === 'quarantine' ? 'cleanup_quarantine' : 'cleanup_released';
    await this.dataSource
      .getRepository(FileSagaEntity)
      .update(
        { tenantId: intent.tenantId, fileId: intent.fileId, stage },
        { state: 'completed', leaseUntil: null, updatedAt: new Date() },
      );
  }

  public async appendAudit(event: AuditEvent): Promise<void> {
    this.assertTenant(event.tenantId);
    await this.transaction((manager) => this.appendEvent(manager, event));
  }
}
