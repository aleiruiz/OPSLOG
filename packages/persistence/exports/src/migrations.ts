import type { MigrationInterface, QueryRunner } from 'typeorm';
import { EXPORT_TABLES as T } from './entities.js';

export const EXPORT_MIGRATION_VERSION = '2026101900050';
export const EXPORT_MIGRATIONS_TABLE = 'opslog_exports_migrations';

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * Export jobs (MVP-REPORTS PR 1): who asked for which report in which format, with the validated
 * filters and columns, the state of the job and the date its file stops being available. The file
 * itself is in the object store under `tenants/<company>/exports/<jobId>`.
 */
export class CreateExportJobs2026101900050 implements MigrationInterface {
  public name = 'CreateExportJobs2026101900050';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.jobs}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, id VARCHAR(64) ${BIN} NOT NULL,
        actor_id VARCHAR(64) ${BIN} NOT NULL, session_id VARCHAR(64) ${BIN} NOT NULL,
        report_id VARCHAR(48) ${BIN} NOT NULL, format VARCHAR(8) ${BIN} NOT NULL,
        filters JSON NOT NULL, columns JSON NOT NULL,
        sort VARCHAR(48) ${BIN} NOT NULL, direction VARCHAR(4) ${BIN} NOT NULL,
        mode VARCHAR(8) ${BIN} NOT NULL, status VARCHAR(12) ${BIN} NOT NULL,
        row_count INT NULL, byte_size BIGINT NULL, sha256 CHAR(64) ${BIN} NULL,
        file_name VARCHAR(120) ${BIN} NULL, failure VARCHAR(24) ${BIN} NULL,
        idempotency_key VARCHAR(128) ${BIN} NULL, request_hash CHAR(64) ${BIN} NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL, started_at DATETIME(6) NULL, finished_at DATETIME(6) NULL,
        expires_at DATETIME(6) NULL, lease_until DATETIME(6) NULL,
        PRIMARY KEY (company_id,id),
        UNIQUE KEY ux_export_key (company_id,actor_id,idempotency_key),
        KEY ix_export_actor (company_id,actor_id,created_at),
        KEY ix_export_status (company_id,status,created_at),
        CONSTRAINT ck_export_format CHECK (format IN (${list(['csv', 'xlsx', 'pdf'])})),
        CONSTRAINT ck_export_direction CHECK (direction IN ('asc','desc')),
        CONSTRAINT ck_export_mode CHECK (mode IN ('direct','job')),
        CONSTRAINT ck_export_status CHECK (status IN (${list(['queued', 'running', 'completed', 'failed', 'expired'])})),
        CONSTRAINT ck_export_failure CHECK (failure IS NULL OR failure IN (${list(['permission_revoked', 'session_ended', 'too_many_rows', 'generation_failed'])})),
        CONSTRAINT ck_export_attempts CHECK (attempts >= 0)
      ) ${TABLE}`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.jobs);
  }
}
