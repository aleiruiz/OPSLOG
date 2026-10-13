import type { MigrationInterface, QueryRunner } from 'typeorm';
import { INCIDENT_REPAIR_TABLES as T } from './entities.js';

/** Version of the last migration of the repair links. */
export const INCIDENT_REPAIRS_MIGRATION_VERSION = '2026101700010';
export const INCIDENT_REPAIRS_MIGRATIONS_TABLE = 'opslog_incident_repairs_migrations';

/** The table of the cases (INC-CASES PR 1). A migration is a literal copy and never follows a rename. */
const INCIDENTS_TABLE = 'opslog_incident_incidents';
const BIN = 'COLLATE utf8mb4_0900_bin';

/**
 * Links between a case and the corrective orders that repair it (INC-COSTS). An order is linked at
 * most once per tenant, so its cost can never count twice. No foreign key crosses modules: the order
 * is validated through the order reader.
 */
export class CreateIncidentRepairLinks2026101700010 implements MigrationInterface {
  public name = 'CreateIncidentRepairLinks2026101700010';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.links}\` (
      company_id VARCHAR(64) ${BIN} NOT NULL, incident_id VARCHAR(64) ${BIN} NOT NULL,
      id VARCHAR(64) ${BIN} NOT NULL, order_id VARCHAR(64) ${BIN} NOT NULL,
      linked_at DATETIME(6) NOT NULL, linked_by VARCHAR(72) ${BIN} NOT NULL,
      PRIMARY KEY (company_id,incident_id,id),
      UNIQUE KEY uq_incident_repair_order (company_id,order_id),
      CONSTRAINT fk_incident_repair_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.links);
  }
}
