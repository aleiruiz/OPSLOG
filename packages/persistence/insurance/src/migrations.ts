import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  type TableColumnOptions,
} from 'typeorm';
import { BINARY_COLLATION, POLICY_TABLES } from './entities.js';

export const INSURANCE_MIGRATION_VERSION = '2026100600070';
export const INSURANCE_MIGRATIONS_TABLE = 'opslog_insurance_migrations';

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

const T = POLICY_TABLES;
const DATE = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'";

/** A required date column is a `YYYY-MM-DD` string. */
const dateOf = (column: string): string => `\`${column}\` REGEXP ${DATE}`;
/** The end never precedes the start (both are ISO dates, so string order is date order). */
const ordered = '`ends_on` >= `starts_on`';
/**
 * The deductible columns agree: none (all NULL), an amount (positive whole minor units with an
 * ISO currency) or a percentage (1 to 10 000 basis points, no currency). `IS TRUE` makes the
 * check NULL-safe: a NULL kind with a value would otherwise evaluate to NULL, which MySQL accepts.
 */
const deductible =
  '(((`deductible_kind` IS NULL AND `deductible_value` IS NULL AND `deductible_currency` IS NULL) OR ' +
  "(`deductible_kind` = 'amount' AND `deductible_value` IS NOT NULL AND `deductible_value` BETWEEN 1 AND 1000000000000 AND `deductible_currency` IS NOT NULL AND `deductible_currency` REGEXP '^[A-Z]{3}$') OR " +
  "(`deductible_kind` = 'percent' AND `deductible_value` IS NOT NULL AND `deductible_value` BETWEEN 1 AND 10000 AND `deductible_currency` IS NULL)) IS TRUE)";
const COVERAGE_TYPES =
  "`coverage_type` IN ('mandatory_liability', 'third_party', 'comprehensive', 'other')";
const NUMBER = '(CHAR_LENGTH(TRIM(`policy_number`)) > 0)';

/** CHECK constraints (MySQL >= 8.0.16 enforces them). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const POLICY_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.policies,
    name: 'ck_policies_text',
    expression:
      'CHAR_LENGTH(TRIM(`insurer`)) > 1 AND (`coverage_notes` IS NULL OR CHAR_LENGTH(TRIM(`coverage_notes`)) > 0)',
  },
  { table: T.policies, name: 'ck_policies_number', expression: NUMBER },
  { table: T.policies, name: 'ck_policies_coverage', expression: COVERAGE_TYPES },
  {
    table: T.policies,
    name: 'ck_policies_counters',
    expression: '`version` >= 1 AND `revision` >= 1 AND `revision` <= `version`',
  },
  {
    table: T.policies,
    name: 'ck_policies_dates',
    expression: `${dateOf('starts_on')} AND ${dateOf('ends_on')} AND ${ordered}`,
  },
  { table: T.policies, name: 'ck_policies_deductible', expression: deductible },
  {
    table: T.revisions,
    name: 'ck_policy_revisions_shape',
    expression: `\`revision\` >= 1 AND ${NUMBER} AND ${COVERAGE_TYPES} AND ${dateOf('starts_on')} AND ${dateOf('ends_on')} AND ${ordered} AND ${deductible}`,
  },
];

/**
 * Vehicle insurance policies and their immutable revision snapshots. Every row carries
 * `company_id`; a revision references the composite `(company_id, id)` key of its policy, so it can
 * never attach to a policy of another company. Nothing in the store updates or deletes a revision
 * row (and the runtime account is not granted it). A foreign key to the vehicle table is not
 * declared because that table belongs to another module and migration (the vehicle is validated
 * by the service; see the task document).
 */
export class CreateInsurancePolicies2026100600070 implements MigrationInterface {
  name = 'CreateInsurancePolicies2026100600070';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.policies,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('vehicle_id', 64),
          text('insurer', 80),
          text('coverage_notes', 500, nullable),
          counter('revision'),
          text('policy_number', 40),
          text('coverage_type', 24),
          fixed('starts_on', 10),
          fixed('ends_on', 10),
          text('deductible_kind', 8, nullable),
          { name: 'deductible_value', type: 'bigint', unsigned: true, isNullable: true },
          fixed('deductible_currency', 3, nullable),
          counter('version'),
          moment('created_at'),
          moment('updated_at'),
          moment('archived_at', true),
        ],
        indices: [
          new TableIndex({
            name: 'ix_policies_vehicle',
            columnNames: ['company_id', 'vehicle_id'],
          }),
          new TableIndex({
            name: 'ix_policies_coverage',
            columnNames: ['company_id', 'coverage_type'],
          }),
          new TableIndex({
            name: 'ix_policies_listing',
            columnNames: ['company_id', 'ends_on', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.revisions,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('policy_id', 64, { isPrimary: true }),
          counter('revision', { isPrimary: true }),
          text('policy_number', 40),
          text('coverage_type', 24),
          fixed('starts_on', 10),
          fixed('ends_on', 10),
          text('deductible_kind', 8, nullable),
          { name: 'deductible_value', type: 'bigint', unsigned: true, isNullable: true },
          fixed('deductible_currency', 3, nullable),
          text('actor_id', 64),
          moment('at'),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_policy_revisions_policy',
            columnNames: ['company_id', 'policy_id'],
            referencedTableName: T.policies,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    for (const check of POLICY_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.revisions);
    await queryRunner.dropTable(T.policies);
  }
}
