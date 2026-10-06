import { EntitySchema } from 'typeorm';

/**
 * Key-like and text columns use a binary NO PAD collation: keys are compared exactly as normalized
 * by the domain, never folded again by the server.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const DOCUMENT_TABLES = {
  documents: 'opslog_documents',
  revisions: 'opslog_document_revisions',
} as const;

/**
 * Document row. `tenantId` is the BRD's `company_id`: part of the primary key and of every index,
 * so no query can reach a row without naming its company. The owner is typed: exactly one of
 * `vehicleId` and `employeeId` is set (a CHECK enforces it), never a free `type/id` pair.
 * The validity fields are a copy of the current revision; `expiryKey` is the sort and filter key
 * of `expiresOn` (`9999-12-31` when there is none).
 */
export class DocumentEntity {
  tenantId!: string;
  id!: string;
  ownerType!: string;
  vehicleId!: string | null;
  employeeId!: string | null;
  typeCode!: string;
  title!: string;
  notes!: string | null;
  revision!: number;
  issuedOn!: string | null;
  expiresOn!: string | null;
  expiryKey!: string;
  documentNumber!: string | null;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
  archivedAt!: Date | null;
}

/** Immutable snapshot of one revision: written once, never updated. */
export class DocumentRevisionEntity {
  tenantId!: string;
  documentId!: string;
  revision!: number;
  issuedOn!: string | null;
  expiresOn!: string | null;
  documentNumber!: string | null;
  actorId!: string;
  at!: Date;
}

const bin = BINARY_COLLATION;
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length,
  collation: bin,
  ...(nullable ? { nullable: true } : {}),
});
const fixed = (name: string, length: number, nullable = false) => ({
  name,
  type: 'char' as const,
  length,
  collation: bin,
  ...(nullable ? { nullable: true } : {}),
});

export const DocumentEntitySchema = new EntitySchema<DocumentEntity>({
  name: 'DocumentEntity',
  target: DocumentEntity,
  tableName: DOCUMENT_TABLES.documents,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    ownerType: text('owner_type', 16),
    vehicleId: text('vehicle_id', 64, true),
    employeeId: text('employee_id', 64, true),
    typeCode: text('type_code', 32),
    title: text('title', 80),
    notes: text('notes', 500, true),
    revision: { type: 'int', unsigned: true },
    issuedOn: fixed('issued_on', 10, true),
    expiresOn: fixed('expires_on', 10, true),
    expiryKey: fixed('expiry_key', 10),
    documentNumber: text('document_number', 40, true),
    version: { type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
    archivedAt: { name: 'archived_at', type: 'datetime', precision: 6, nullable: true },
  },
  indices: [
    { name: 'ix_documents_vehicle', columns: ['tenantId', 'vehicleId'] },
    { name: 'ix_documents_employee', columns: ['tenantId', 'employeeId'] },
    { name: 'ix_documents_type', columns: ['tenantId', 'typeCode'] },
    { name: 'ix_documents_listing', columns: ['tenantId', 'expiryKey', 'id'] },
  ],
});

export const DocumentRevisionEntitySchema = new EntitySchema<DocumentRevisionEntity>({
  name: 'DocumentRevisionEntity',
  target: DocumentRevisionEntity,
  tableName: DOCUMENT_TABLES.revisions,
  columns: {
    tenantId: { name: 'company_id', type: 'varchar', length: 64, collation: bin, primary: true },
    documentId: { ...text('document_id', 64), primary: true },
    revision: { type: 'int', unsigned: true, primary: true },
    issuedOn: fixed('issued_on', 10, true),
    expiresOn: fixed('expires_on', 10, true),
    documentNumber: text('document_number', 40, true),
    actorId: text('actor_id', 64),
    at: { type: 'datetime', precision: 6 },
  },
});

export const DOCUMENT_ENTITIES = [DocumentEntitySchema, DocumentRevisionEntitySchema] as const;
