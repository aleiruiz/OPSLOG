import { randomUUID } from 'node:crypto';
import {
  FileError,
  applyScanOutcome,
  newUploadIntentRecord,
  newPendingRecord,
  requireOpaqueId,
  sha256Hex,
  validateUpload,
  type FileRecord,
  type FileRecordStore,
  type Sensitivity,
} from '../../../domain/files/src/index.js';
import {
  createAuditEvent,
  type AuditActorKind,
  type AuditEvent,
  type AuditStore,
  type PersistedAuditEvent,
} from '../../audit/src/index.js';
import type { ObjectRef, ObjectStorage } from './storage.js';
import type { ScanJob, ScanQueue, VirusScanner } from './scanner.js';
import { processCleanupIntents, processUploadIntents } from './saga-recovery.js';
import { processScanJob } from './scan-runner.js';

export interface FileActor {
  readonly tenantId: string;
  /** Opaque audit actor reference (for example `user-<uuid>` or `worker-files`). */
  readonly actorId: string;
  readonly actorKind: AuditActorKind;
  readonly correlationId: string;
}

/**
 * Appends an audit event that carries only opaque ids and an action label: never names,
 * content, hashes or storage keys. The audit store applies its own allowlist on top.
 */
export function auditFileEvent(
  audit: AuditStore,
  actor: FileActor,
  action: string,
  fileId: string,
  now: Date,
  attempts?: number,
): Promise<void> {
  return audit.append(
    createAuditEvent(actor, {
      eventId: `files-${randomUUID()}`,
      action,
      entityType: 'file',
      entityId: fileId,
      occurredAt: now.toISOString(),
      ...(attempts === undefined ? {} : { data: { attempts } }),
    }),
  );
}

/** Creates a retry-stable, allowlisted file audit event without persisting it. */
export function createFileAuditEvent(
  actor: FileActor,
  action: string,
  fileId: string,
  now: Date,
  attempts?: number,
): PersistedAuditEvent {
  const stableAction = action.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 40);
  const eventId = `files-${fileId}-${stableAction}${attempts === undefined ? '' : `-${attempts}`}`;
  return createAuditEvent(actor, {
    eventId: eventId.slice(0, 128),
    action,
    entityType: 'file',
    entityId: fileId,
    occurredAt: now.toISOString(),
    ...(attempts === undefined ? {} : { data: { attempts } }),
  });
}

/** A fresh audit identity for user actions that are not retryable saga transitions. */
export function createFileAccessAuditEvent(
  actor: FileActor,
  action: string,
  fileId: string,
  now: Date,
): PersistedAuditEvent {
  return createAuditEvent(actor, {
    eventId: `files-${randomUUID()}`,
    action,
    entityType: 'file',
    entityId: fileId,
    occurredAt: now.toISOString(),
  });
}

export interface FileUploadIntent {
  readonly tenantId: string;
  readonly fileId: string;
  readonly attempts: number;
  readonly expiresAt: number;
}

export interface FileCleanupIntent {
  readonly tenantId: string;
  readonly fileId: string;
  readonly kind: 'quarantine' | 'released';
}

/** Durable transitions used by the file saga and backed by one tenant-scoped TypeORM DataSource. */
export interface FileSagaJournal {
  beginUpload(record: FileRecord, event: AuditEvent, expiresAt: number): Promise<void>;
  finishUpload(record: FileRecord, event: AuditEvent, scanAt: number): Promise<FileRecord>;
  claimUploads(now: number, leaseMs: number, limit: number): Promise<readonly FileUploadIntent[]>;
  deferUpload(intent: FileUploadIntent, nextAttemptAt: number): Promise<void>;
  failUpload(intent: FileUploadIntent, record: FileRecord, event: AuditEvent): Promise<void>;
  getScanOutcome(
    tenantId: string,
    fileId: string,
  ): Promise<null | {
    readonly result: 'clean' | 'rejected';
    readonly reason?: 'malware' | 'integrity';
  }>;
  saveScanOutcome(
    record: FileRecord,
    outcome: { readonly result: 'clean' | 'rejected'; readonly reason?: 'malware' | 'integrity' },
    event: AuditEvent,
  ): Promise<void>;
  finishScan(record: FileRecord, next: FileRecord, event: AuditEvent): Promise<boolean>;
  deferScan(job: ScanJob, nextAttemptAt: number, event: AuditEvent): Promise<void>;
  claimCleanups(now: number, leaseMs: number, limit: number): Promise<readonly FileCleanupIntent[]>;
  finishCleanup(intent: FileCleanupIntent): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
}

export interface PipelineOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly scanLeaseMs?: number;
  readonly scanBackoffBaseMs?: number;
  readonly scanBackoffMaxMs?: number;
  readonly batchSize?: number;
  readonly uploadIntentTtlMs?: number;
}

export interface PipelineDeps {
  readonly records: FileRecordStore;
  readonly storage: ObjectStorage;
  readonly scanner: VirusScanner;
  readonly queue: ScanQueue;
  readonly audit: AuditStore;
  /** Supplied by durable composition; omitted only for in-memory unit and contract tests. */
  readonly journal?: FileSagaJournal;
}

export interface UploadInput {
  readonly name: string;
  readonly declaredType: string;
  readonly bytes: Uint8Array;
  readonly sensitivity?: Sensitivity;
}

export interface DerivativeInput {
  readonly bytes: Uint8Array;
  readonly declaredType: string;
  readonly width: number;
  readonly height: number;
}

export interface ScanRunSummary {
  readonly released: number;
  readonly rejected: number;
  readonly deferred: number;
  readonly skipped: number;
}

const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Quarantine, scan and release. Bytes are written only to quarantine at upload; they are copied to
 * released storage and the record flips to `clean` only after a clean verdict. A scanner outage
 * defers the job with backoff and never releases or rejects the file.
 */
export class FilePipeline {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly leaseMs: number;
  private readonly backoffBase: number;
  private readonly backoffMax: number;
  private readonly batchSize: number;
  private readonly uploadIntentTtlMs: number;
  public constructor(
    private readonly deps: PipelineDeps,
    options: PipelineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `file-${randomUUID()}`);
    this.leaseMs = options.scanLeaseMs ?? 60_000;
    this.backoffBase = options.scanBackoffBaseMs ?? 30_000;
    this.backoffMax = options.scanBackoffMaxMs ?? 3_600_000;
    this.batchSize = options.batchSize ?? 25;
    this.uploadIntentTtlMs = options.uploadIntentTtlMs ?? 24 * 60 * 60 * 1000;
  }

  /** Stores a new original in quarantine as `pending_scan` and queues its scan. */
  public async ingestOriginal(actor: FileActor, input: UploadInput): Promise<FileRecord> {
    const upload = validateUpload({
      name: input.name,
      declaredType: input.declaredType,
      bytes: input.bytes,
    });
    const createRecord = this.deps.journal ? newUploadIntentRecord : newPendingRecord;
    const record = createRecord({
      id: this.newId(),
      tenantId: actor.tenantId,
      kind: 'original',
      sensitivity: input.sensitivity ?? 'standard',
      upload,
      createdBy: actor.actorId,
      now: this.now(),
    });
    return this.store(actor, record, input.bytes);
  }

  /** Creates a derivative from a clean original of the same tenant; the original is never modified. */
  public async ingestDerivative(
    actor: FileActor,
    originalId: string,
    input: DerivativeInput,
  ): Promise<FileRecord> {
    const original = await this.deps.records.get(actor.tenantId, requireOpaqueId(originalId));
    if (original?.kind !== 'original') throw new FileError('not_found');
    if (original.status !== 'clean') throw new FileError('not_available');
    if (!IMAGE_TYPES.includes(input.declaredType)) throw new FileError('unsupported_type');
    const upload = validateUpload({
      name: original.displayName,
      declaredType: input.declaredType,
      bytes: input.bytes,
    });
    const createRecord = this.deps.journal ? newUploadIntentRecord : newPendingRecord;
    const record = createRecord({
      id: this.newId(),
      tenantId: actor.tenantId,
      kind: 'derivative',
      originalId: original.id,
      sensitivity: original.sensitivity,
      upload,
      width: input.width,
      height: input.height,
      createdBy: actor.actorId,
      now: this.now(),
    });
    return this.store(actor, record, input.bytes);
  }

  private async store(
    actor: FileActor,
    record: FileRecord,
    bytes: Uint8Array,
  ): Promise<FileRecord> {
    const ref = refFor(record, 'quarantine');
    if (this.deps.journal) {
      const event = createFileAuditEvent(
        actor,
        record.kind === 'original' ? 'file.upload_requested' : 'file.derivative_upload_requested',
        record.id,
        this.now(),
      );
      await this.deps.journal.beginUpload(
        record,
        event,
        this.now().getTime() + this.uploadIntentTtlMs,
      );
      await this.deps.storage.putIfAbsent(ref, bytes, {
        contentType: record.contentType,
        sha256: record.sha256,
      });
      const completed = await this.deps.journal.finishUpload(
        record,
        createFileAuditEvent(
          actor,
          record.kind === 'original' ? 'file.uploaded' : 'file.derivative_created',
          record.id,
          this.now(),
        ),
        this.now().getTime(),
      );
      return completed;
    }
    await this.deps.storage.putIfAbsent(ref, bytes, {
      contentType: record.contentType,
      sha256: record.sha256,
    });
    try {
      await this.deps.records.insert(record);
    } catch (error) {
      await this.deps.storage.delete(ref).catch(() => undefined);
      throw error;
    }
    await this.deps.queue.enqueue(record.tenantId, record.id, this.now().getTime());
    await auditFileEvent(
      this.deps.audit,
      actor,
      record.kind === 'original' ? 'file.uploaded' : 'file.derivative_created',
      record.id,
      this.now(),
    );
    return record;
  }

  /** Processes due scan jobs. Two concurrent runs never scan the same job twice. */
  public async processScans(): Promise<ScanRunSummary> {
    if (this.deps.journal)
      await processUploadIntents(this.deps.records, this.deps.storage, this.deps.journal, {
        now: this.now,
        leaseMs: this.leaseMs,
        batchSize: this.batchSize,
        nextAttemptAt: (attempts) => this.nextAttemptAt(attempts),
      });
    const jobs = await this.deps.queue.claimDue(this.now().getTime(), this.leaseMs, this.batchSize);
    const summary = { released: 0, rejected: 0, deferred: 0, skipped: 0 };
    for (const job of jobs)
      summary[
        await processScanJob(
          job,
          this.deps,
          this.now,
          (attempts) => this.nextAttemptAt(attempts),
          (actor, record, scanJob) => this.scanAndRelease(actor, record, scanJob),
        )
      ] += 1;
    if (this.deps.journal)
      await processCleanupIntents(
        this.deps.records,
        this.deps.storage,
        this.deps.journal,
        this.now,
        this.leaseMs,
        this.batchSize,
      );
    return summary;
  }

  private nextAttemptAt(attempts: number): number {
    const delay = Math.min(this.backoffBase * 2 ** Math.max(0, attempts - 1), this.backoffMax);
    return this.now().getTime() + delay;
  }

  private async scanAndRelease(
    actor: FileActor,
    record: FileRecord,
    job: ScanJob,
  ): Promise<keyof ScanRunSummary> {
    const quarantineRef = refFor(record, 'quarantine');
    let outcome = await this.deps.journal?.getScanOutcome(record.tenantId, record.id);
    let bytes = await this.deps.storage.get(quarantineRef);
    if (!bytes || sha256Hex(bytes) !== record.sha256) {
      outcome = { result: 'rejected', reason: 'integrity' };
    } else if (!outcome) {
      const verdict = await this.deps.scanner.scan(
        { tenantId: record.tenantId, fileId: record.id, contentType: record.contentType },
        bytes,
      );
      if (verdict.outcome === 'infected') outcome = { result: 'rejected', reason: 'malware' };
      else if ((verdict as { outcome?: unknown } | null)?.outcome === 'clean')
        outcome = { result: 'clean' };
      else throw new Error('unexpected scan verdict');
      if (this.deps.journal) {
        await this.deps.journal.saveScanOutcome(
          record,
          outcome,
          createFileAuditEvent(
            actor,
            outcome.result === 'clean' ? 'file.scan_clean' : 'file.scan_rejected',
            record.id,
            this.now(),
            job.attempts,
          ),
        );
      }
    }
    if (!outcome) throw new Error('missing scan outcome');
    if (outcome.result === 'rejected')
      return this.reject(actor, record, outcome.reason ?? 'integrity');
    // A previously persisted clean verdict lets retries finish release without invoking scanner again.
    bytes ??= await this.deps.storage.get(quarantineRef);
    if (!bytes || sha256Hex(bytes) !== record.sha256)
      return this.reject(actor, record, 'integrity');
    // Released bytes must exist before the record says clean, so a clean record is always servable.
    await this.deps.storage.putIfAbsent(refFor(record, 'released'), bytes, {
      contentType: record.contentType,
      sha256: record.sha256,
    });
    const next = applyScanOutcome(record, { result: 'clean' }, this.now());
    const swapped = this.deps.journal
      ? await this.deps.journal.finishScan(
          record,
          next,
          createFileAuditEvent(actor, 'file.released', record.id, this.now()),
        )
      : await this.deps.records.replaceIfStatus('pending_scan', next);
    if (!this.deps.journal) await this.deps.queue.complete(job.tenantId, job.fileId);
    if (!swapped) return 'skipped';
    if (!this.deps.journal) {
      await this.deps.storage.delete(quarantineRef).catch(() => undefined);
      await auditFileEvent(this.deps.audit, actor, 'file.released', record.id, this.now());
    }
    return 'released';
  }

  private async reject(
    actor: FileActor,
    record: FileRecord,
    reason: 'malware' | 'integrity',
  ): Promise<keyof ScanRunSummary> {
    const next = applyScanOutcome(record, { result: 'rejected', reason }, this.now());
    const swapped = this.deps.journal
      ? await this.deps.journal.finishScan(
          record,
          next,
          createFileAuditEvent(actor, 'file.rejected', record.id, this.now()),
        )
      : await this.deps.records.replaceIfStatus('pending_scan', next);
    if (!this.deps.journal) await this.deps.queue.complete(record.tenantId, record.id);
    if (!swapped) return 'skipped';
    if (!this.deps.journal) {
      await this.deps.storage.delete(refFor(record, 'quarantine')).catch(() => undefined);
      await auditFileEvent(this.deps.audit, actor, 'file.rejected', record.id, this.now());
    }
    return 'rejected';
  }
}

export function refFor(record: FileRecord, area: 'quarantine' | 'released'): ObjectRef {
  return { tenantId: record.tenantId, area, kind: record.kind, fileId: record.id };
}
