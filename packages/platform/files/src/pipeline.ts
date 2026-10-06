import { randomUUID } from 'node:crypto';
import {
  FileError,
  applyScanOutcome,
  newPendingRecord,
  requireOpaqueId,
  sha256Hex,
  validateUpload,
  type FileRecord,
  type FileRecordStore,
  type Sensitivity,
} from '../../../domain/files/src/index.js';
import { createAuditEvent, type AuditActorKind, type AuditStore } from '../../audit/src/index.js';
import type { ObjectRef, ObjectStorage } from './storage.js';
import type { ScanJob, ScanQueue, VirusScanner } from './scanner.js';

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
): void {
  audit.append(
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

export interface PipelineOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly scanLeaseMs?: number;
  readonly scanBackoffBaseMs?: number;
  readonly scanBackoffMaxMs?: number;
  readonly batchSize?: number;
}

export interface PipelineDeps {
  readonly records: FileRecordStore;
  readonly storage: ObjectStorage;
  readonly scanner: VirusScanner;
  readonly queue: ScanQueue;
  readonly audit: AuditStore;
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
const SYSTEM_ACTOR = 'worker-files';

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
  }

  /** Stores a new original in quarantine as `pending_scan` and queues its scan. */
  public async ingestOriginal(actor: FileActor, input: UploadInput): Promise<FileRecord> {
    const upload = validateUpload({
      name: input.name,
      declaredType: input.declaredType,
      bytes: input.bytes,
    });
    const record = newPendingRecord({
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
    const record = newPendingRecord({
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
    auditFileEvent(
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
    const jobs = await this.deps.queue.claimDue(this.now().getTime(), this.leaseMs, this.batchSize);
    const summary = { released: 0, rejected: 0, deferred: 0, skipped: 0 };
    for (const job of jobs) summary[await this.processJob(job)] += 1;
    return summary;
  }

  private async processJob(job: ScanJob): Promise<keyof ScanRunSummary> {
    const actor: FileActor = {
      tenantId: job.tenantId,
      actorId: SYSTEM_ACTOR,
      actorKind: 'system',
      correlationId: `scan-${job.fileId}`.slice(0, 120),
    };
    const record = await this.deps.records.get(job.tenantId, job.fileId);
    if (record?.status !== 'pending_scan') {
      await this.deps.queue.complete(job.tenantId, job.fileId);
      return 'skipped';
    }
    try {
      return await this.scanAndRelease(actor, record, job);
    } catch {
      // Scanner or storage outage: stay in quarantine and retry later; never release on failure.
      await this.deps.queue.defer(job.tenantId, job.fileId, this.nextAttemptAt(job.attempts));
      auditFileEvent(
        this.deps.audit,
        actor,
        'file.scan_deferred',
        job.fileId,
        this.now(),
        job.attempts,
      );
      return 'deferred';
    }
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
    const bytes = await this.deps.storage.get(quarantineRef);
    if (!bytes || sha256Hex(bytes) !== record.sha256)
      return this.reject(actor, record, quarantineRef, 'integrity');
    const verdict = await this.deps.scanner.scan(
      { tenantId: record.tenantId, fileId: record.id, contentType: record.contentType },
      bytes,
    );
    if (verdict.outcome === 'infected') return this.reject(actor, record, quarantineRef, 'malware');
    // Fail closed: anything other than an explicit clean verdict is treated as a scanner failure.
    if ((verdict as { outcome?: unknown } | null)?.outcome !== 'clean')
      throw new Error('unexpected scan verdict');
    // Released bytes must exist before the record says clean, so a clean record is always servable.
    await this.deps.storage.putIfAbsent(refFor(record, 'released'), bytes, {
      contentType: record.contentType,
      sha256: record.sha256,
    });
    const swapped = await this.deps.records.replaceIfStatus(
      'pending_scan',
      applyScanOutcome(record, { result: 'clean' }, this.now()),
    );
    await this.deps.queue.complete(job.tenantId, job.fileId);
    if (!swapped) return 'skipped';
    await this.deps.storage.delete(quarantineRef).catch(() => undefined);
    auditFileEvent(this.deps.audit, actor, 'file.released', record.id, this.now());
    return 'released';
  }

  private async reject(
    actor: FileActor,
    record: FileRecord,
    quarantineRef: ObjectRef,
    reason: 'malware' | 'integrity',
  ): Promise<keyof ScanRunSummary> {
    const swapped = await this.deps.records.replaceIfStatus(
      'pending_scan',
      applyScanOutcome(record, { result: 'rejected', reason }, this.now()),
    );
    await this.deps.queue.complete(record.tenantId, record.id);
    if (!swapped) return 'skipped';
    await this.deps.storage.delete(quarantineRef).catch(() => undefined);
    auditFileEvent(this.deps.audit, actor, 'file.rejected', record.id, this.now());
    return 'rejected';
  }
}

export function refFor(record: FileRecord, area: 'quarantine' | 'released'): ObjectRef {
  return { tenantId: record.tenantId, area, kind: record.kind, fileId: record.id };
}
