import type { MigrationInterface, QueryRunner } from 'typeorm';
import { INCIDENT_WORKFLOW_TABLES as T } from './entities.js';

/** Version of the last migration of the incident workflow (the snapshot of each closed cycle). */
export const INCIDENT_WORKFLOW_MIGRATION_VERSION = '2026101600010';
export const INCIDENT_WORKFLOW_MIGRATIONS_TABLE = 'opslog_incident_workflow_migrations';

/** The table of the cases (INC-CASES PR 1). A migration is a literal copy and never follows a rename. */
const INCIDENTS_TABLE = 'opslog_incident_incidents';
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const STATUSES = ['resolved'] as const;
const ORIGINS = [
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
] as const;
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');

/**
 * One row per closed cycle of a case (INC-WORKFLOW PR 2). The primary key makes a second closure of
 * the same cycle impossible; the runtime account inserts and reads, so a snapshot never changes.
 * No foreign key crosses modules: the vehicle and the orders are ids the service validated.
 */
export class CreateIncidentClosures2026101600010 implements MigrationInterface {
  public name = 'CreateIncidentClosures2026101600010';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.closures}\` (
      company_id VARCHAR(64) ${BIN} NOT NULL, incident_id VARCHAR(64) ${BIN} NOT NULL,
      cycle INT UNSIGNED NOT NULL, status_before VARCHAR(24) ${BIN} NOT NULL,
      resolved_from VARCHAR(24) ${BIN} NOT NULL, resolved_at DATETIME(6) NULL,
      resolution_summary VARCHAR(2000) ${BIN} NULL, total_loss BOOLEAN NULL,
      vehicle_status_decision VARCHAR(32) ${BIN} NULL, insurer_result VARCHAR(16) ${BIN} NULL,
      cost_assumed BOOLEAN NULL, close_approved_by VARCHAR(72) ${BIN} NULL,
      close_approved_at DATETIME(6) NULL, orders JSON NOT NULL,
      closed_at DATETIME(6) NOT NULL, closed_by VARCHAR(72) ${BIN} NOT NULL,
      PRIMARY KEY (company_id,incident_id,cycle),
      CONSTRAINT fk_incident_closure_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
      CONSTRAINT ck_incident_closure_cycle CHECK (cycle >= 1),
      CONSTRAINT ck_incident_closure_status CHECK (status_before IN (${list(STATUSES)})),
      CONSTRAINT ck_incident_closure_origin CHECK (resolved_from IN (${list(ORIGINS)})),
      CONSTRAINT ck_incident_closure_approval CHECK ((close_approved_by IS NULL) = (close_approved_at IS NULL))
    ) ${TABLE}`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.closures);
  }
}
