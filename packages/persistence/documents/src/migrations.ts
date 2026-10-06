import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  type TableColumnOptions,
} from 'typeorm';
import { BINARY_COLLATION, DOCUMENT_TABLES } from './entities.js';

export const DOCUMENTS_MIGRATION_VERSION = '2026100600060';
export const DOCUMENTS_MIGRATIONS_TABLE = 'opslog_documents_migrations';

const text = (name: string, length: number, extra: Partial<TableColumnOptions> = {}) =>
  ({
    name,
    type: 'varchar',
    length: String(length),
    collation: BINARY_COLLATION,
    ...extra,
  }) satisfies TableColumnOptions;
const fixed = (name: string, length: number, extra: Partial<TableColumnOptions> = {}) =>
  ({
    name,
    type: 'char',
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

const T = DOCUMENT_TABLES;
const DATE = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'";

/** A date column is NULL or a `YYYY-MM-DD` string. */
const dateOrNull = (column: string): string =>
  `(\`${column}\` IS NULL OR \`${column}\` REGEXP ${DATE})`;
/** Expiry never precedes issue (both are ISO dates, so string order is date order). */
const ordered = '(`issued_on` IS NULL OR `expires_on` IS NULL OR `expires_on` >= `issued_on`)';

/** CHECK constraints (MySQL >= 8.0.16 enforces them). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const DOCUMENT_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.documents,
    name: 'ck_documents_owner',
    expression:
      "((`owner_type` = 'vehicle' AND `vehicle_id` IS NOT NULL AND `employee_id` IS NULL) OR " +
      "(`owner_type` = 'employee' AND `employee_id` IS NOT NULL AND `vehicle_id` IS NULL))",
  },
  {
    table: T.documents,
    name: 'ck_documents_type',
    expression: "`type_code` REGEXP '^[a-z][a-z0-9_]{1,31}$'",
  },
  {
    table: T.documents,
    name: 'ck_documents_title',
    expression:
      'CHAR_LENGTH(TRIM(`title`)) > 0 AND (`notes` IS NULL OR CHAR_LENGTH(TRIM(`notes`)) > 0)',
  },
  {
    table: T.documents,
    name: 'ck_documents_counters',
    expression: '`version` >= 1 AND `revision` >= 1 AND `revision` <= `version`',
  },
  {
    table: T.documents,
    name: 'ck_documents_dates',
    expression: `${dateOrNull('issued_on')} AND ${dateOrNull('expires_on')} AND ${ordered}`,
  },
  {
    table: T.documents,
    name: 'ck_documents_expiry_key',
    expression: "`expiry_key` = COALESCE(`expires_on`, '9999-12-31')",
  },
  {
    table: T.documents,
    name: 'ck_documents_number',
    expression: '(`document_number` IS NULL OR CHAR_LENGTH(TRIM(`document_number`)) > 0)',
  },
  {
    table: T.revisions,
    name: 'ck_document_revisions_shape',
    expression: `\`revision\` >= 1 AND ${dateOrNull('issued_on')} AND ${dateOrNull('expires_on')} AND ${ordered}`,
  },
];

/**
 * Documents and their immutable revision snapshots. Every row carries `company_id`; a revision
 * references the composite `(company_id, id)` key of its document, so it can never attach to a
 * document of another company. Nothing in the store updates or deletes a revision row.
 * The owner of a document is one of two typed columns (exactly one is set); foreign keys to the
 * vehicle and employee tables are not declared because those tables belong to other modules and
 * migrations (the owner is validated by the service; see the task document).
 */
export class CreateDocuments2026100600060 implements MigrationInterface {
  name = 'CreateDocuments2026100600060';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.documents,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('owner_type', 16),
          text('vehicle_id', 64, nullable),
          text('employee_id', 64, nullable),
          text('type_code', 32),
          text('title', 80),
          text('notes', 500, nullable),
          counter('revision'),
          fixed('issued_on', 10, nullable),
          fixed('expires_on', 10, nullable),
          fixed('expiry_key', 10),
          text('document_number', 40, nullable),
          counter('version'),
          moment('created_at'),
          moment('updated_at'),
          moment('archived_at', true),
        ],
        indices: [
          new TableIndex({
            name: 'ix_documents_vehicle',
            columnNames: ['company_id', 'vehicle_id'],
          }),
          new TableIndex({
            name: 'ix_documents_employee',
            columnNames: ['company_id', 'employee_id'],
          }),
          new TableIndex({ name: 'ix_documents_type', columnNames: ['company_id', 'type_code'] }),
          new TableIndex({
            name: 'ix_documents_listing',
            columnNames: ['company_id', 'expiry_key', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.revisions,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('document_id', 64, { isPrimary: true }),
          counter('revision', { isPrimary: true }),
          fixed('issued_on', 10, nullable),
          fixed('expires_on', 10, nullable),
          text('document_number', 40, nullable),
          text('actor_id', 64),
          moment('at'),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_document_revisions_document',
            columnNames: ['company_id', 'document_id'],
            referencedTableName: T.documents,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    for (const check of DOCUMENT_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.revisions);
    await queryRunner.dropTable(T.documents);
  }
}
