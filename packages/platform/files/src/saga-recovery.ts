import { sha256Hex, type FileRecordStore } from '../../../domain/files/src/index.js';
import type { FileSagaJournal, FileActor } from './pipeline.js';
import { createFileAuditEvent, refFor } from './pipeline.js';
import type { ObjectStorage } from './storage.js';

export async function processUploadIntents(
  records: FileRecordStore,
  storage: ObjectStorage,
  journal: FileSagaJournal,
  options: {
    now: () => Date;
    leaseMs: number;
    batchSize: number;
    nextAttemptAt: (attempts: number) => number;
  },
): Promise<void> {
  const now = options.now().getTime();
  const intents = await journal.claimUploads(now, options.leaseMs, options.batchSize);
  for (const intent of intents) {
    const record = await records.get(intent.tenantId, intent.fileId);
    if (!record || record.status !== 'pending_upload') continue;
    try {
      const bytes = await storage.get(refFor(record, 'quarantine'));
      if (bytes && sha256Hex(bytes) === record.sha256) {
        const actor: FileActor = {
          tenantId: record.tenantId,
          actorId: 'worker-files',
          actorKind: 'system',
          correlationId: `upload-${record.id}`.slice(0, 120),
        };
        await journal.finishUpload(
          record,
          createFileAuditEvent(actor, 'file.uploaded', record.id, options.now()),
          options.now().getTime(),
        );
        continue;
      }
      if (now >= intent.expiresAt) {
        const actor: FileActor = {
          tenantId: record.tenantId,
          actorId: 'worker-files',
          actorKind: 'system',
          correlationId: `upload-${record.id}`.slice(0, 120),
        };
        await journal.failUpload(
          intent,
          record,
          createFileAuditEvent(actor, 'file.upload_abandoned', record.id, options.now()),
        );
        await storage.delete(refFor(record, 'quarantine')).catch(() => undefined);
        continue;
      }
      await journal.deferUpload(intent, options.nextAttemptAt(intent.attempts));
    } catch {
      await journal.deferUpload(intent, options.nextAttemptAt(intent.attempts));
    }
  }
}

export async function processCleanupIntents(
  records: FileRecordStore,
  storage: ObjectStorage,
  journal: FileSagaJournal,
  now: () => Date,
  leaseMs: number,
  batchSize: number,
): Promise<void> {
  const intents = await journal.claimCleanups(now().getTime(), leaseMs, batchSize);
  for (const intent of intents) {
    const record = await records.get(intent.tenantId, intent.fileId);
    if (!record) {
      await journal.finishCleanup(intent);
      continue;
    }
    try {
      await storage.delete(refFor(record, intent.kind));
      await journal.finishCleanup(intent);
    } catch {
      // The durable cleanup intent remains leased and will be retried after lease expiry.
    }
  }
}
