import type { Permission } from '../../identity/src/index.js';
import type { ExportTable, RenderedExport } from '../../../platform/exports/src/index.js';
import type { ReportFormat } from '../../reports/src/index.js';
import type { ExportEvent, ExportJob, ExportStatus } from './types.js';

export interface ExportWindow {
  readonly limit: number;
  readonly offset: number;
}

export interface ExportSlice {
  readonly items: readonly ExportJob[];
  readonly total: number;
}

/**
 * Persistence port of the export jobs. Every method names the company: a job of another company is
 * simply absent. `transition` is a compare-and-set on the status and writes the outbox event of a
 * finished job in the same unit of work.
 */
export interface ExportJobStore {
  /** Inserts the job; with an `idempotencyKey` already used by the same actor it returns the stored one and `created: false`. */
  insert(job: ExportJob): Promise<{ readonly job: ExportJob; readonly created: boolean }>;
  find(tenantId: string, id: string): Promise<ExportJob | null>;
  findByKey(tenantId: string, actorId: string, key: string): Promise<ExportJob | null>;
  /** Newest first. */
  listByActor(tenantId: string, actorId: string, window: ExportWindow): Promise<ExportSlice>;
  /** Jobs that are `queued` or `running`, of the company and of the actor. */
  countOpen(
    tenantId: string,
    actorId: string,
  ): Promise<{ readonly tenant: number; readonly actor: number }>;
  /** Marks up to `limit` queued jobs (and running ones whose lease ran out) as running for `leaseMs`. */
  claim(tenantId: string, now: Date, leaseMs: number, limit: number): Promise<readonly ExportJob[]>;
  /** Writes `next` only while the stored status is `expected`; false otherwise. */
  transition(next: ExportJob, expected: ExportStatus, event?: ExportEvent): Promise<boolean>;
  /** Completed jobs whose artifact is past `expiresAt`. */
  expired(tenantId: string, now: Date, limit: number): Promise<readonly ExportJob[]>;
}

/** Where the files live: the object storage under a path opaque to the browser and scoped to the company. */
export interface ArtifactStore {
  put(
    tenantId: string,
    jobId: string,
    bytes: Uint8Array,
    contentType: string,
    sha256: string,
  ): Promise<void>;
  get(tenantId: string, jobId: string): Promise<Uint8Array | null>;
  delete(tenantId: string, jobId: string): Promise<void>;
}

/** What a job re-checks when it starts: session, membership and permissions as they are now. */
export interface ExportAuthority {
  /** The current permissions of the person, or null when the session or the membership no longer stands. */
  check(
    job: Pick<ExportJob, 'tenantId' | 'actorId' | 'sessionId'>,
  ): Promise<ReadonlySet<Permission> | null>;
}

export interface ExportAuditEntry {
  readonly tenantId: string;
  readonly actorId: string;
  readonly action: string;
  readonly jobId: string;
  readonly correlationId: string;
}

export interface ExportCompany {
  name(tenantId: string): string;
  /** Who the document says generated it: a label that is not an e-mail or a name. */
  author(tenantId: string, actorId: string): Promise<string>;
}

export type Renderer = (format: ReportFormat, table: ExportTable) => Promise<RenderedExport>;
