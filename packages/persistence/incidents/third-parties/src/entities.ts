import { EntitySchema } from 'typeorm';

export const INCIDENT_CHILD_TABLES = {
  thirdParties: 'opslog_incident_third_parties',
  evidence: 'opslog_incident_evidence',
} as const;

const bin = 'utf8mb4_0900_bin';
/**
 * Longest envelope a column holds (`pii1.` + key id + wrapped key + iv + ciphertext and tag, base64url).
 * The worst case is a 200-character contact of four-byte characters: 800 bytes of plaintext seal to
 * about 1,090 characters of ciphertext, and a real KMS adds a key id of up to 171 characters and a wrapped
 * key of a few hundred more (about 1,530 in all). 2,048 holds that with room; the first migration
 * created 1,024 and `WidenIncidentSealedColumns2026101500030` widens it.
 */
export const SEALED_LENGTH = 2048;

const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: bin,
  nullable,
});
const instant = (name: string, nullable = false) => ({
  name,
  type: 'datetime' as const,
  precision: 6,
  nullable,
});
const tenant = { tenantId: { ...text('company_id', 64), primary: true } };
const incident = { incidentId: { ...text('incident_id', 64), primary: true } };

export class IncidentThirdPartyEntity {
  tenantId!: string;
  incidentId!: string;
  id!: string;
  kind!: string;
  nameEnc!: string | null;
  contactEnc!: string | null;
  platesEnc!: string | null;
  policyNumberEnc!: string | null;
  insurerName!: string | null;
  damageDescription!: string | null;
  injuries!: boolean | number;
  removedAt!: Date | null;
  createdAt!: Date;
  createdBy!: string;
  updatedAt!: Date;
  updatedBy!: string;
}
export class IncidentEvidenceEntity {
  tenantId!: string;
  incidentId!: string;
  id!: string;
  fileId!: string;
  category!: string;
  stage!: string;
  capturedAt!: Date | null;
  clientCompressed!: boolean | number;
  displayName!: string;
  contentType!: string;
  sizeBytes!: number;
  attachedBy!: string;
  attachedAt!: Date;
}

/** Third parties of a case. The four protected columns only ever hold `pii1.` envelopes. */
export const ThirdPartySchema = new EntitySchema<IncidentThirdPartyEntity>({
  name: 'IncidentThirdPartyEntity',
  target: IncidentThirdPartyEntity,
  tableName: INCIDENT_CHILD_TABLES.thirdParties,
  columns: {
    ...tenant,
    ...incident,
    id: { ...text('id', 64), primary: true },
    kind: text('kind', 16),
    nameEnc: text('name_enc', SEALED_LENGTH, true),
    contactEnc: text('contact_enc', SEALED_LENGTH, true),
    platesEnc: text('plates_enc', SEALED_LENGTH, true),
    policyNumberEnc: text('policy_number_enc', SEALED_LENGTH, true),
    insurerName: text('insurer_name', 200, true),
    damageDescription: text('damage_description', 2000, true),
    injuries: { name: 'injuries', type: 'boolean' },
    removedAt: instant('removed_at', true),
    createdAt: instant('created_at'),
    createdBy: text('created_by', 72),
    updatedAt: instant('updated_at'),
    updatedBy: text('updated_by', 72),
  },
});

/** Links between a case and a file of the files module; a file is linked once per tenant. */
export const EvidenceSchema = new EntitySchema<IncidentEvidenceEntity>({
  name: 'IncidentEvidenceEntity',
  target: IncidentEvidenceEntity,
  tableName: INCIDENT_CHILD_TABLES.evidence,
  columns: {
    ...tenant,
    ...incident,
    id: { ...text('id', 64), primary: true },
    fileId: text('file_id', 64),
    category: text('category', 24),
    stage: text('stage', 16),
    capturedAt: instant('captured_at', true),
    clientCompressed: { name: 'client_compressed', type: 'boolean' },
    displayName: text('display_name', 255),
    contentType: text('content_type', 100),
    sizeBytes: { name: 'size_bytes', type: 'int', unsigned: true },
    attachedBy: text('attached_by', 72),
    attachedAt: instant('attached_at'),
  },
});

export const INCIDENT_CHILD_ENTITIES = [ThirdPartySchema, EvidenceSchema] as const;
