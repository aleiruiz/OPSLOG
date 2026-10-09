import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
  type TableColumnOptions,
} from 'typeorm';
import { AUDIT_TABLES } from './entities.js';

export const AUDIT_MIGRATION_VERSION = '2026100700010';
export const OUTBOX_MIGRATION_VERSION = '2026100900010';
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
        name: 'opslog_audit_local_keys',
        columns: [text('tenant_id', 128, true), text('event_id', 128, true)],
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
    await queryRunner.query(`CREATE PROCEDURE opslog_append_local_audit_and_delivery(
      IN p_tenant_id VARCHAR(128), IN p_event_id VARCHAR(128), IN p_action VARCHAR(64),
      IN p_entity_type VARCHAR(64), IN p_entity_id VARCHAR(128), IN p_occurred_at DATETIME(3),
      IN p_actor_id VARCHAR(128), IN p_actor_kind VARCHAR(16), IN p_correlation_id VARCHAR(128),
      IN p_data JSON, IN p_content_hash CHAR(64)
    ) SQL SECURITY DEFINER
    BEGIN
      DECLARE v_key_exists BOOLEAN DEFAULT FALSE;
      DECLARE v_content_hash CHAR(64) DEFAULT NULL;
      BEGIN
        DECLARE CONTINUE HANDLER FOR 1062 SET v_key_exists = TRUE;
        INSERT INTO opslog_audit_local_keys (tenant_id, event_id) VALUES (p_tenant_id, p_event_id);
      END;
      BEGIN
        DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_content_hash = NULL;
        SELECT content_hash INTO v_content_hash FROM \`${AUDIT_TABLES.local}\`
          WHERE tenant_id = p_tenant_id AND event_id = p_event_id;
      END;
      IF v_content_hash IS NOT NULL AND BINARY v_content_hash <> BINARY p_content_hash THEN
        SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1644, MESSAGE_TEXT = 'AUDIT_EVENT_CONFLICT';
      END IF;
      IF v_content_hash IS NULL THEN
        INSERT INTO \`${AUDIT_TABLES.local}\` (
          tenant_id, event_id, action, entity_type, entity_id, occurred_at,
          actor_id, actor_kind, correlation_id, data, content_hash
        ) VALUES (
          p_tenant_id, p_event_id, p_action, p_entity_type, p_entity_id, p_occurred_at,
          p_actor_id, p_actor_kind, p_correlation_id, p_data, p_content_hash
        );
        INSERT INTO \`${AUDIT_TABLES.delivery}\` (tenant_id, event_id, status, created_at, delivered_at)
          VALUES (p_tenant_id, p_event_id, 'pending', UTC_TIMESTAMP(3), NULL);
      END IF;
    END`);
  }

  /** Audit rows are append-only; destructive rollback requires a separate owner decision. */
  public async down(): Promise<void> {
    throw new Error('Audit migrations cannot be rolled back destructively');
  }
}

/** Durable tenant-scoped job state, including the handler checkpoint and monotonic fence. */
export class CreateTenantOutbox2026100900010 implements MigrationInterface {
  name = 'CreateTenantOutbox2026100900010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: AUDIT_TABLES.outbox,
        columns: [
          text('tenant_id', 128, true),
          text('event_id', 128, true),
          text('type', 128),
          { name: 'payload', type: 'json' },
          date('occurred_at'),
          text('idempotency_key', 128),
          { name: 'correlation_id', type: 'varchar', length: '128', isNullable: true },
          { name: 'actor_subject', type: 'varchar', length: '128', isNullable: true },
          { name: 'actor_kind', type: 'varchar', length: '16', isNullable: true },
          { name: 'required_permission', type: 'varchar', length: '64', isNullable: true },
          { name: 'entity_id', type: 'varchar', length: '128', isNullable: true },
          { name: 'schema_version', type: 'int', isNullable: true },
          {
            name: 'status',
            type: 'enum',
            enum: ['pending', 'processing', 'retry', 'delivered', 'dead_letter'],
            default: "'pending'",
          },
          { name: 'attempts', type: 'int', unsigned: true, default: 0 },
          date('available_at'),
          date('lease_until', false, true),
          { name: 'fencing', type: 'bigint', unsigned: true, default: 0 },
          { name: 'worker_id', type: 'varchar', length: '128', isNullable: true },
          { name: 'last_error', type: 'varchar', length: '500', isNullable: true },
          { name: 'handler_completed', type: 'boolean', default: false },
        ],
        indices: [
          new TableIndex({
            name: 'ix_tenant_outbox_due',
            columnNames: ['status', 'available_at', 'occurred_at'],
          }),
        ],
      }),
    );
  }

  /** Durable event history is not destructively rolled back. */
  public async down(): Promise<void> {
    throw new Error('Outbox migrations cannot be rolled back destructively');
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
