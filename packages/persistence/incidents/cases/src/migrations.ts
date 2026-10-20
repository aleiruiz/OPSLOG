import type { MigrationInterface, QueryRunner } from 'typeorm';
import { INCIDENT_TABLES as T } from './entities.js';

/** Version of the last migration of the incidents module (the third parties and evidence, PR 2). */
export const INCIDENT_MIGRATION_VERSION = '2026101500020';
export const INCIDENT_MIGRATIONS_TABLE = 'opslog_incident_migrations';

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const id = (name: string, nullable = false) =>
  `${name} VARCHAR(64) ${BIN} ${nullable ? 'NULL' : 'NOT NULL'}`;
const actor = (name: string, nullable = false) =>
  `${name} VARCHAR(72) ${BIN} ${nullable ? 'NULL' : 'NOT NULL'}`;
const varchar = (name: string, length: number, nullable = true) =>
  `${name} VARCHAR(${length}) ${BIN} ${nullable ? 'NULL' : 'NOT NULL'}`;
const day = (name: string) => `${name} CHAR(10) ${BIN} NULL`;

// Literal copies of the catalog at the time of this migration: a migration never changes afterwards.
const STATUSES = [
  'draft',
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'closed',
  'reopened',
  'cancelled',
] as const;
const TYPES = [
  'collision',
  'rollover',
  'theft_total',
  'theft_partial',
  'vandalism',
  'parking_damage',
  'mechanical_failure',
  'traffic_violation',
  'injury',
  'other',
] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const COVERAGES = ['unknown', 'covered', 'multiple', 'none'] as const;
const RESULTS = ['pending', 'accepted', 'partial', 'rejected'] as const;
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');

/**
 * The whole M4 incident aggregate (INC-CASES defines every column, so INC-WORKFLOW and later
 * packages add behavior, not columns). No foreign key crosses modules: vehicle, driver, policy and
 * member references are validated by the service through ports. The timeline is append-only and
 * the runtime account never updates it.
 */
export class CreateIncidentCases2026101500010 implements MigrationInterface {
  public name = 'CreateIncidentCases2026101500010';
  public async up(queryRunner: QueryRunner): Promise<void> {
    const ddl = [
      `CREATE TABLE \`${T.incidents}\` (
        ${id('company_id')}, ${id('id')}, ${varchar('folio', 24, false)}, ${varchar('status', 24, false)},
        version INT UNSIGNED NOT NULL, cycle INT UNSIGNED NOT NULL, reopen_count INT UNSIGNED NOT NULL,
        ${varchar('type', 24, false)}, ${varchar('severity', 16)}, ${id('vehicle_id')}, ${id('area_id')},
        ${id('driver_id', true)}, ${varchar('no_driver_reason', 300)},
        occurred_at DATETIME(6) NULL, ${day('occurred_on')}, ${varchar('location_text', 300)},
        location_latitude DECIMAL(9,6) NULL, location_longitude DECIMAL(9,6) NULL,
        ${varchar('description', 4000)}, vehicle_operable BOOLEAN NULL,
        ${varchar('damage_description', 2000)}, damage_zones JSON NOT NULL,
        ${varchar('no_photo_justification', 500)},
        ${varchar('coverage_status', 16, false)}, policy_snapshot JSON NULL,
        reported_at DATETIME(6) NULL, ${actor('reported_by', true)}, ${actor('responsible_id', true)},
        ${varchar('insurer_name', 200)}, ${varchar('claim_number', 100)}, ${varchar('adjuster_name', 200)},
        ${varchar('adjuster_contact', 200)}, ${day('insurer_reported_on')}, ${varchar('insurer_result', 16)},
        ${varchar('rejection_reason', 1000)}, ${varchar('appeal_note', 1000)},
        ${varchar('no_insurance_reason', 1000)}, cost_assumed BOOLEAN NULL,
        ${varchar('resolution_summary', 2000)}, total_loss BOOLEAN NULL,
        ${varchar('vehicle_status_decision', 32)}, resolved_at DATETIME(6) NULL,
        ${actor('assumption_approved_by', true)}, assumption_approved_at DATETIME(6) NULL,
        ${actor('close_approved_by', true)}, close_approved_at DATETIME(6) NULL,
        closed_at DATETIME(6) NULL, ${actor('closed_by', true)}, ${varchar('cancel_reason', 1000)},
        created_at DATETIME(6) NOT NULL, ${actor('created_by')}, updated_at DATETIME(6) NOT NULL, ${actor('updated_by')},
        PRIMARY KEY (company_id,id), UNIQUE KEY uq_incident_folio (company_id,folio),
        KEY ix_incident_listing (company_id,created_at,id), KEY ix_incident_occurred (company_id,occurred_at,id),
        KEY ix_incident_vehicle (company_id,vehicle_id,status), KEY ix_incident_responsible (company_id,responsible_id),
        CONSTRAINT ck_incident_folio CHECK (folio REGEXP '^SIN-[0-9]{4}-[0-9]{6,}$'),
        CONSTRAINT ck_incident_status CHECK (status IN (${list(STATUSES)})),
        CONSTRAINT ck_incident_type CHECK (type IN (${list(TYPES)})),
        CONSTRAINT ck_incident_severity CHECK (severity IS NULL OR severity IN (${list(SEVERITIES)})),
        CONSTRAINT ck_incident_coverage CHECK (coverage_status IN (${list(COVERAGES)})),
        CONSTRAINT ck_incident_coverage_policy CHECK ((coverage_status = 'covered') = (policy_snapshot IS NOT NULL)),
        CONSTRAINT ck_incident_insurer_result CHECK (insurer_result IS NULL OR insurer_result IN (${list(RESULTS)})),
        CONSTRAINT ck_incident_version CHECK (version >= 1 AND cycle >= 1),
        CONSTRAINT ck_incident_event_day CHECK ((occurred_at IS NULL) = (occurred_on IS NULL)),
        CONSTRAINT ck_incident_driver CHECK (driver_id IS NULL OR no_driver_reason IS NULL),
        CONSTRAINT ck_incident_location CHECK ((location_latitude IS NULL) = (location_longitude IS NULL))
      ) ${TABLE}`,
      `CREATE TABLE \`${T.folios}\` (
        ${id('company_id')}, year SMALLINT UNSIGNED NOT NULL, ${varchar('kind', 16, false)},
        last_sequence INT UNSIGNED NOT NULL, PRIMARY KEY (company_id,year,kind),
        CONSTRAINT ck_incident_folio_kind CHECK (kind = 'incident')
      ) ${TABLE}`,
      `CREATE TABLE \`${T.transitions}\` (
        ${id('company_id')}, ${id('incident_id')}, sequence INT UNSIGNED NOT NULL, ${varchar('command', 32, false)},
        ${varchar('from_status', 24)}, ${varchar('to_status', 24, false)}, ${actor('actor_id')},
        ${varchar('comment', 1000)}, occurred_at DATETIME(6) NOT NULL, changed_fields JSON NOT NULL,
        before_snapshot JSON NULL, PRIMARY KEY (company_id,incident_id,sequence),
        CONSTRAINT fk_incident_transition_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${T.incidents}\` (company_id,id)
      ) ${TABLE}`,
      `CREATE TABLE \`${T.idempotency}\` (
        ${id('company_id')}, ${actor('actor_id')}, ${varchar('command', 32, false)},
        idempotency_key VARCHAR(128) ${BIN} NOT NULL, ${id('incident_id')},
        payload_hash CHAR(64) ${BIN} NOT NULL, ${varchar('status', 16, false)},
        response JSON NOT NULL, created_at DATETIME(6) NOT NULL, expires_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,actor_id,command,idempotency_key),
        KEY ix_incident_idempotency_expiry (company_id,expires_at),
        CONSTRAINT fk_incident_idempotency_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${T.incidents}\` (company_id,id),
        CONSTRAINT ck_incident_idempotency_status CHECK (status = 'completed'),
        CONSTRAINT ck_incident_idempotency_key CHECK (CHAR_LENGTH(idempotency_key) BETWEEN 8 AND 128)
      ) ${TABLE}`,
    ];
    for (const statement of ddl) await queryRunner.query(statement);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.idempotency);
    await queryRunner.dropTable(T.transitions);
    await queryRunner.dropTable(T.folios);
    await queryRunner.dropTable(T.incidents);
  }
}

export const INCIDENT_ANALYTICS_INDEX_MIGRATION_VERSION = '2026101900010';

/** Dashboard reads (MVP-ANALYTICS): open cases, and cases reported, resolved or closed in a range. */
export class AddIncidentAnalyticsIndexes2026101900010 implements MigrationInterface {
  public name = 'AddIncidentAnalyticsIndexes2026101900010';
  private static readonly INDEXES = [
    ['ix_incident_status', 'company_id,status'],
    ['ix_incident_reported', 'company_id,reported_at'],
    ['ix_incident_closed', 'company_id,closed_at'],
    ['ix_incident_resolved', 'company_id,cycle,resolved_at'],
  ] as const;
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, columns] of AddIncidentAnalyticsIndexes2026101900010.INDEXES)
      await queryRunner.query(`CREATE INDEX ${name} ON \`${T.incidents}\` (${columns})`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of AddIncidentAnalyticsIndexes2026101900010.INDEXES)
      await queryRunner.query(`DROP INDEX ${name} ON \`${T.incidents}\``);
  }
}
