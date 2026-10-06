import { MigrationInterface, QueryRunner, Table, type TableColumnOptions } from 'typeorm';
import { BINARY_COLLATION, SETTINGS_TABLES } from './entities.js';

export const SETTINGS_MIGRATION_VERSION = '2026100600090';
export const SETTINGS_MIGRATIONS_TABLE = 'opslog_settings_migrations';

const text = (name: string, length: number, extra: Partial<TableColumnOptions> = {}) =>
  ({
    name,
    type: 'varchar',
    length: String(length),
    collation: BINARY_COLLATION,
    ...extra,
  }) satisfies TableColumnOptions;

const T = SETTINGS_TABLES;

const ROLE = '(admin|editor|viewer|auditor|pii_reader)';

/**
 * Every CHECK is NULL-safe (`IS TRUE`): MySQL accepts a CHECK that evaluates to NULL, so a bare
 * expression would let a NULL through. The window is bounded to the 30 days of the expiry helpers,
 * the version starts at 1 and the recipients are one to five known role names, comma-joined.
 */
export const SETTINGS_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.settings,
    name: 'ck_settings_shape',
    expression:
      '((`expiry_window_days` BETWEEN 1 AND 30 AND `version` >= 1 AND CHAR_LENGTH(TRIM(`updated_by`)) > 0) IS TRUE)',
  },
  {
    table: T.settings,
    name: 'ck_settings_recipients',
    expression: `((\`recipient_roles\` REGEXP '^${ROLE}(,${ROLE}){0,4}$') IS TRUE)`,
  },
];

/**
 * Company settings: one row per company, keyed by `company_id`. The runtime account is not granted
 * DELETE: settings are replaced, never removed.
 */
export class CreateCompanySettings2026100600090 implements MigrationInterface {
  name = 'CreateCompanySettings2026100600090';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: T.settings,
        columns: [
          text('company_id', 64, { isPrimary: true }),
          { name: 'expiry_window_days', type: 'tinyint', unsigned: true },
          text('recipient_roles', 80),
          { name: 'version', type: 'int', unsigned: true },
          text('updated_by', 64),
          { name: 'updated_at', type: 'datetime', precision: 6 },
        ],
      }),
    );
    for (const check of SETTINGS_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.settings);
  }
}
