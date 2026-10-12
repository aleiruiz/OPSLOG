import type { MigrationInterface, QueryRunner } from 'typeorm';
import { WORK_ORDER_TABLES as T } from './entities.js';

export const WORK_ORDER_MIGRATION_VERSION = '2026101200030';
export const WORK_ORDER_MIGRATIONS_TABLE = 'opslog_maintenance_order_migrations';

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const id = (name: string, nullable = false) =>
  `${name} VARCHAR(64) COLLATE utf8mb4_0900_bin ${nullable ? 'NULL' : 'NOT NULL'}`;
const actor = (name: string, nullable = false) =>
  `${name} VARCHAR(72) COLLATE utf8mb4_0900_bin ${nullable ? 'NULL' : 'NOT NULL'}`;
const owner = (name: string) =>
  `CONSTRAINT fk_${name}_order FOREIGN KEY (company_id,order_id) REFERENCES \`${T.orders}\` (company_id,id)`;

/**
 * ORM migration for work orders, their work facts and the append-only transition timeline. Workshop
 * and mechanic ids are validated by the service against the MNT-PLANS catalogs, not by a
 * cross-module foreign key, so each module's migration can be reverted and reapplied on its own.
 */
export class CreateMaintenanceWorkOrders2026101200030 implements MigrationInterface {
  public name = 'CreateMaintenanceWorkOrders2026101200030';
  public async up(queryRunner: QueryRunner): Promise<void> {
    const ddl = [
      `CREATE TABLE \`${T.orders}\` (
        ${id('company_id')}, ${id('id')}, kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL, ${id('vehicle_id')},
        ${id('plan_id', true)}, ${id('occurrence_id', true)}, status VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
        version INT UNSIGNED NOT NULL, description VARCHAR(2000) COLLATE utf8mb4_0900_bin NULL,
        ${id('responsible_id', true)}, ${id('workshop_id', true)}, ${id('mechanic_id', true)},
        scheduled_date CHAR(10) COLLATE utf8mb4_0900_bin NULL, requires_workshop BOOLEAN NOT NULL,
        started_at DATETIME(6) NULL, completed_at DATETIME(6) NULL, actual_date CHAR(10) COLLATE utf8mb4_0900_bin NULL,
        actual_km INT UNSIGNED NULL, ${actor('close_approved_by', true)}, close_approved_at DATETIME(6) NULL,
        closed_at DATETIME(6) NULL, ${actor('closed_by', true)}, vehicle_status_decision VARCHAR(32) COLLATE utf8mb4_0900_bin NULL,
        cancel_reason VARCHAR(1000) COLLATE utf8mb4_0900_bin NULL, reopen_count INT UNSIGNED NOT NULL,
        created_at DATETIME(6) NOT NULL, ${actor('created_by')}, updated_at DATETIME(6) NOT NULL, ${actor('updated_by')},
        PRIMARY KEY (company_id,id), UNIQUE KEY uq_work_order_occurrence (company_id,occurrence_id),
        KEY ix_work_order_listing (company_id,created_at,id), KEY ix_work_order_vehicle (company_id,vehicle_id,status),
        KEY ix_work_order_mechanic (company_id,mechanic_id),
        CONSTRAINT ck_work_order_kind CHECK ((kind='preventive' AND plan_id IS NOT NULL AND occurrence_id IS NOT NULL) OR (kind='corrective' AND plan_id IS NULL AND occurrence_id IS NULL)),
        CONSTRAINT ck_work_order_status CHECK (status IN ('scheduled','assigned','in_progress','completed','closed','cancelled')),
        CONSTRAINT ck_work_order_closed CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND vehicle_status_decision IS NOT NULL))
      ) ${TABLE}`,
      `CREATE TABLE \`${T.tasks}\` (
        ${id('company_id')}, ${id('order_id')}, ${id('id')}, position SMALLINT UNSIGNED NOT NULL,
        description VARCHAR(500) COLLATE utf8mb4_0900_bin NOT NULL, PRIMARY KEY (company_id,order_id,id), ${owner('work_order_task')}
      ) ${TABLE}`,
      `CREATE TABLE \`${T.parts}\` (
        ${id('company_id')}, ${id('order_id')}, ${id('id')}, position SMALLINT UNSIGNED NOT NULL,
        name VARCHAR(200) COLLATE utf8mb4_0900_bin NOT NULL, quantity DECIMAL(10,3) NOT NULL,
        unit_cost_minor BIGINT UNSIGNED NULL, unit_cost_currency CHAR(3) COLLATE utf8mb4_0900_bin NULL,
        PRIMARY KEY (company_id,order_id,id), ${owner('work_order_part')},
        CONSTRAINT ck_work_order_part_quantity CHECK (quantity > 0),
        CONSTRAINT ck_work_order_part_cost CHECK ((unit_cost_minor IS NULL) = (unit_cost_currency IS NULL))
      ) ${TABLE}`,
      `CREATE TABLE \`${T.costs}\` (
        ${id('company_id')}, ${id('order_id')}, ${id('id')}, position SMALLINT UNSIGNED NOT NULL,
        category VARCHAR(32) COLLATE utf8mb4_0900_bin NOT NULL, amount_minor BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) COLLATE utf8mb4_0900_bin NOT NULL, PRIMARY KEY (company_id,order_id,id), ${owner('work_order_cost')},
        CONSTRAINT ck_work_order_cost_category CHECK (category IN ('labor','parts','external_service','other'))
      ) ${TABLE}`,
      `CREATE TABLE \`${T.transitions}\` (
        ${id('company_id')}, ${id('order_id')}, sequence INT UNSIGNED NOT NULL, command VARCHAR(32) COLLATE utf8mb4_0900_bin NOT NULL,
        from_status VARCHAR(16) COLLATE utf8mb4_0900_bin NULL, to_status VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
        ${actor('actor_id')}, comment VARCHAR(1000) COLLATE utf8mb4_0900_bin NULL, occurred_at DATETIME(6) NOT NULL,
        before_snapshot JSON NULL, PRIMARY KEY (company_id,order_id,sequence), ${owner('work_order_transition')}
      ) ${TABLE}`,
    ];
    for (const statement of ddl) await queryRunner.query(statement);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.transitions);
    await queryRunner.dropTable(T.costs);
    await queryRunner.dropTable(T.parts);
    await queryRunner.dropTable(T.tasks);
    await queryRunner.dropTable(T.orders);
  }
}

export const WORK_ORDER_FILES_MIGRATION_VERSION = '2026101300020';

/**
 * Evidence and invoice links of a work order (G3 H3). Rows only reference the file of the files
 * module (no foreign key across modules); a file is linked at most once per company. The runtime
 * account may insert and delete links, never update them.
 */
export class CreateMaintenanceWorkOrderFiles2026101300020 implements MigrationInterface {
  public name = 'CreateMaintenanceWorkOrderFiles2026101300020';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.files}\` (
        ${id('company_id')}, ${id('order_id')}, ${id('id')}, ${id('file_id')},
        kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
        display_name VARCHAR(120) COLLATE utf8mb4_0900_bin NOT NULL,
        content_type VARCHAR(100) COLLATE utf8mb4_0900_bin NOT NULL,
        size_bytes BIGINT UNSIGNED NOT NULL, ${actor('attached_by')}, attached_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,order_id,id), UNIQUE KEY uq_work_order_file (company_id,file_id),
        ${owner('work_order_file')},
        CONSTRAINT ck_work_order_file_kind CHECK (kind IN ('evidence','invoice'))
      ) ${TABLE}`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.files);
  }
}
