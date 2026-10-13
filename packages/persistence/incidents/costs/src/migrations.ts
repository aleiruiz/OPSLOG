import type { MigrationInterface, QueryRunner } from 'typeorm';
import { INCIDENT_COST_TABLES as T } from './entities.js';

/** Version of the last migration of the costs of the cases. */
export const INCIDENT_COSTS_MIGRATION_VERSION = '2026101700020';
export const INCIDENT_COSTS_MIGRATIONS_TABLE = 'opslog_incident_costs_migrations';

/** The table of the cases (INC-CASES PR 1). A migration is a literal copy and never follows a rename. */
const INCIDENTS_TABLE = 'opslog_incident_incidents';
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const ids = `company_id VARCHAR(64) ${BIN} NOT NULL, incident_id VARCHAR(64) ${BIN} NOT NULL`;

/**
 * Own costs of a case (INC-COSTS): lines, the informative initial estimate and the snapshot of each
 * closed cycle. Amounts are exact integers in the minor unit. The costs of the linked orders are never
 * copied here (BR-020). The snapshot is append-only for the runtime account.
 */
export class CreateIncidentCosts2026101700020 implements MigrationInterface {
  public name = 'CreateIncidentCosts2026101700020';
  public async up(queryRunner: QueryRunner): Promise<void> {
    const ddl = [
      `CREATE TABLE \`${T.lines}\` (
        ${ids}, id VARCHAR(64) ${BIN} NOT NULL, position INT UNSIGNED NOT NULL,
        kind VARCHAR(16) ${BIN} NOT NULL, category VARCHAR(24) ${BIN} NOT NULL,
        amount_minor BIGINT UNSIGNED NOT NULL, currency CHAR(3) ${BIN} NOT NULL,
        note VARCHAR(200) ${BIN} NULL,
        PRIMARY KEY (company_id,incident_id,id),
        KEY ix_incident_cost_line_order (company_id,incident_id,position),
        CONSTRAINT fk_incident_cost_line_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
        CONSTRAINT ck_incident_cost_line_category CHECK (
          (kind = 'expense' AND category IN ('repair','deductible','towing','fine','third_party_damage','legal','other'))
          OR (kind = 'recovery' AND category IN ('insurer','third_party','other'))),
        CONSTRAINT ck_incident_cost_line_amount CHECK (amount_minor > 0),
        CONSTRAINT ck_incident_cost_line_currency CHECK (currency REGEXP '^[A-Z]{3}$')
      ) ${TABLE}`,
      `CREATE TABLE \`${T.estimates}\` (
        ${ids}, amount_minor BIGINT UNSIGNED NOT NULL, currency CHAR(3) ${BIN} NOT NULL,
        updated_at DATETIME(6) NOT NULL, updated_by VARCHAR(72) ${BIN} NOT NULL,
        PRIMARY KEY (company_id,incident_id),
        CONSTRAINT fk_incident_cost_estimate_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
        CONSTRAINT ck_incident_cost_estimate_amount CHECK (amount_minor > 0),
        CONSTRAINT ck_incident_cost_estimate_currency CHECK (currency REGEXP '^[A-Z]{3}$')
      ) ${TABLE}`,
      `CREATE TABLE \`${T.snapshots}\` (
        ${ids}, cycle INT UNSIGNED NOT NULL, closed_at DATETIME(6) NOT NULL,
        totals JSON NOT NULL, orders JSON NOT NULL,
        PRIMARY KEY (company_id,incident_id,cycle),
        CONSTRAINT fk_incident_cost_snapshot_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
        CONSTRAINT ck_incident_cost_snapshot_cycle CHECK (cycle >= 1),
        CONSTRAINT ck_incident_cost_snapshot_totals CHECK (JSON_TYPE(totals) = 'ARRAY'),
        CONSTRAINT ck_incident_cost_snapshot_orders CHECK (JSON_TYPE(orders) = 'ARRAY')
      ) ${TABLE}`,
    ];
    for (const statement of ddl) await queryRunner.query(statement);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.snapshots);
    await queryRunner.dropTable(T.estimates);
    await queryRunner.dropTable(T.lines);
  }
}
