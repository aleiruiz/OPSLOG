import type { MigrationInterface, QueryRunner } from 'typeorm';
import { SAVED_VIEW_TABLES as T } from './entities.js';

export const SAVED_VIEWS_MIGRATION_VERSION = '2026101900020';
export const SAVED_VIEWS_MIGRATIONS_TABLE = 'opslog_saved_views_migrations';

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

const MODULES = ['vehicles', 'employees', 'documents', 'insurance', 'maintenance', 'incidents'];

/**
 * Saved views (FR-162): one row per view of a member and list, unique by case-folded name, plus the
 * columns each member keeps visible. The address of a list is not stored here; only its filters.
 */
export class CreateSavedViews2026101900020 implements MigrationInterface {
  public name = 'CreateSavedViews2026101900020';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.views}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, id VARCHAR(64) ${BIN} NOT NULL,
        owner_id VARCHAR(64) ${BIN} NOT NULL, module VARCHAR(24) ${BIN} NOT NULL,
        name VARCHAR(80) ${BIN} NOT NULL, name_key VARCHAR(240) ${BIN} NOT NULL,
        filters TEXT ${BIN} NOT NULL, sort_field VARCHAR(32) ${BIN} NULL,
        sort_direction VARCHAR(4) ${BIN} NULL, columns TEXT ${BIN} NULL,
        shared TINYINT(1) NOT NULL DEFAULT 0, version INT UNSIGNED NOT NULL,
        created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,id),
        UNIQUE KEY uq_view_name (company_id,owner_id,module,name_key),
        KEY ix_view_shared (company_id,module,shared),
        CONSTRAINT ck_view_module CHECK (module IN (${list(MODULES)})),
        CONSTRAINT ck_view_sort CHECK (sort_direction IS NULL OR sort_direction IN ('asc','desc')),
        CONSTRAINT ck_view_shared CHECK (shared IN (0,1))
      ) ${TABLE}`);
    await queryRunner.query(`CREATE TABLE \`${T.columns}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, member_id VARCHAR(64) ${BIN} NOT NULL,
        module VARCHAR(24) ${BIN} NOT NULL, columns TEXT ${BIN} NULL,
        updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,member_id,module),
        CONSTRAINT ck_columns_module CHECK (module IN (${list(MODULES)}))
      ) ${TABLE}`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.columns);
    await queryRunner.dropTable(T.views);
  }
}
