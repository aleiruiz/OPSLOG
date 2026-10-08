import type { FileRecord } from '../../../domain/files/src/index.js';
import type { FileActor, PipelineDeps, ScanRunSummary } from './pipeline.js';
import { auditFileEvent, createFileAuditEvent } from './pipeline.js';
import type { ScanJob } from './scanner.js';

export async function processScanJob(
  job: ScanJob,
  deps: PipelineDeps,
  now: () => Date,
  nextAttemptAt: (attempts: number) => number,
  scanAndRelease: (
    actor: FileActor,
    record: FileRecord,
    job: ScanJob,
  ) => Promise<keyof ScanRunSummary>,
): Promise<keyof ScanRunSummary> {
  const actor: FileActor = {
    tenantId: job.tenantId,
    actorId: 'worker-files',
    actorKind: 'system',
    correlationId: `scan-${job.fileId}`.slice(0, 120),
  };
  const record = await deps.records.get(job.tenantId, job.fileId);
  if (record?.status !== 'pending_scan') {
    await deps.queue.complete(job.tenantId, job.fileId);
    return 'skipped';
  }
  try {
    return await scanAndRelease(actor, record, job);
  } catch {
    // Scanner or storage outage: stay in quarantine and retry later; never release on failure.
    const retryAt = nextAttemptAt(job.attempts);
    if (deps.journal) {
      await deps.journal.deferScan(
        job,
        retryAt,
        createFileAuditEvent(actor, 'file.scan_deferred', job.fileId, now(), job.attempts),
      );
    } else {
      await deps.queue.defer(job.tenantId, job.fileId, retryAt);
      await auditFileEvent(
        deps.audit,
        actor,
        'file.scan_deferred',
        job.fileId,
        now(),
        job.attempts,
      );
    }
    return 'deferred';
  }
}
