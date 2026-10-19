import type { ReportFormat } from '../../reports/src/index.js';

export type ExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';
export const EXPORT_STATUSES: readonly ExportStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'expired',
];

/** `direct`: generated while the request waited; `job`: queued for the worker (more than 5.000 rows or slow). */
export type ExportMode = 'direct' | 'job';

/** Why a job produced no file. Never a message of the store, the source or the renderer. */
export type ExportFailure =
  | 'permission_revoked'
  | 'session_ended'
  | 'too_many_rows'
  | 'generation_failed';

export interface ExportJob {
  readonly id: string;
  /** Company that owns the job; every read and write names it. */
  readonly tenantId: string;
  /** Identity subject of the person who asked (without the `user-` prefix). */
  readonly actorId: string;
  /** Opaque digest of the session the request came with; the job asks the control plane whether it still stands. */
  readonly sessionId: string;
  readonly reportId: string;
  readonly format: ReportFormat;
  /** The validated filters: their names are audited, their values stay here. */
  readonly filters: Readonly<Record<string, string>>;
  /** The columns of the file, already limited to what the reader could see when asking. */
  readonly columns: readonly string[];
  readonly sort: string;
  readonly direction: 'asc' | 'desc';
  readonly mode: ExportMode;
  readonly status: ExportStatus;
  readonly rowCount: number | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly fileName: string | null;
  readonly failure: ExportFailure | null;
  readonly idempotencyKey: string | null;
  /** Digest of what was asked, so a reused `Idempotency-Key` with another request is a conflict. */
  readonly requestHash: string;
  /** Tries made by the worker; a job that keeps losing its worker fails after `MAX_ATTEMPTS`. */
  readonly attempts: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** The artifact is available until this instant (7 days after it was produced). */
  readonly expiresAt: string | null;
  /** While `running`, the worker owns the job until this instant. */
  readonly leaseUntil: string | null;
}

export type ExportEventType = 'export.completed' | 'export.failed';

/** Outbox event of a finished job (MVP-NOTIFY consumes it). */
export interface ExportEvent {
  readonly type: ExportEventType;
  readonly payload: Readonly<Record<string, string | number>>;
}

export const EXPORT_TTL_DAYS = 7;
export const DIRECT_MAX_ROWS = 5_000;
/**
 * Largest PDF. Measured: 50.000 rows x 10 columns took 35 s and 1,9 GB inside the API process; at
 * 2.000 rows (about 60 landscape pages) the render stays near a second and tens of MB. CSV and XLSX
 * keep the 50.000-row ceiling of the engine.
 */
export const PDF_MAX_ROWS = 2_000;
export const DIRECT_BUDGET_MS = 10_000;
export const LEASE_MS = 2 * 60_000;
export const MAX_ATTEMPTS = 3;
export const MAX_OPEN_PER_ACTOR = 3;
export const MAX_OPEN_PER_TENANT = 10;
export const EXPORT_EVENT_ACTOR = 'worker-exports';
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;
