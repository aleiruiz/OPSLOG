import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from 'typeorm';
import { FILE_TABLES } from './entities.js';

export const FILES_MIGRATION_VERSION = '2026100700010';
export const FILES_MIGRATIONS_TABLE = 'opslog_files_migrations';
export const FILES_RUNTIME_ACCOUNT = /^opslog_files_[a-z0-9_]+$/i;
const COLLATION = 'utf8mb4_0900_bin';
const text = (name: string, length: number, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'varchar',
  length: String(length),
  collation: COLLATION,
  ...extra,
});
const moment = (name: string, nullable = false) => ({
  name,
  type: 'datetime',
  precision: 3,
  isNullable: nullable,
});

export class CreateFiles2026100700010 implements MigrationInterface {
  name = 'CreateFiles2026100700010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: FILE_TABLES.records,
        columns: [
          text('tenant_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          { name: 'kind', type: 'enum', enum: ['original', 'derivative'] },
          text('original_id', 64, { isNullable: true }),
          {
            name: 'status',
            type: 'enum',
            enum: ['pending_upload', 'pending_scan', 'clean', 'rejected'],
          },
          { name: 'sensitivity', type: 'enum', enum: ['standard', 'pii'] },
          text('content_type', 128),
          { name: 'size_bytes', type: 'int', unsigned: true },
          { name: 'sha256', type: 'char', length: '64', collation: 'ascii_bin' },
          text('display_name', 96),
          { name: 'width', type: 'smallint', unsigned: true, isNullable: true },
          { name: 'height', type: 'smallint', unsigned: true, isNullable: true },
          text('created_by', 128),
          moment('created_at'),
          moment('scanned_at', true),
          {
            name: 'rejection_reason',
            type: 'enum',
            enum: ['malware', 'integrity'],
            isNullable: true,
          },
        ],
        indices: [
          new TableIndex({
            name: 'ix_files_tenant_status_created',
            columnNames: ['tenant_id', 'status', 'created_at'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_files_original',
            columnNames: ['tenant_id', 'original_id'],
            referencedTableName: FILE_TABLES.records,
            referencedColumnNames: ['tenant_id', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: FILE_TABLES.history,
        columns: [
          text('tenant_id', 64, { isPrimary: true }),
          text('id', 64, { isPrimary: true }),
          text('file_id', 64),
          { name: 'version', type: 'int', unsigned: true },
          {
            name: 'from_status',
            type: 'enum',
            enum: ['pending_upload', 'pending_scan', 'clean', 'rejected'],
            isNullable: true,
          },
          {
            name: 'to_status',
            type: 'enum',
            enum: ['pending_upload', 'pending_scan', 'clean', 'rejected'],
          },
          text('actor_id', 128),
          moment('at'),
        ],
        uniques: [
          new TableUnique({
            name: 'uq_file_history_version',
            columnNames: ['tenant_id', 'file_id', 'version'],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_file_history_record',
            columnNames: ['tenant_id', 'file_id'],
            referencedTableName: FILE_TABLES.records,
            referencedColumnNames: ['tenant_id', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: FILE_TABLES.saga,
        columns: [
          text('tenant_id', 64, { isPrimary: true }),
          text('file_id', 64, { isPrimary: true }),
          {
            name: 'stage',
            type: 'enum',
            enum: ['upload', 'scan', 'cleanup_quarantine', 'cleanup_released'],
            isPrimary: true,
          },
          { name: 'state', type: 'enum', enum: ['pending', 'processing', 'retry', 'completed'] },
          { name: 'attempts', type: 'int', unsigned: true },
          moment('available_at'),
          moment('lease_until', true),
          moment('expires_at', true),
          { name: 'scan_outcome', type: 'enum', enum: ['clean', 'rejected'], isNullable: true },
          {
            name: 'rejection_reason',
            type: 'enum',
            enum: ['malware', 'integrity'],
            isNullable: true,
          },
          moment('updated_at'),
        ],
        indices: [
          new TableIndex({
            name: 'ix_file_saga_due',
            columnNames: ['stage', 'state', 'available_at', 'lease_until'],
          }),
          new TableIndex({ name: 'ix_file_saga_expiry', columnNames: ['stage', 'expires_at'] }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'fk_file_saga_record',
            columnNames: ['tenant_id', 'file_id'],
            referencedTableName: FILE_TABLES.records,
            referencedColumnNames: ['tenant_id', 'id'],
          }),
        ],
      }),
    );
    await queryRunner.query(
      `ALTER TABLE \`${FILE_TABLES.records}\` ADD CONSTRAINT \`ck_files_dimensions\` CHECK ((\`kind\` = 'original' AND \`original_id\` IS NULL AND \`width\` IS NULL AND \`height\` IS NULL) OR (\`kind\` = 'derivative' AND \`original_id\` IS NOT NULL AND \`width\` BETWEEN 1 AND 2000 AND \`height\` BETWEEN 1 AND 2000))`,
    );
    await queryRunner.query(
      `ALTER TABLE \`${FILE_TABLES.records}\` ADD CONSTRAINT \`ck_files_scan_state\` CHECK ((\`status\` = 'rejected' AND \`rejection_reason\` IS NOT NULL) OR (\`status\` <> 'rejected' AND \`rejection_reason\` IS NULL))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [FILE_TABLES.saga, FILE_TABLES.history, FILE_TABLES.records]) {
      const rows = (await queryRunner.query(`SELECT COUNT(*) AS count FROM \`${table}\``)) as {
        count: number | string;
      }[];
      if (Number(rows[0]?.count ?? 0) > 0)
        throw new Error('file migration rollback would delete durable file state');
    }
    await queryRunner.dropTable(FILE_TABLES.saga);
    await queryRunner.dropTable(FILE_TABLES.history);
    await queryRunner.dropTable(FILE_TABLES.records);
  }
}
