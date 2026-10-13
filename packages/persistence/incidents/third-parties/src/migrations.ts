import type { MigrationInterface, QueryRunner } from 'typeorm';
import { INCIDENT_CHILD_TABLES as T, SEALED_LENGTH } from './entities.js';

export const INCIDENT_CHILDREN_MIGRATION_VERSION = '2026101500020';

/** The table of the cases (INC-CASES PR 1). A migration is a literal copy and never follows a rename. */
const INCIDENTS_TABLE = 'opslog_incident_incidents';
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
const BIN = 'COLLATE utf8mb4_0900_bin';
const id = (name: string) => `${name} VARCHAR(64) ${BIN} NOT NULL`;
const actor = (name: string) => `${name} VARCHAR(72) ${BIN} NOT NULL`;
const varchar = (name: string, length: number, nullable = true) =>
  `${name} VARCHAR(${length}) ${BIN} ${nullable ? 'NULL' : 'NOT NULL'}`;
const sealed = (name: string) => `${varchar(name, SEALED_LENGTH)}`;
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');

const KINDS = ['person', 'vehicle', 'property'] as const;
const CATEGORIES = [
  'photo',
  'police_report',
  'driver_statement',
  'sketch',
  'budget',
  'invoice',
  'rejection_letter',
  'other',
] as const;
const STAGES = ['on_site', 'workshop', 'post_repair', 'other'] as const;

/**
 * Third parties and evidence of the cases (INC-CASES PR 2). The personal columns of a third party
 * only accept `pii1.` envelopes. A file is linked at most once per tenant, whichever case holds it.
 * No foreign key crosses modules: the file is validated through the files port.
 */
export class CreateIncidentChildren2026101500020 implements MigrationInterface {
  public name = 'CreateIncidentChildren2026101500020';
  public async up(queryRunner: QueryRunner): Promise<void> {
    const ddl = [
      `CREATE TABLE \`${T.thirdParties}\` (
        ${id('company_id')}, ${id('incident_id')}, ${id('id')}, ${varchar('kind', 16, false)},
        ${sealed('name_enc')}, ${sealed('contact_enc')}, ${sealed('plates_enc')}, ${sealed('policy_number_enc')},
        ${varchar('insurer_name', 200)}, ${varchar('damage_description', 2000)},
        injuries BOOLEAN NOT NULL, removed_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL, ${actor('created_by')}, updated_at DATETIME(6) NOT NULL, ${actor('updated_by')},
        PRIMARY KEY (company_id,incident_id,id),
        KEY ix_incident_third_party_live (company_id,incident_id,removed_at),
        CONSTRAINT fk_incident_third_party_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
        CONSTRAINT ck_incident_third_party_kind CHECK (kind IN (${list(KINDS)})),
        CONSTRAINT ck_incident_third_party_name CHECK (name_enc IS NULL OR name_enc LIKE 'pii1.%'),
        CONSTRAINT ck_incident_third_party_contact CHECK (contact_enc IS NULL OR contact_enc LIKE 'pii1.%'),
        CONSTRAINT ck_incident_third_party_plates CHECK (plates_enc IS NULL OR plates_enc LIKE 'pii1.%'),
        CONSTRAINT ck_incident_third_party_policy CHECK (policy_number_enc IS NULL OR policy_number_enc LIKE 'pii1.%')
      ) ${TABLE}`,
      `CREATE TABLE \`${T.evidence}\` (
        ${id('company_id')}, ${id('incident_id')}, ${id('id')}, ${id('file_id')},
        ${varchar('category', 24, false)}, ${varchar('stage', 16, false)}, captured_at DATETIME(6) NULL,
        client_compressed BOOLEAN NOT NULL, ${varchar('display_name', 255, false)},
        ${varchar('content_type', 100, false)}, size_bytes INT UNSIGNED NOT NULL,
        ${actor('attached_by')}, attached_at DATETIME(6) NOT NULL,
        PRIMARY KEY (company_id,incident_id,id),
        UNIQUE KEY uq_incident_evidence_file (company_id,file_id),
        CONSTRAINT fk_incident_evidence_incident FOREIGN KEY (company_id,incident_id) REFERENCES \`${INCIDENTS_TABLE}\` (company_id,id),
        CONSTRAINT ck_incident_evidence_category CHECK (category IN (${list(CATEGORIES)})),
        CONSTRAINT ck_incident_evidence_stage CHECK (stage IN (${list(STAGES)}))
      ) ${TABLE}`,
    ];
    for (const statement of ddl) await queryRunner.query(statement);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(T.evidence);
    await queryRunner.dropTable(T.thirdParties);
  }
}
