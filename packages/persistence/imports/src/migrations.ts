import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  type TableColumnOptions,
} from 'typeorm';
import { BINARY_COLLATION, IMPORT_TABLES } from './entities.js';

export const IMPORTS_MIGRATION_VERSION = '2026100600090';
export const IMPORTS_MIGRATIONS_TABLE = 'opslog_imports_migrations';

const text = (name: string, length: number, extra: Partial<TableColumnOptions> = {}) =>
  ({
    name,
    type: 'varchar',
    length: String(length),
    collation: BINARY_COLLATION,
    ...extra,
  }) satisfies TableColumnOptions;
const moment = (name: string, nullable = false): TableColumnOptions => ({
  name,
  type: 'datetime',
  precision: 6,
  isNullable: nullable,
});
const counter = (name: string, extra: Partial<TableColumnOptions> = {}): TableColumnOptions => ({
  name,
  type: 'int',
  unsigned: true,
  ...extra,
});
const nullable = { isNullable: true } as const;

const T = IMPORT_TABLES;

/**
 * Every CHECK is NULL-safe (`IS TRUE`): MySQL accepts a CHECK that evaluates to NULL, so a bare
 * expression over nullable columns would let illegal combinations through.
 */
const SHAPE =
  "(`entity` IN ('vehicle', 'employee') AND `mode` IN ('dry_run', 'commit_all', 'commit_valid') AND " +
  "`status` IN ('running', 'validated', 'imported', 'failed') AND `version` >= 1 AND " +
  '`total_rows` BETWEEN 1 AND 500 AND `valid_rows` + `invalid_rows` <= `total_rows` AND ' +
  '`imported_rows` <= `valid_rows` AND CHAR_LENGTH(`fingerprint`) = 64 AND CHAR_LENGTH(TRIM(`created_by`)) > 0) IS TRUE';
/** A running job is untouched (version 1, no counts); a finished one has its end and a version beyond the first. */
const LIFECYCLE =
  "(((`status` = 'running' AND `finished_at` IS NULL AND `version` = 1 AND `valid_rows` = 0 AND `invalid_rows` = 0 AND `imported_rows` = 0) OR " +
  "(`status` <> 'running' AND `finished_at` IS NOT NULL AND `finished_at` >= `created_at` AND `version` >= 2 AND `valid_rows` + `invalid_rows` = `total_rows`)) IS TRUE)";
/**
 * A dry run only validates and writes nothing; a commit needs its idempotency key and ends
 * `imported` (something was written) or `failed` (nothing was).
 */
const MODE =
  "(((`mode` = 'dry_run' AND `status` IN ('running', 'validated') AND `imported_rows` = 0) OR " +
  "(`mode` <> 'dry_run' AND `idempotency_key` IS NOT NULL AND (" +
  "`status` = 'running' OR (`status` = 'imported' AND `imported_rows` >= 1) OR (`status` = 'failed' AND `imported_rows` = 0)))) IS TRUE)";
const ROW_SHAPE =
  '(`row_number` BETWEEN 1 AND 500 AND (' +
  "(`outcome` IN ('valid', 'skipped') AND `code` IS NULL AND `column_names` IS NULL AND `entity_id` IS NULL) OR " +
  "(`outcome` = 'invalid' AND `code` IN ('missing_value', 'invalid_value', 'formula_injection', 'duplicate', 'duplicate_in_file', 'invalid_area') AND `entity_id` IS NULL) OR " +
  "(`outcome` = 'imported' AND `code` IS NULL AND `column_names` IS NULL AND `entity_id` IS NOT NULL))) IS TRUE";
const EVENT_SHAPE =
  "(((`seq` = 1 AND `kind` = 'started' AND `accepted_rows` IS NULL AND `rejected_rows` IS NULL) OR " +
  "(`seq` = 2 AND `kind` IN ('validated', 'imported', 'failed') AND `accepted_rows` IS NOT NULL AND `rejected_rows` IS NOT NULL)) IS TRUE) AND " +
  'CHAR_LENGTH(TRIM(`actor_id`)) > 0';

/** CHECK constraints (MySQL >= 8.0.16 enforces them). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const IMPORT_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  { table: T.jobs, name: 'ck_import_jobs_shape', expression: SHAPE },
  { table: T.jobs, name: 'ck_import_jobs_lifecycle', expression: LIFECYCLE },
  { table: T.jobs, name: 'ck_import_jobs_mode', expression: MODE },
  { table: T.rows, name: 'ck_import_rows_shape', expression: ROW_SHAPE },
  { table: T.events, name: 'ck_import_events_shape', expression: EVENT_SHAPE },
];

/**
 * Import jobs, their per-row results and their lifecycle events. Every row carries `company_id`; a
 * result or an event references the composite `(company_id, id)` key of its job, so it can never
 * attach to a job of another company. Results and events are only inserted; nothing in the store
 * deletes a row (the runtime account is not granted it). No column holds an imported value.
 */
export class CreateImportJobs2026100600090 implements MigrationInterface {
  name = 'CreateImportJobs2026100600090';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.jobs,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('entity', 16),
          text('mode', 16),
          text('status', 16),
          text('idempotency_key', 64, nullable),
          text('fingerprint', 64),
          counter('total_rows'),
          counter('valid_rows'),
          counter('invalid_rows'),
          counter('imported_rows'),
          text('created_by', 64),
          moment('created_at'),
          moment('finished_at', true),
          counter('version'),
          moment('updated_at'),
        ],
        indices: [
          new TableIndex({
            name: 'ix_import_jobs_listing',
            columnNames: ['company_id', 'created_at', 'id'],
          }),
          new TableIndex({
            name: 'ix_import_jobs_entity',
            columnNames: ['company_id', 'entity', 'created_at'],
          }),
          new TableIndex({
            name: 'ux_import_jobs_key',
            columnNames: ['company_id', 'idempotency_key'],
            isUnique: true,
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.rows,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('job_id', 64, { isPrimary: true }),
          counter('row_number', { isPrimary: true }),
          text('outcome', 8),
          text('code', 24, nullable),
          text('column_names', 255, nullable),
          text('entity_id', 64, nullable),
          moment('at'),
        ],
        indices: [
          new TableIndex({
            name: 'ix_import_rows_outcome',
            columnNames: ['company_id', 'job_id', 'outcome', 'row_number'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_import_rows_job',
            columnNames: ['company_id', 'job_id'],
            referencedTableName: T.jobs,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.events,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('job_id', 64, { isPrimary: true }),
          counter('seq', { isPrimary: true }),
          text('kind', 16),
          text('actor_id', 64),
          counter('accepted_rows', nullable),
          counter('rejected_rows', nullable),
          moment('at'),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_import_events_job',
            columnNames: ['company_id', 'job_id'],
            referencedTableName: T.jobs,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    for (const check of IMPORT_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.events);
    await queryRunner.dropTable(T.rows);
    await queryRunner.dropTable(T.jobs);
  }
}
