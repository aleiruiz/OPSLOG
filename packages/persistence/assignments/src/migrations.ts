import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  type TableColumnOptions,
} from 'typeorm';
import { ASSIGNMENT_TABLES, BINARY_COLLATION } from './entities.js';

export const ASSIGNMENTS_MIGRATION_VERSION = '2026100600080';
export const ASSIGNMENTS_MIGRATIONS_TABLE = 'opslog_assignments_migrations';

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
const flag = (name: string): TableColumnOptions => ({
  name,
  type: 'tinyint',
  unsigned: true,
  isNullable: true,
});
const nullable = { isNullable: true } as const;

const T = ASSIGNMENT_TABLES;

/**
 * Every CHECK is NULL-safe (`IS TRUE`): MySQL accepts a CHECK that evaluates to NULL, so a bare
 * expression over nullable columns would let illegal combinations through.
 */
const TYPES = "`type` IN ('principal', 'secondary', 'temporary')";
/**
 * Current rows carry no end data and `current_flag = 1`; ended rows carry the whole end (kind,
 * reason, actor), a version beyond the first, no current flag, and never end before they start.
 */
const lifecycle =
  '(((`ended_at` IS NULL AND `end_kind` IS NULL AND `end_reason` IS NULL AND `ended_by` IS NULL AND `current_flag` = 1) OR ' +
  "(`ended_at` IS NOT NULL AND `end_kind` IN ('ended', 'replaced') AND `end_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`end_reason`)) > 0 AND `ended_by` IS NOT NULL AND `current_flag` IS NULL AND `ended_at` >= `started_at` AND `version` >= 2)) IS TRUE)";
/** `principal_flag` is 1 exactly for a current principal (what the unique keys on it rely on). */
const principal =
  "(((`type` = 'principal' AND `ended_at` IS NULL AND `principal_flag` = 1) OR " +
  "(NOT (`type` = 'principal' AND `ended_at` IS NULL) AND `principal_flag` IS NULL)) IS TRUE)";

/** CHECK constraints (MySQL >= 8.0.16 enforces them). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const ASSIGNMENT_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.assignments,
    name: 'ck_assignments_shape',
    expression: `${TYPES} AND \`version\` >= 1 AND CHAR_LENGTH(TRIM(\`reason\`)) > 0`,
  },
  { table: T.assignments, name: 'ck_assignments_lifecycle', expression: lifecycle },
  { table: T.assignments, name: 'ck_assignments_principal', expression: principal },
  {
    table: T.events,
    name: 'ck_assignment_events_shape',
    expression:
      "(((`seq` = 1 AND `kind` = 'assigned') OR (`seq` = 2 AND `kind` IN ('ended', 'replaced'))) IS TRUE) AND CHAR_LENGTH(TRIM(`reason`)) > 0",
  },
];

/**
 * Vehicle assignments and their append-only events. Every row carries `company_id`; an event
 * references the composite `(company_id, id)` key of its assignment, so it can never attach to an
 * assignment of another company. Nothing in the store updates or deletes an event row, nor deletes
 * an assignment (the runtime account is not granted it). Foreign keys to the vehicle and employee
 * tables are not declared because those tables belong to other modules and migrations (the service
 * validates both; see the task document).
 */
export class CreateVehicleAssignments2026100600080 implements MigrationInterface {
  name = 'CreateVehicleAssignments2026100600080';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.assignments,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('vehicle_id', 64),
          text('employee_id', 64),
          text('type', 16),
          text('reason', 200),
          text('assigned_by', 64),
          moment('started_at'),
          moment('ended_at', true),
          text('end_kind', 8, nullable),
          text('end_reason', 200, nullable),
          text('ended_by', 64, nullable),
          flag('current_flag'),
          flag('principal_flag'),
          counter('version'),
          moment('updated_at'),
        ],
        indices: [
          new TableIndex({
            name: 'ix_assignments_vehicle',
            columnNames: ['company_id', 'vehicle_id', 'started_at'],
          }),
          new TableIndex({
            name: 'ix_assignments_employee',
            columnNames: ['company_id', 'employee_id', 'started_at'],
          }),
          new TableIndex({
            name: 'ix_assignments_listing',
            columnNames: ['company_id', 'started_at', 'id'],
          }),
          new TableIndex({
            name: 'ux_assignments_current_pair',
            columnNames: ['company_id', 'vehicle_id', 'employee_id', 'current_flag'],
            isUnique: true,
          }),
          new TableIndex({
            name: 'ux_assignments_principal_vehicle',
            columnNames: ['company_id', 'vehicle_id', 'principal_flag'],
            isUnique: true,
          }),
          new TableIndex({
            name: 'ux_assignments_principal_employee',
            columnNames: ['company_id', 'employee_id', 'principal_flag'],
            isUnique: true,
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.events,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('assignment_id', 64, { isPrimary: true }),
          counter('seq', { isPrimary: true }),
          text('kind', 8),
          text('actor_id', 64),
          text('reason', 200),
          moment('at'),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_assignment_events_assignment',
            columnNames: ['company_id', 'assignment_id'],
            referencedTableName: T.assignments,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    for (const check of ASSIGNMENT_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.events);
    await queryRunner.dropTable(T.assignments);
  }
}
