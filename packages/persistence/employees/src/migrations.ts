import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  TableUnique,
  type TableColumnOptions,
} from 'typeorm';
import { BINARY_COLLATION, EMPLOYEE_TABLES, SEALED_LENGTH } from './entities.js';

export const EMPLOYEES_MIGRATION_VERSION = '2026100600050';
export const EMPLOYEES_MIGRATIONS_TABLE = 'opslog_employees_migrations';

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
const counter = (name: string): TableColumnOptions => ({ name, type: 'int', unsigned: true });
const nullable = { isNullable: true } as const;

const T = EMPLOYEE_TABLES;
const KINDS = "'driver','dispatcher','other'";
const STATUSES = "'active','inactive','suspended','terminated'";
const DATE = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'";
const INDEX = "'^[0-9a-f]{64}$'";

/** Both columns are NULL or neither is: a sealed value never exists without its index (and vice versa). */
const paired = (left: string, right: string): string =>
  `((\`${left}\` IS NULL) = (\`${right}\` IS NULL))`;
/** A PII column holds an envelope (`pii1.` prefix), never a bare value. */
const sealed = (column: string): string => `(\`${column}\` IS NULL OR \`${column}\` LIKE 'pii1.%')`;

/** CHECK constraints (MySQL >= 8.0.16 enforces them). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const EMPLOYEE_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  { table: T.employees, name: 'ck_employees_kind', expression: `\`kind\` IN (${KINDS})` },
  { table: T.employees, name: 'ck_employees_status', expression: `\`status\` IN (${STATUSES})` },
  { table: T.employees, name: 'ck_employees_version', expression: '`version` >= 1' },
  {
    table: T.employees,
    name: 'ck_employees_names',
    expression:
      'CHAR_LENGTH(TRIM(`first_name`)) > 0 AND CHAR_LENGTH(TRIM(`last_name`)) > 0 AND CHAR_LENGTH(`name_key`) > 0',
  },
  {
    table: T.employees,
    name: 'ck_employees_number',
    expression:
      '((`employee_number` IS NULL) = (`employee_number_key` IS NULL)) AND (`employee_number` IS NULL OR CHAR_LENGTH(`employee_number_key`) > 0)',
  },
  {
    table: T.employees,
    name: 'ck_employees_dates',
    expression: `(\`hire_date\` IS NULL OR \`hire_date\` REGEXP ${DATE}) AND (\`license_expires_on\` IS NULL OR \`license_expires_on\` REGEXP ${DATE})`,
  },
  {
    table: T.employees,
    name: 'ck_employees_reason',
    expression: 'CHAR_LENGTH(TRIM(`status_reason`)) > 0',
  },
  {
    table: T.employees,
    name: 'ck_employees_pii_sealed',
    expression: [
      sealed('national_id_enc'),
      sealed('phone_enc'),
      sealed('email_enc'),
      sealed('license_number_enc'),
    ].join(' AND '),
  },
  {
    table: T.employees,
    name: 'ck_employees_pii_pairs',
    expression: [
      paired('national_id_enc', 'national_id_idx'),
      paired('national_id_enc', 'id_type'),
      paired('email_enc', 'email_idx'),
      paired('license_number_enc', 'license_number_idx'),
    ].join(' AND '),
  },
  {
    table: T.employees,
    name: 'ck_employees_pii_index',
    expression: [
      `(\`national_id_idx\` IS NULL OR \`national_id_idx\` REGEXP ${INDEX})`,
      `(\`email_idx\` IS NULL OR \`email_idx\` REGEXP ${INDEX})`,
      `(\`license_number_idx\` IS NULL OR \`license_number_idx\` REGEXP ${INDEX})`,
    ].join(' AND '),
  },
  {
    table: T.employees,
    name: 'ck_employees_license_driver',
    expression:
      "`kind` = 'driver' OR (`license_number_enc` IS NULL AND `license_type` IS NULL AND `license_expires_on` IS NULL)",
  },
  {
    table: T.history,
    name: 'ck_employee_history_shape',
    expression:
      '`version` >= 1 AND (' +
      "(`kind` = 'status' AND `to_value` IN (" +
      STATUSES +
      ') AND (`from_value` IS NULL OR `from_value` IN (' +
      STATUSES +
      ')) AND `reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`reason`)) > 0)' +
      " OR (`kind` = 'area' AND `from_value` IS NOT NULL AND `reason` IS NULL))",
  },
];

/**
 * Employees and their change history. Every row carries `company_id`; the history references the
 * composite `(company_id, id)` key of its employee, so a history row can never attach to an
 * employee of another company. Employee number, identification and e-mail are unique per company
 * (BR-011); identification and e-mail are compared through their HMAC blind indexes, never their
 * values (SPECS D23).
 */
export class CreateEmployees2026100600050 implements MigrationInterface {
  name = 'CreateEmployees2026100600050';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.employees,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('kind', 16),
          text('first_name', 60),
          text('last_name', 60),
          text('name_key', 121),
          text('employee_number', 32, nullable),
          text('employee_number_key', 32, nullable),
          text('position', 60, nullable),
          fixed('hire_date', 10, nullable),
          text('area_id', 64),
          text('status', 16),
          text('status_reason', 200),
          text('id_type', 16, nullable),
          text('national_id_enc', SEALED_LENGTH, nullable),
          fixed('national_id_idx', 64, nullable),
          text('phone_enc', SEALED_LENGTH, nullable),
          text('email_enc', SEALED_LENGTH, nullable),
          fixed('email_idx', 64, nullable),
          text('license_number_enc', SEALED_LENGTH, nullable),
          fixed('license_number_idx', 64, nullable),
          text('license_type', 16, nullable),
          fixed('license_expires_on', 10, nullable),
          counter('version'),
          moment('created_at'),
          moment('updated_at'),
          moment('archived_at', true),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_employees_number',
            columnNames: ['company_id', 'employee_number_key'],
          }),
          new TableUnique({
            name: 'uq_employees_national_id',
            columnNames: ['company_id', 'national_id_idx'],
          }),
          new TableUnique({
            name: 'uq_employees_email',
            columnNames: ['company_id', 'email_idx'],
          }),
        ],
        indices: [
          new TableIndex({ name: 'ix_employees_status', columnNames: ['company_id', 'status'] }),
          new TableIndex({ name: 'ix_employees_area', columnNames: ['company_id', 'area_id'] }),
          new TableIndex({
            name: 'ix_employees_license',
            columnNames: ['company_id', 'license_number_idx'],
          }),
          new TableIndex({
            name: 'ix_employees_listing',
            columnNames: ['company_id', 'name_key', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.history,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('employee_id', 64),
          text('kind', 8),
          text('from_value', 64, nullable),
          text('to_value', 64),
          text('reason', 200, nullable),
          text('actor_id', 64),
          counter('version'),
          moment('at'),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_employee_history_version',
            columnNames: ['company_id', 'employee_id', 'version'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_employee_history_employee',
            columnNames: ['company_id', 'employee_id'],
            referencedTableName: T.employees,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    for (const check of EMPLOYEE_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.history);
    await queryRunner.dropTable(T.employees);
  }
}
