import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  type TableColumnOptions,
} from 'typeorm';
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

export const MAINTENANCE_SETTINGS_MIGRATION_VERSION = '2026101300010';

/** Columns added by the maintenance settings slice; existing rows read the defaults (none, no D20 threshold, UTC). */
export const MAINTENANCE_SETTINGS_COLUMNS: readonly TableColumnOptions[] = [
  text('maintenance_evidence', 16, { default: "'none'" }),
  { name: 'close_threshold_minor', type: 'bigint', unsigned: true, isNullable: true },
  {
    name: 'close_threshold_currency',
    type: 'char',
    length: '3',
    collation: BINARY_COLLATION,
    isNullable: true,
  },
  text('time_zone', 64, { default: "'UTC'" }),
];

export const MAINTENANCE_SETTINGS_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.settings,
    name: 'ck_settings_maintenance',
    expression:
      "((`maintenance_evidence` IN ('none','evidence','evidence_invoice') AND CHAR_LENGTH(TRIM(`time_zone`)) > 0 AND ((`close_threshold_minor` IS NULL) = (`close_threshold_currency` IS NULL)) AND (`close_threshold_minor` IS NULL OR `close_threshold_minor` > 0)) IS TRUE)",
  },
];

/**
 * Maintenance settings (G3 H3, D20, M4): evidence requirement, optional costly-closure threshold
 * and the tenant IANA zone. A separate migration so the first slice stays reversible on its own.
 */
export class AddMaintenanceCompanySettings2026101300010 implements MigrationInterface {
  name = 'AddMaintenanceCompanySettings2026101300010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns(
      T.settings,
      MAINTENANCE_SETTINGS_COLUMNS.map((column) => new TableColumn(column)),
    );
    for (const check of MAINTENANCE_SETTINGS_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const check of MAINTENANCE_SETTINGS_CHECKS)
      await queryRunner.query(`ALTER TABLE \`${check.table}\` DROP CHECK \`${check.name}\``);
    await queryRunner.dropColumns(
      T.settings,
      MAINTENANCE_SETTINGS_COLUMNS.map((column) => column.name),
    );
  }
}

export const INCIDENT_SETTINGS_MIGRATION_VERSION = '2026101500030';

/** Existing rows read the default: a clean photo or a written justification. */
export const INCIDENT_SETTINGS_COLUMNS: readonly TableColumnOptions[] = [
  text('incident_report_photo', 24, { default: "'photo_or_justification'" }),
];

export const INCIDENT_SETTINGS_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.settings,
    name: 'ck_settings_incident_photo',
    expression:
      "((`incident_report_photo` IN ('photo_or_justification','photo_required')) IS TRUE)",
  },
];

/**
 * Incident settings (INC-WORKFLOW, M4): the photo evidence reporting an incident requires. An expand
 * migration in its own step, so the maintenance slice stays reversible on its own.
 */
export class AddIncidentCompanySettings2026101500030 implements MigrationInterface {
  name = 'AddIncidentCompanySettings2026101500030';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns(
      T.settings,
      INCIDENT_SETTINGS_COLUMNS.map((column) => new TableColumn(column)),
    );
    for (const check of INCIDENT_SETTINGS_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const check of INCIDENT_SETTINGS_CHECKS)
      await queryRunner.query(`ALTER TABLE \`${check.table}\` DROP CHECK \`${check.name}\``);
    await queryRunner.dropColumns(
      T.settings,
      INCIDENT_SETTINGS_COLUMNS.map((column) => column.name),
    );
  }
}

export const INCIDENT_SLA_SETTINGS_MIGRATION_VERSION = '2026101700040';

/** Existing rows read the D17 targets (7/15/30/45 days) and N = 5. */
export const INCIDENT_SLA_SETTINGS_COLUMNS: readonly TableColumnOptions[] = [
  { name: 'incident_sla_critical', type: 'smallint', unsigned: true, default: 7 },
  { name: 'incident_sla_high', type: 'smallint', unsigned: true, default: 15 },
  { name: 'incident_sla_medium', type: 'smallint', unsigned: true, default: 30 },
  { name: 'incident_sla_low', type: 'smallint', unsigned: true, default: 45 },
  { name: 'incident_inactivity_days', type: 'tinyint', unsigned: true, default: 5 },
];

export const INCIDENT_SLA_SETTINGS_CHECKS: readonly {
  readonly table: string;
  readonly name: string;
  readonly expression: string;
}[] = [
  {
    table: T.settings,
    name: 'ck_settings_incident_sla',
    expression:
      '((`incident_sla_critical` BETWEEN 1 AND 365 AND `incident_sla_high` BETWEEN 1 AND 365 AND `incident_sla_medium` BETWEEN 1 AND 365 AND `incident_sla_low` BETWEEN 1 AND 365 AND `incident_inactivity_days` BETWEEN 1 AND 60) IS TRUE)',
  },
];

/**
 * Incident SLA settings (INC-SLA, M4, SPECS D17): days per severity and the days without movement.
 * An expand migration in its own step; the defaults keep every existing company on the D17 targets.
 */
export class AddIncidentSlaCompanySettings2026101700040 implements MigrationInterface {
  name = 'AddIncidentSlaCompanySettings2026101700040';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns(
      T.settings,
      INCIDENT_SLA_SETTINGS_COLUMNS.map((column) => new TableColumn(column)),
    );
    for (const check of INCIDENT_SLA_SETTINGS_CHECKS)
      await queryRunner.query(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const check of INCIDENT_SLA_SETTINGS_CHECKS)
      await queryRunner.query(`ALTER TABLE \`${check.table}\` DROP CHECK \`${check.name}\``);
    await queryRunner.dropColumns(
      T.settings,
      INCIDENT_SLA_SETTINGS_COLUMNS.map((column) => column.name),
    );
  }
}
