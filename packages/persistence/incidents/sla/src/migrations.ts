import type { MigrationInterface, QueryRunner } from 'typeorm';
import { INCIDENT_SLA_TABLES as T } from './entities.js';

/** Version of the last migration of the incident SLA. */
export const INCIDENT_SLA_MIGRATION_VERSION = '2026101700030';
export const INCIDENT_SLA_MIGRATIONS_TABLE = 'opslog_incident_sla_migrations';

/** The table of the cases (INC-CASES PR 1). A migration is a literal copy and never follows a rename. */
const INCIDENTS_TABLE = 'opslog_incident_incidents';
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const KINDS = [
  'assigned',
  'sla_warning',
  'sla_breach',
  'unassigned',
  'unassigned_escalation',
  'inactive',
  'inactive_escalation',
];
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * Incident SLA (INC-SLA): the target of each cycle, the notices and one delivery row per notice,
 * recipient and channel. The delivery keeps no address and no content (BR-023). Notices and
 * deliveries are never deleted by the runtime account.
 */
export class CreateIncidentSla2026101700030 implements MigrationInterface {
  public name = 'CreateIncidentSla2026101700030';
  public async up(queryRunner: QueryRunner): Promise<void> {
    const ddl = [
      `CREATE TABLE \`${T.cycles}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, incident_id VARCHAR(64) ${BIN} NOT NULL,
        cycle INT UNSIGNED NOT NULL, started_at DATETIME(6) NOT NULL,
        severity VARCHAR(16) ${BIN} NOT NULL, target_days SMALLINT UNSIGNED NOT NULL,
        target_version INT UNSIGNED NOT NULL,
        PRIMARY KEY (company_id,incident_id,cycle),
        CONSTRAINT fk_incident_sla_cycle_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
        CONSTRAINT ck_incident_sla_cycle CHECK (cycle >= 1 AND target_version >= 1 AND target_days BETWEEN 1 AND 365),
        CONSTRAINT ck_incident_sla_cycle_severity CHECK (severity IN ('low','medium','high','critical'))
      ) ${TABLE}`,
      `CREATE TABLE \`${T.alerts}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, id VARCHAR(64) ${BIN} NOT NULL,
        incident_id VARCHAR(64) ${BIN} NOT NULL, folio VARCHAR(24) ${BIN} NOT NULL,
        cycle INT UNSIGNED NOT NULL, kind VARCHAR(24) ${BIN} NOT NULL,
        dedupe_ref VARCHAR(40) ${BIN} NOT NULL, severity VARCHAR(16) ${BIN} NULL,
        deadline_at DATETIME(6) NULL, subject_id VARCHAR(72) ${BIN} NULL,
        created_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,id),
        UNIQUE KEY uq_incident_sla_alert (company_id,incident_id,cycle,kind,dedupe_ref),
        KEY ix_incident_sla_alert_list (company_id,created_at,id),
        CONSTRAINT fk_incident_sla_alert_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
        CONSTRAINT ck_incident_sla_alert_kind CHECK (kind IN (${list(KINDS)})),
        CONSTRAINT ck_incident_sla_alert_cycle CHECK (cycle >= 1),
        CONSTRAINT ck_incident_sla_alert_severity CHECK (severity IS NULL OR severity IN ('low','medium','high','critical'))
      ) ${TABLE}`,
      `CREATE TABLE \`${T.deliveries}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, alert_id VARCHAR(64) ${BIN} NOT NULL,
        recipient_id VARCHAR(72) ${BIN} NOT NULL, channel VARCHAR(16) ${BIN} NOT NULL,
        status VARCHAR(16) ${BIN} NOT NULL, attempts SMALLINT UNSIGNED NOT NULL,
        next_attempt_at DATETIME(6) NULL, lease_until DATETIME(6) NULL,
        PRIMARY KEY (company_id,alert_id,recipient_id,channel),
        CONSTRAINT fk_incident_sla_delivery_alert FOREIGN KEY (company_id,alert_id) REFERENCES \`${T.alerts}\` (company_id,id),
        CONSTRAINT ck_incident_sla_delivery_channel CHECK (channel = 'email'),
        CONSTRAINT ck_incident_sla_delivery_status CHECK (status IN ('pending','sent','skipped','failed'))
      ) ${TABLE}`,
    ];
    for (const statement of ddl) await queryRunner.query(statement);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.deliveries);
    await queryRunner.dropTable(T.alerts);
    await queryRunner.dropTable(T.cycles);
  }
}
