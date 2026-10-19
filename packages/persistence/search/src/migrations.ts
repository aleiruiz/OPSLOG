import type { MigrationInterface, QueryRunner } from 'typeorm';
import { SEARCH_TABLES as T } from './entities.js';

export const SEARCH_MIGRATION_VERSION = '2026101900010';
export const SEARCH_MIGRATIONS_TABLE = 'opslog_search_migrations';

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

const ENTITY_TYPES = ['vehicle', 'driver', 'dispatcher', 'incident', 'work_order', 'policy'];
const KEY_KINDS = [
  'economic_number',
  'plate',
  'vin',
  'name',
  'employee_number',
  'license',
  'folio',
  'claim_number',
  'policy_number',
  'identification_hmac',
];
const PERMISSIONS = ['view', 'view_pii', 'incidents:view'];

/**
 * Global search projection (MVP-SEARCH PR 1): one row per key of a vehicle, person, incident or
 * policy of the company. The B-tree serves the prefix match; the FULLTEXT index with the ngram
 * parser serves "contains". Stopwords are switched off for the index so that a fragment such as
 * «was» or «the» of a name still matches. The blind indexes of personal data live in `normalized`;
 * the value never does.
 */
export class CreateSearch2026101900010 implements MigrationInterface {
  public name = 'CreateSearch2026101900010';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`${T.entries}\` (
        company_id VARCHAR(64) ${BIN} NOT NULL, entity_type VARCHAR(16) ${BIN} NOT NULL,
        entity_id VARCHAR(64) ${BIN} NOT NULL, key_kind VARCHAR(24) ${BIN} NOT NULL,
        normalized VARCHAR(128) ${BIN} NOT NULL, area_id VARCHAR(64) ${BIN} NULL,
        display VARCHAR(200) ${BIN} NOT NULL, required_permission VARCHAR(16) ${BIN} NOT NULL,
        fingerprint CHAR(64) ${BIN} NOT NULL, updated_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,entity_type,entity_id,key_kind,normalized),
        KEY ix_search_prefix (company_id,entity_type,normalized),
        CONSTRAINT ck_search_entity_type CHECK (entity_type IN (${list(ENTITY_TYPES)})),
        CONSTRAINT ck_search_key_kind CHECK (key_kind IN (${list(KEY_KINDS)})),
        CONSTRAINT ck_search_permission CHECK (required_permission IN (${list(PERMISSIONS)})),
        CONSTRAINT ck_search_normalized CHECK (CHAR_LENGTH(normalized) >= 1)
      ) ${TABLE}`);
    // The stopword list is bound to the index when it is created; this session only.
    await queryRunner.query('SET SESSION innodb_ft_enable_stopword = 0');
    try {
      await queryRunner.query(
        `ALTER TABLE \`${T.entries}\` ADD FULLTEXT INDEX ft_search_normalized (normalized) WITH PARSER ngram`,
      );
    } finally {
      await queryRunner.query('SET SESSION innodb_ft_enable_stopword = 1');
    }
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.entries);
  }
}
