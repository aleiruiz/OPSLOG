import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CHANNELS,
  EVENT_KINDS,
  ENTITY_TYPES,
  SEVERITIES,
  SUBSCRIPTION_TYPES,
} from '../../../domain/notifications/src/index.js';
import { NOTIFICATION_TABLES as T } from './entities.js';

export const NOTIFICATION_MIGRATION_VERSION = '2026101900060';
export const NOTIFICATION_MIGRATIONS_TABLE = 'opslog_notifications_migrations';

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * Notification center (MVP-NOTIFY): notices, their deliveries by channel, per-person preferences,
 * the company rule and follows. No row holds an e-mail address, an amount or a record's free text.
 */
export class CreateNotifications2026101900060 implements MigrationInterface {
  public name = 'CreateNotifications2026101900060';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.notifications}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, id VARCHAR(64) ${BIN} NOT NULL,
        recipient_id VARCHAR(128) ${BIN} NOT NULL, event_kind VARCHAR(32) ${BIN} NOT NULL,
        entity_type VARCHAR(24) ${BIN} NOT NULL, entity_id VARCHAR(128) ${BIN} NOT NULL,
        title VARCHAR(160) ${BIN} NOT NULL, link VARCHAR(200) ${BIN} NOT NULL,
        severity VARCHAR(12) ${BIN} NOT NULL, in_app TINYINT(1) NOT NULL,
        date_version VARCHAR(40) ${BIN} NOT NULL, threshold VARCHAR(40) ${BIN} NOT NULL,
        created_at DATETIME(6) NOT NULL, read_at DATETIME(6) NULL,
        PRIMARY KEY (company_id,id),
        UNIQUE KEY ux_notice_dedupe (company_id,recipient_id,event_kind,entity_id,date_version,threshold),
        KEY ix_notice_center (company_id,recipient_id,in_app,created_at,id),
        CONSTRAINT ck_notice_kind CHECK (event_kind IN (${list(EVENT_KINDS)})),
        CONSTRAINT ck_notice_entity CHECK (entity_type IN (${list(ENTITY_TYPES)})),
        CONSTRAINT ck_notice_severity CHECK (severity IN (${list(SEVERITIES)}))
      ) ${TABLE}`);
    await queryRunner.query(`CREATE TABLE \`${T.deliveries}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, notification_id VARCHAR(64) ${BIN} NOT NULL,
        channel VARCHAR(8) ${BIN} NOT NULL, status VARCHAR(12) ${BIN} NOT NULL,
        attempts INT NOT NULL DEFAULT 0, last_error VARCHAR(48) ${BIN} NULL,
        next_attempt_at DATETIME(6) NULL, lease_until DATETIME(6) NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,notification_id,channel),
        KEY ix_delivery_due (company_id,status,next_attempt_at),
        CONSTRAINT fk_delivery_notice FOREIGN KEY (company_id,notification_id) REFERENCES \`${T.notifications}\` (company_id,id),
        CONSTRAINT ck_delivery_channel CHECK (channel IN (${list(CHANNELS)})),
        CONSTRAINT ck_delivery_status CHECK (status IN (${list(['pending', 'sent', 'failed', 'suppressed'])})),
        CONSTRAINT ck_delivery_attempts CHECK (attempts >= 0)
      ) ${TABLE}`);
    await queryRunner.query(`CREATE TABLE \`${T.preferences}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, recipient_id VARCHAR(128) ${BIN} NOT NULL,
        event_kind VARCHAR(32) ${BIN} NOT NULL, in_app TINYINT(1) NOT NULL, email TINYINT(1) NOT NULL,
        updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,recipient_id,event_kind),
        CONSTRAINT ck_pref_kind CHECK (event_kind IN (${list(EVENT_KINDS)}))
      ) ${TABLE}`);
    await queryRunner.query(`CREATE TABLE \`${T.rules}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, email_kinds JSON NOT NULL,
        quiet_hours TINYINT(1) NOT NULL, updated_at DATETIME(6) NULL,
        PRIMARY KEY (company_id)
      ) ${TABLE}`);
    await queryRunner.query(`CREATE TABLE \`${T.subscriptions}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, recipient_id VARCHAR(128) ${BIN} NOT NULL,
        entity_type VARCHAR(12) ${BIN} NOT NULL, entity_id VARCHAR(128) ${BIN} NOT NULL,
        created_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,recipient_id,entity_type,entity_id),
        KEY ix_sub_entity (company_id,entity_type,entity_id),
        CONSTRAINT ck_sub_type CHECK (entity_type IN (${list(SUBSCRIPTION_TYPES)}))
      ) ${TABLE}`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [T.subscriptions, T.rules, T.preferences, T.deliveries, T.notifications])
      await queryRunner.dropTable(table);
  }
}
