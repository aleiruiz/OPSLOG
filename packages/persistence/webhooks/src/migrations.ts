import type { MigrationInterface, QueryRunner } from 'typeorm';
import { DELIVERY_STATUSES, WEBHOOK_EVENTS } from '../../../domain/webhooks/src/index.js';
import { WEBHOOK_TABLES as T } from './entities.js';

export const WEBHOOK_MIGRATION_VERSION = '2026101900070';
export const WEBHOOK_MIGRATIONS_TABLE = 'opslog_webhooks_migrations';

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * Outgoing webhooks (MVP-WEBHOOKS): endpoints with their sealed secrets, deliveries with the exact
 * body they send, and the last known eligibility per driver. No column holds a plaintext secret,
 * the receiver's answer or personal data.
 */
export class CreateWebhooks2026101900070 implements MigrationInterface {
  public name = 'CreateWebhooks2026101900070';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.endpoints}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, id VARCHAR(64) ${BIN} NOT NULL,
        url VARCHAR(2048) ${BIN} NOT NULL, events JSON NOT NULL, active TINYINT(1) NOT NULL,
        disabled_reason VARCHAR(24) ${BIN} NULL, company_ref VARCHAR(40) ${BIN} NOT NULL,
        secret_sealed VARCHAR(1024) ${BIN} NOT NULL, previous_sealed VARCHAR(1024) ${BIN} NULL,
        previous_expires_at DATETIME(6) NULL, consecutive_failures INT NOT NULL DEFAULT 0,
        version INT NOT NULL, created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        created_by VARCHAR(128) ${BIN} NOT NULL,
        PRIMARY KEY (company_id,id),
        KEY ix_endpoint_company (company_id,created_at,id),
        CONSTRAINT ck_webhook_endpoint_failures CHECK (consecutive_failures >= 0),
        CONSTRAINT ck_webhook_endpoint_version CHECK (version >= 1)
      ) ${TABLE}`);
    await queryRunner.query(`CREATE TABLE \`${T.deliveries}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, id VARCHAR(64) ${BIN} NOT NULL,
        endpoint_id VARCHAR(64) ${BIN} NOT NULL, event_id VARCHAR(64) ${BIN} NOT NULL,
        event_type VARCHAR(32) ${BIN} NOT NULL, body TEXT ${BIN} NOT NULL,
        status VARCHAR(12) ${BIN} NOT NULL, attempts INT NOT NULL DEFAULT 0, manual TINYINT(1) NOT NULL DEFAULT 0,
        next_attempt_at DATETIME(6) NULL, lease_until DATETIME(6) NULL, last_attempt_at DATETIME(6) NULL,
        last_status_code SMALLINT NULL, last_duration_ms INT NULL, last_error VARCHAR(48) ${BIN} NULL,
        created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,id),
        UNIQUE KEY ux_delivery_event (company_id,endpoint_id,event_id),
        KEY ix_delivery_due (company_id,status,next_attempt_at),
        KEY ix_delivery_history (company_id,endpoint_id,created_at,id),
        KEY ix_delivery_attempt (company_id,last_attempt_at),
        KEY ix_delivery_retention (company_id,created_at),
        CONSTRAINT fk_webhook_delivery_endpoint FOREIGN KEY (company_id,endpoint_id) REFERENCES \`${T.endpoints}\` (company_id,id),
        CONSTRAINT ck_webhook_delivery_type CHECK (event_type IN ('ping',${list(WEBHOOK_EVENTS)})),
        CONSTRAINT ck_webhook_delivery_status CHECK (status IN (${list(DELIVERY_STATUSES)})),
        CONSTRAINT ck_webhook_delivery_attempts CHECK (attempts >= 0)
      ) ${TABLE}`);
    await queryRunner.query(`CREATE TABLE \`${T.driverState}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, driver_id VARCHAR(128) ${BIN} NOT NULL,
        eligible TINYINT(1) NOT NULL, transitions INT NOT NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,driver_id)
      ) ${TABLE}`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [T.driverState, T.deliveries, T.endpoints])
      await queryRunner.dropTable(table);
  }
}
