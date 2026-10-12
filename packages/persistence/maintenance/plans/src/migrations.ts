import type { MigrationInterface, QueryRunner } from 'typeorm';
import { MAINTENANCE_TABLES as T } from './entities.js';

export const MAINTENANCE_MIGRATION_VERSION = '2026101200010';
export const MAINTENANCE_MIGRATIONS_TABLE = 'opslog_maintenance_migrations';

/** ORM migration for maintenance plans, immutable snapshots, catalogs, occurrences, orders and alerts. */
export class CreateMaintenancePlans2026101200010 implements MigrationInterface {
  public name = 'CreateMaintenancePlans2026101200010';
  public async up(queryRunner: QueryRunner): Promise<void> {
    const ddl = [
      `CREATE TABLE \`${T.workshops}\` (
        company_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        name VARCHAR(120) COLLATE utf8mb4_0900_bin NOT NULL, specialties JSON NOT NULL, contact VARCHAR(254) COLLATE utf8mb4_0900_bin NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,id), KEY ix_maintenance_workshop_name (company_id,name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
      `CREATE TABLE \`${T.mechanics}\` (
        company_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        name VARCHAR(120) COLLATE utf8mb4_0900_bin NOT NULL, specialties JSON NOT NULL, contact VARCHAR(254) COLLATE utf8mb4_0900_bin NULL,
        kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL, workshop_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL,
        member_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL, registered_by VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,id), KEY ix_maintenance_mechanic_workshop (company_id,workshop_id), KEY ix_maintenance_mechanic_member (company_id,member_id),
        CONSTRAINT ck_maintenance_mechanic_kind CHECK ((kind='internal' AND member_id IS NOT NULL) OR (kind='external' AND member_id IS NULL)),
        CONSTRAINT fk_maintenance_mechanic_workshop FOREIGN KEY (company_id,workshop_id) REFERENCES \`${T.workshops}\` (company_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
      `CREATE TABLE \`${T.plans}\` (
        company_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        vehicle_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, state VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
        interval_days INT UNSIGNED NULL, interval_km INT UNSIGNED NULL, last_service_date CHAR(10) COLLATE utf8mb4_0900_bin NULL,
        last_service_km INT UNSIGNED NULL, default_workshop_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL,
        default_mechanic_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL, version INT UNSIGNED NOT NULL,
        created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,id), KEY ix_maintenance_plans_vehicle (company_id,vehicle_id), KEY ix_maintenance_plans_due (company_id,state),
        CONSTRAINT ck_maintenance_plan_interval CHECK ((interval_days IS NOT NULL AND interval_days > 0 AND last_service_date IS NOT NULL) OR (interval_km IS NOT NULL AND interval_km > 0 AND last_service_km IS NOT NULL)),
        CONSTRAINT ck_maintenance_plan_state CHECK (state IN ('active','paused')),
        CONSTRAINT fk_maintenance_plan_workshop FOREIGN KEY (company_id,default_workshop_id) REFERENCES \`${T.workshops}\` (company_id,id),
        CONSTRAINT fk_maintenance_plan_mechanic FOREIGN KEY (company_id,default_mechanic_id) REFERENCES \`${T.mechanics}\` (company_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
      `CREATE TABLE \`${T.versions}\` (
        company_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, plan_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        version INT UNSIGNED NOT NULL, snapshot JSON NOT NULL, actor_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        created_at DATETIME(6) NOT NULL, PRIMARY KEY (company_id,plan_id,version),
        CONSTRAINT fk_maintenance_plan_version FOREIGN KEY (company_id,plan_id) REFERENCES \`${T.plans}\` (company_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
      `CREATE TABLE \`${T.occurrences}\` (
        company_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        plan_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, sequence INT UNSIGNED NOT NULL, plan_version INT UNSIGNED NOT NULL,
        trigger_kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL, target_date CHAR(10) COLLATE utf8mb4_0900_bin NULL,
        target_km INT UNSIGNED NULL, detected_at DATETIME(6) NOT NULL, idempotency_key VARCHAR(160) COLLATE utf8mb4_0900_bin NOT NULL,
        order_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, state VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
        workshop_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL, mechanic_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL,
        completed_at DATETIME(6) NULL, actual_date CHAR(10) COLLATE utf8mb4_0900_bin NULL, actual_km INT UNSIGNED NULL,
        PRIMARY KEY (company_id,id), UNIQUE KEY uq_maintenance_occurrence_sequence (company_id,plan_id,sequence),
        UNIQUE KEY uq_maintenance_occurrence_key (company_id,idempotency_key), KEY ix_maintenance_occurrence_plan (company_id,plan_id,state),
        CONSTRAINT fk_maintenance_occurrence_plan FOREIGN KEY (company_id,plan_id) REFERENCES \`${T.plans}\` (company_id,id),
        CONSTRAINT fk_maintenance_occurrence_workshop FOREIGN KEY (company_id,workshop_id) REFERENCES \`${T.workshops}\` (company_id,id),
        CONSTRAINT fk_maintenance_occurrence_mechanic FOREIGN KEY (company_id,mechanic_id) REFERENCES \`${T.mechanics}\` (company_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
      `CREATE TABLE \`${T.orders}\` (
        company_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        occurrence_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, plan_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        vehicle_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, status VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
        kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL, snapshot JSON NOT NULL, created_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,id), UNIQUE KEY uq_maintenance_order_occurrence (company_id,occurrence_id),
        CONSTRAINT fk_maintenance_order_occurrence FOREIGN KEY (company_id,occurrence_id) REFERENCES \`${T.occurrences}\` (company_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
      `CREATE TABLE \`${T.alerts}\` (
        company_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
        plan_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL, occurrence INT UNSIGNED NOT NULL, plan_version INT UNSIGNED NOT NULL,
        kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL, trigger_kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL,
        threshold_kind VARCHAR(16) COLLATE utf8mb4_0900_bin NOT NULL, target_date CHAR(10) COLLATE utf8mb4_0900_bin NULL,
        target_km INT UNSIGNED NULL, odometer_last_updated_at DATETIME(6) NULL, odometer_age_seconds INT UNSIGNED NULL,
        occurred_at DATETIME(6) NOT NULL, idempotency_key VARCHAR(200) COLLATE utf8mb4_0900_bin NOT NULL,
        PRIMARY KEY (company_id,id), UNIQUE KEY uq_maintenance_alert_idempotency (company_id,idempotency_key),
        KEY ix_maintenance_alert_listing (company_id,occurred_at),
        CONSTRAINT fk_maintenance_alert_plan FOREIGN KEY (company_id,plan_id) REFERENCES \`${T.plans}\` (company_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
    ];
    for (const statement of ddl) await queryRunner.query(statement);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.alerts);
    await queryRunner.dropTable(T.orders);
    await queryRunner.dropTable(T.occurrences);
    await queryRunner.dropTable(T.versions);
    await queryRunner.dropTable(T.plans);
    await queryRunner.dropTable(T.mechanics);
    await queryRunner.dropTable(T.workshops);
  }
}
