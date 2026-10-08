import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
  type TableColumnOptions,
} from 'typeorm';
import { AUDIT_TABLES } from './entities.js';

export const AUDIT_MIGRATION_VERSION = '2026100700010';
export const AUDIT_MIGRATIONS_TABLE = 'opslog_audit_migrations';
const text = (name: string, length: number, primary = false): TableColumnOptions => ({
  name,
  type: 'varchar',
  length: String(length),
  collation: 'utf8mb4_bin',
  isPrimary: primary,
});
const date = (name: string, primary = false, nullable = false): TableColumnOptions => ({
  name,
  type: 'datetime',
  precision: 3,
  isPrimary: primary,
  isNullable: nullable,
});
const eventColumns = (partitioned: boolean): TableColumnOptions[] => [
  text('tenant_id', 128, true),
  text('event_id', 128, true),
  text('action', 64),
  text('entity_type', 64),
  text('entity_id', 128),
  date('occurred_at', partitioned),
  text('actor_id', 128),
  text('actor_kind', 16),
  text('correlation_id', 128),
  { name: 'data', type: 'json' },
  { name: 'content_hash', type: 'char', length: '64', collation: 'ascii_bin' },
];

export class CreateAuditStore2026100700010 implements MigrationInterface {
  name = 'CreateAuditStore2026100700010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: AUDIT_TABLES.local,
        columns: eventColumns(false),
        indices: [
          new TableIndex({
            name: 'ix_audit_local_tenant_date',
            columnNames: ['tenant_id', 'occurred_at'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: AUDIT_TABLES.delivery,
        columns: [
          text('tenant_id', 128, true),
          text('event_id', 128, true),
          {
            name: 'status',
            type: 'enum',
            enum: ['pending', 'delivered'],
            default: "'pending'",
          },
          date('created_at'),
          date('delivered_at', false, true),
        ],
        indices: [
          new TableIndex({
            name: 'ix_audit_delivery_pending',
            columnNames: ['status', 'created_at'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: AUDIT_TABLES.projection,
        columns: eventColumns(true),
        indices: [
          new TableIndex({
            name: 'ix_audit_projection_tenant_date',
            columnNames: ['tenant_id', 'occurred_at'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: AUDIT_TABLES.registry,
        columns: [
          text('tenant_id', 128, true),
          text('event_id', 128, true),
          { name: 'content_hash', type: 'char', length: '64', collation: 'ascii_bin' },
          date('occurred_at'),
        ],
        indices: [
          new TableIndex({
            name: 'ix_audit_registry_date',
            columnNames: ['tenant_id', 'occurred_at'],
          }),
        ],
      }),
    );
    const partitions = [
      "PARTITION p_before_2020 VALUES LESS THAN ('2020-01-01 00:00:00')",
      ...Array.from(
        { length: 16 },
        (_, offset) =>
          `PARTITION p${2020 + offset} VALUES LESS THAN ('${2021 + offset}-01-01 00:00:00')`,
      ),
      'PARTITION pmax VALUES LESS THAN (MAXVALUE)',
    ];
    await queryRunner.query(
      `ALTER TABLE \`${AUDIT_TABLES.projection}\` PARTITION BY RANGE COLUMNS (\`occurred_at\`) (${partitions.join(', ')})`,
    );
  }

  /** Audit rows are append-only; destructive rollback requires a separate owner decision. */
  public async down(): Promise<void> {
    throw new Error('Audit migrations cannot be rolled back destructively');
  }
}

/** Migrator-only helper: add annual date partitions by splitting the future catch-all. */
export async function ensureAuditYearPartition(
  queryRunner: QueryRunner,
  year: number,
): Promise<void> {
  if (!Number.isInteger(year) || year < 2020 || year > 9998)
    throw new Error('invalid audit partition year');
  const rows = (await queryRunner.query(
    'SELECT PARTITION_NAME AS name FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL',
    [AUDIT_TABLES.projection],
  )) as { name: string }[];
  const existing = new Set(rows.map((row) => row.name));
  for (let next = 2036; next <= year; next += 1) {
    if (existing.has(`p${next}`)) continue;
    await queryRunner.query(
      `ALTER TABLE \`${AUDIT_TABLES.projection}\` REORGANIZE PARTITION pmax INTO (PARTITION p${next} VALUES LESS THAN ('${next + 1}-01-01 00:00:00'), PARTITION pmax VALUES LESS THAN (MAXVALUE))`,
    );
  }
}
