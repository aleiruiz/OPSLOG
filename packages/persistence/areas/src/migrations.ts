import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  TableUnique,
  type TableColumnOptions,
} from 'typeorm';
import { BINARY_COLLATION, AREA_TABLES } from './entities.js';

export const AREAS_MIGRATION_VERSION = '2026100600040';
export const AREAS_MIGRATIONS_TABLE = 'opslog_areas_migrations';

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
const counter = (name: string): TableColumnOptions => ({ name, type: 'int', unsigned: true });

const T = AREA_TABLES;
const ACTIONS = "'created','updated','activated','deactivated'";

/** CHECK constraints (MySQL >= 8.0.16 enforces them). TypeORM's MySQL runner cannot emit them, so they are raw DDL. */
export const AREA_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    // The tree depth is also enforced by the database: FR-040 allows four levels.
    table: T.areas,
    name: 'ck_areas_depth',
    expression:
      '`depth` BETWEEN 1 AND 4 AND ((`parent_id` IS NULL AND `depth` = 1) OR (`parent_id` IS NOT NULL AND `depth` > 1))',
  },
  {
    table: T.areas,
    name: 'ck_areas_parent',
    expression:
      "`parent_key` = COALESCE(`parent_id`, '') AND (`parent_id` IS NULL OR `parent_id` <> `id`)",
  },
  {
    table: T.areas,
    name: 'ck_areas_active',
    expression:
      '(`active` = 1 AND `deactivated_at` IS NULL) OR (`active` = 0 AND `deactivated_at` IS NOT NULL)',
  },
  {
    table: T.areas,
    name: 'ck_areas_version',
    expression: '`version` >= 1',
  },
  {
    table: T.areas,
    name: 'ck_areas_name',
    expression: 'CHAR_LENGTH(TRIM(`name`)) > 0 AND CHAR_LENGTH(`name_key`) > 0',
  },
  {
    table: T.areas,
    name: 'ck_areas_code',
    expression: "`code` IS NULL OR `code` REGEXP '^[A-Z0-9][A-Z0-9._-]{0,31}$'",
  },
  {
    table: T.history,
    name: 'ck_area_history_action',
    expression: `\`action\` IN (${ACTIONS}) AND \`version\` >= 1`,
  },
];

/**
 * Areas, their responsible users, their history and the per-company lock row. Every row carries
 * `company_id`; each child references the composite `(company_id, id)` key of its area (and the
 * parent link of an area does too), so nothing can attach to an area of another company. Names are
 * unique among siblings and codes unique per company.
 */
export class CreateAreas2026100600040 implements MigrationInterface {
  name = 'CreateAreas2026100600040';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.areas,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('name', 80),
          text('name_key', 160),
          text('code', 32, { isNullable: true }),
          text('parent_id', 64, { isNullable: true }),
          text('parent_key', 64),
          { name: 'depth', type: 'tinyint', unsigned: true },
          { name: 'active', type: 'boolean' },
          counter('version'),
          moment('created_at'),
          moment('updated_at'),
          moment('deactivated_at', true),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_areas_sibling_name',
            columnNames: ['company_id', 'parent_key', 'name_key'],
          }),
          new TableUnique({ name: 'uq_areas_code', columnNames: ['company_id', 'code'] }),
        ],
        indices: [
          new TableIndex({ name: 'ix_areas_parent', columnNames: ['company_id', 'parent_id'] }),
          new TableIndex({
            name: 'ix_areas_listing',
            columnNames: ['company_id', 'name_key', 'id'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_areas_parent',
            columnNames: ['company_id', 'parent_id'],
            referencedTableName: T.areas,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: T.responsibles,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          text('area_id', 64, { isPrimary: true }),
          text('user_id', 64, { isPrimary: true }),
        ],
        indices: [
          new TableIndex({
            name: 'ix_area_responsibles_user',
            columnNames: ['company_id', 'user_id'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_area_responsibles_area',
            columnNames: ['company_id', 'area_id'],
            referencedTableName: T.areas,
            referencedColumnNames: ['company_id', 'id'],
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
          text('area_id', 64),
          counter('version'),
          text('action', 16),
          text('changed_fields', 48),
          text('from_parent_id', 64, { isNullable: true }),
          text('to_parent_id', 64, { isNullable: true }),
          text('actor_id', 64),
          moment('at'),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_area_history_version',
            columnNames: ['company_id', 'area_id', 'version'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_area_history_area',
            columnNames: ['company_id', 'area_id'],
            referencedTableName: T.areas,
            referencedColumnNames: ['company_id', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({ name: T.locks, columns: [text('company_id', 64, { isPrimary: true })] }),
    );
    for (const check of AREA_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.locks);
    await queryRunner.dropTable(T.history);
    await queryRunner.dropTable(T.responsibles);
    await queryRunner.dropTable(T.areas);
  }
}
