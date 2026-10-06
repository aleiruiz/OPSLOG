import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: keys are compared exactly as normalized
 * by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const IMPORT_TABLES = {
  jobs: 'opslog_import_jobs',
  rows: 'opslog_import_job_rows',
  events: 'opslog_import_job_events',
} as const;

/**
 * Import job. `tenantId` is the BRD's `company_id`: part of every primary key and index, so no query
 * can reach a row without naming its company. `idempotencyKey` is unique per company (NULLs never
 * collide: a dry run may omit it) and is what makes a retried request return the same job. Counts
 * only change once, when the job finishes. The table holds no imported value, only counts.
 */
export class ImportJobEntity {
  tenantId!: string;
  id!: string;
  entity!: string;
  mode!: string;
  status!: string;
  idempotencyKey!: string | null;
  fingerprint!: string;
  totalRows!: number;
  validRows!: number;
  invalidRows!: number;
  importedRows!: number;
  createdBy!: string;
  createdAt!: Date;
  finishedAt!: Date | null;
  version!: number;
  updatedAt!: Date;
}

/**
 * Append-only result of one row of a job: a row number, an outcome, a code and the names of the
 * template columns at fault. Never a submitted value. Written once, never updated or deleted.
 */
export class ImportRowEntity {
  tenantId!: string;
  jobId!: string;
  rowNumber!: number;
  outcome!: string;
  code!: string | null;
  columnNames!: string | null;
  entityId!: string | null;
  at!: Date;
}

/** Append-only lifecycle history of a job. */
export class ImportEventEntity {
  tenantId!: string;
  jobId!: string;
  seq!: number;
  kind!: string;
  actorId!: string;
  acceptedRows!: number | null;
  rejectedRows!: number | null;
  at!: Date;
}

const bin = BINARY_COLLATION;
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length,
  collation: bin,
  ...(nullable ? { nullable: true } : {}),
});
const counter = (name: string, nullable = false) => ({
  name,
  type: 'int' as const,
  unsigned: true,
  ...(nullable ? { nullable: true } : {}),
});
const moment = (name: string, nullable = false) => ({
  name,
  type: 'datetime' as const,
  precision: 6,
  ...(nullable ? { nullable: true } : {}),
});

export const ImportJobEntitySchema = new EntitySchema<ImportJobEntity>({
  name: 'ImportJobEntity',
  target: ImportJobEntity,
  tableName: IMPORT_TABLES.jobs,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    entity: text('entity', 16),
    mode: text('mode', 16),
    status: text('status', 16),
    idempotencyKey: text('idempotency_key', 64, true),
    fingerprint: text('fingerprint', 64),
    totalRows: counter('total_rows'),
    validRows: counter('valid_rows'),
    invalidRows: counter('invalid_rows'),
    importedRows: counter('imported_rows'),
    createdBy: text('created_by', 64),
    createdAt: moment('created_at'),
    finishedAt: moment('finished_at', true),
    version: { type: 'int', unsigned: true },
    updatedAt: moment('updated_at'),
  },
  indices: [
    { name: 'ix_import_jobs_listing', columns: ['tenantId', 'createdAt', 'id'] },
    { name: 'ix_import_jobs_entity', columns: ['tenantId', 'entity', 'createdAt'] },
  ],
  uniques: [{ name: 'ux_import_jobs_key', columns: ['tenantId', 'idempotencyKey'] }],
});

export const ImportRowEntitySchema = new EntitySchema<ImportRowEntity>({
  name: 'ImportRowEntity',
  target: ImportRowEntity,
  tableName: IMPORT_TABLES.rows,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    jobId: { ...text('job_id', 64), primary: true },
    rowNumber: { ...counter('row_number'), primary: true },
    outcome: text('outcome', 8),
    code: text('code', 24, true),
    columnNames: text('column_names', 255, true),
    entityId: text('entity_id', 64, true),
    at: moment('at'),
  },
  indices: [
    { name: 'ix_import_rows_outcome', columns: ['tenantId', 'jobId', 'outcome', 'rowNumber'] },
  ],
});

export const ImportEventEntitySchema = new EntitySchema<ImportEventEntity>({
  name: 'ImportEventEntity',
  target: ImportEventEntity,
  tableName: IMPORT_TABLES.events,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    jobId: { ...text('job_id', 64), primary: true },
    seq: { ...counter('seq'), primary: true },
    kind: text('kind', 16),
    actorId: text('actor_id', 64),
    acceptedRows: counter('accepted_rows', true),
    rejectedRows: counter('rejected_rows', true),
    at: moment('at'),
  },
});

export const IMPORT_ORM_ENTITIES = [
  ImportJobEntitySchema,
  ImportRowEntitySchema,
  ImportEventEntitySchema,
] as const;
