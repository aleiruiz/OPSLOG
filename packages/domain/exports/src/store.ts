import {
  EXPORT_EVENT_ACTOR,
  type ExportEvent,
  type ExportJob,
  type ExportStatus,
} from './types.js';
import type { ExportJobStore, ExportSlice, ExportWindow } from './ports.js';

/** The outbox envelope of a finished job; the store writes it with the status change. */
export function exportEnvelope(job: ExportJob, event: ExportEvent, at: Date) {
  const eventId = `${event.type.replace('.', '-')}-${job.id}`;
  return {
    eventId,
    tenantId: job.tenantId,
    type: event.type,
    payload: event.payload,
    occurredAt: at.toISOString(),
    idempotencyKey: eventId,
    correlationId: `${job.tenantId}.export`,
    actorRef: { subject: EXPORT_EVENT_ACTOR, kind: 'system' as const },
    entityId: job.id,
    schemaVersion: 1,
  };
}
export type ExportEnvelope = ReturnType<typeof exportEnvelope>;

const key = (tenantId: string, id: string): string => `${tenantId.length}:${tenantId}${id}`;

/** In-memory store for tests and the memory runtime. */
export class InMemoryExportJobStore implements ExportJobStore {
  private readonly jobs = new Map<string, ExportJob>();
  public constructor(
    private readonly emit: (envelope: ExportEnvelope) => void | Promise<void> = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async insert(job: ExportJob) {
    if (job.idempotencyKey !== null) {
      const same = await this.findByKey(job.tenantId, job.actorId, job.idempotencyKey);
      if (same) return { job: same, created: false };
    }
    this.jobs.set(key(job.tenantId, job.id), job);
    return { job, created: true };
  }
  public async find(tenantId: string, id: string) {
    return this.jobs.get(key(tenantId, id)) ?? null;
  }
  public async findByKey(tenantId: string, actorId: string, idempotencyKey: string) {
    return (
      [...this.jobs.values()].find(
        (job) =>
          job.tenantId === tenantId &&
          job.actorId === actorId &&
          job.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }
  public async listByActor(
    tenantId: string,
    actorId: string,
    window: ExportWindow,
  ): Promise<ExportSlice> {
    const mine = [...this.jobs.values()]
      .filter((job) => job.tenantId === tenantId && job.actorId === actorId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: mine.slice(window.offset, window.offset + window.limit), total: mine.length };
  }
  public async countOpen(tenantId: string, actorId: string) {
    const open = [...this.jobs.values()].filter(
      (job) => job.tenantId === tenantId && (job.status === 'queued' || job.status === 'running'),
    );
    return { tenant: open.length, actor: open.filter((job) => job.actorId === actorId).length };
  }
  public async claim(tenantId: string, now: Date, leaseMs: number, limit: number) {
    const due = [...this.jobs.values()]
      .filter(
        (job) =>
          job.tenantId === tenantId &&
          (job.status === 'queued' ||
            (job.status === 'running' &&
              job.leaseUntil !== null &&
              job.leaseUntil <= now.toISOString())),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    return due.map((job) => {
      const claimed: ExportJob = {
        ...job,
        status: 'running',
        attempts: job.attempts + 1,
        startedAt: now.toISOString(),
        leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      };
      this.jobs.set(key(job.tenantId, job.id), claimed);
      return claimed;
    });
  }
  public async transition(next: ExportJob, expected: ExportStatus, event?: ExportEvent) {
    const current = this.jobs.get(key(next.tenantId, next.id));
    if (current?.status !== expected) return false;
    this.jobs.set(key(next.tenantId, next.id), next);
    if (event) await this.emit(exportEnvelope(next, event, this.now()));
    return true;
  }
  public async expired(tenantId: string, now: Date, limit: number) {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.tenantId === tenantId &&
          job.status === 'completed' &&
          job.expiresAt !== null &&
          job.expiresAt <= now.toISOString(),
      )
      .slice(0, limit);
  }
}
