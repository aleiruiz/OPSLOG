import { EntitySchema } from 'typeorm';

export const EXPORT_TABLES = { jobs: 'opslog_export_jobs' } as const;

export const BINARY_COLLATION = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: BINARY_COLLATION,
  nullable,
});
const instant = (name: string, nullable = false) => ({
  name,
  type: 'datetime' as const,
  precision: 6,
  nullable,
});

export class ExportJobEntity {
  tenantId!: string;
  id!: string;
  actorId!: string;
  sessionId!: string;
  reportId!: string;
  format!: string;
  filters!: Record<string, string>;
  columns!: string[];
  sort!: string;
  direction!: string;
  mode!: string;
  status!: string;
  rowCount!: number | null;
  byteSize!: number | null;
  sha256!: string | null;
  fileName!: string | null;
  failure!: string | null;
  idempotencyKey!: string | null;
  requestHash!: string;
  attempts!: number;
  createdAt!: Date;
  startedAt!: Date | null;
  finishedAt!: Date | null;
  expiresAt!: Date | null;
  leaseUntil!: Date | null;
}

/** One row per export job. Rows are never deleted: a job that outlived its file reads `expired`. */
export const ExportJobSchema = new EntitySchema<ExportJobEntity>({
  name: 'ExportJobEntity',
  target: ExportJobEntity,
  tableName: EXPORT_TABLES.jobs,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    actorId: text('actor_id', 64),
    sessionId: text('session_id', 64),
    reportId: text('report_id', 48),
    format: text('format', 8),
    filters: { name: 'filters', type: 'json' },
    columns: { name: 'columns', type: 'json' },
    sort: text('sort', 48),
    direction: text('direction', 4),
    mode: text('mode', 8),
    status: text('status', 12),
    rowCount: { name: 'row_count', type: 'int', nullable: true },
    byteSize: {
      name: 'byte_size',
      type: 'bigint',
      nullable: true,
      transformer: {
        to: (v: number | null) => v,
        from: (v: string | number | null) => (v === null ? null : Number(v)),
      },
    },
    sha256: {
      name: 'sha256',
      type: 'char',
      length: '64',
      collation: BINARY_COLLATION,
      nullable: true,
    },
    fileName: text('file_name', 120, true),
    failure: text('failure', 24, true),
    idempotencyKey: text('idempotency_key', 128, true),
    requestHash: { name: 'request_hash', type: 'char', length: '64', collation: BINARY_COLLATION },
    attempts: { name: 'attempts', type: 'int' },
    createdAt: instant('created_at'),
    startedAt: instant('started_at', true),
    finishedAt: instant('finished_at', true),
    expiresAt: instant('expires_at', true),
    leaseUntil: instant('lease_until', true),
  },
});

export const EXPORT_ENTITIES = [ExportJobSchema];
