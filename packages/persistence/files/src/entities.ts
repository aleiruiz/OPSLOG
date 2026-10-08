import { EntitySchema } from 'typeorm';
import type {
  FileKind,
  FileStatus,
  RejectionReason,
  Sensitivity,
} from '../../../domain/files/src/index.js';

export const FILE_TABLES = {
  records: 'opslog_files',
  history: 'opslog_file_history',
  saga: 'opslog_file_saga',
} as const;

export type FileSagaStage = 'upload' | 'scan' | 'cleanup_quarantine' | 'cleanup_released';
export type FileSagaState = 'pending' | 'processing' | 'retry' | 'completed';

export class FileRecordEntity {
  tenantId!: string;
  id!: string;
  kind!: FileKind;
  originalId!: string | null;
  status!: FileStatus;
  sensitivity!: Sensitivity;
  contentType!: string;
  sizeBytes!: number;
  sha256!: string;
  displayName!: string;
  width!: number | null;
  height!: number | null;
  createdBy!: string;
  createdAt!: Date;
  scannedAt!: Date | null;
  rejectionReason!: RejectionReason | null;
}

export class FileHistoryEntity {
  tenantId!: string;
  id!: string;
  fileId!: string;
  version!: number;
  fromStatus!: FileStatus | null;
  toStatus!: FileStatus;
  actorId!: string;
  at!: Date;
}

export class FileSagaEntity {
  tenantId!: string;
  fileId!: string;
  stage!: FileSagaStage;
  state!: FileSagaState;
  attempts!: number;
  availableAt!: Date;
  leaseUntil!: Date | null;
  expiresAt!: Date | null;
  scanOutcome!: 'clean' | 'rejected' | null;
  rejectionReason!: RejectionReason | null;
  updatedAt!: Date;
}

const text = (length: number) => ({
  type: 'varchar' as const,
  length: String(length),
  collation: 'utf8mb4_0900_bin',
});

export const FileRecordSchema = new EntitySchema<FileRecordEntity>({
  name: 'FileRecordEntity',
  target: FileRecordEntity,
  tableName: FILE_TABLES.records,
  columns: {
    tenantId: { name: 'tenant_id', ...text(64), primary: true },
    id: { ...text(64), primary: true },
    kind: { type: 'enum', enum: ['original', 'derivative'] },
    originalId: { name: 'original_id', ...text(64), nullable: true },
    status: { type: 'enum', enum: ['pending_upload', 'pending_scan', 'clean', 'rejected'] },
    sensitivity: { type: 'enum', enum: ['standard', 'pii'] },
    contentType: { name: 'content_type', ...text(128) },
    sizeBytes: { name: 'size_bytes', type: 'int', unsigned: true },
    sha256: { type: 'char', length: '64', collation: 'ascii_bin' },
    displayName: { name: 'display_name', ...text(96) },
    width: { type: 'smallint', unsigned: true, nullable: true },
    height: { type: 'smallint', unsigned: true, nullable: true },
    createdBy: { name: 'created_by', ...text(128) },
    createdAt: { name: 'created_at', type: 'datetime', precision: 3 },
    scannedAt: { name: 'scanned_at', type: 'datetime', precision: 3, nullable: true },
    rejectionReason: {
      name: 'rejection_reason',
      type: 'enum',
      enum: ['malware', 'integrity'],
      nullable: true,
    },
  },
  indices: [
    { name: 'ix_files_tenant_status_created', columns: ['tenantId', 'status', 'createdAt'] },
  ],
  foreignKeys: [
    {
      name: 'fk_files_original',
      columnNames: ['tenantId', 'originalId'],
      target: FILE_TABLES.records,
      referencedColumnNames: ['tenantId', 'id'],
    },
  ],
});

export const FileHistorySchema = new EntitySchema<FileHistoryEntity>({
  name: 'FileHistoryEntity',
  target: FileHistoryEntity,
  tableName: FILE_TABLES.history,
  columns: {
    tenantId: { name: 'tenant_id', ...text(64), primary: true },
    id: { ...text(64), primary: true },
    fileId: { name: 'file_id', ...text(64) },
    version: { type: 'int', unsigned: true },
    fromStatus: {
      name: 'from_status',
      type: 'enum',
      enum: ['pending_upload', 'pending_scan', 'clean', 'rejected'],
      nullable: true,
    },
    toStatus: {
      name: 'to_status',
      type: 'enum',
      enum: ['pending_upload', 'pending_scan', 'clean', 'rejected'],
    },
    actorId: { name: 'actor_id', ...text(128) },
    at: { type: 'datetime', precision: 3 },
  },
  uniques: [{ name: 'uq_file_history_version', columns: ['tenantId', 'fileId', 'version'] }],
  foreignKeys: [
    {
      name: 'fk_file_history_record',
      columnNames: ['tenantId', 'fileId'],
      target: FILE_TABLES.records,
      referencedColumnNames: ['tenantId', 'id'],
    },
  ],
});

export const FileSagaSchema = new EntitySchema<FileSagaEntity>({
  name: 'FileSagaEntity',
  target: FileSagaEntity,
  tableName: FILE_TABLES.saga,
  columns: {
    tenantId: { name: 'tenant_id', ...text(64), primary: true },
    fileId: { name: 'file_id', ...text(64), primary: true },
    stage: {
      type: 'enum',
      enum: ['upload', 'scan', 'cleanup_quarantine', 'cleanup_released'],
      primary: true,
    },
    state: { type: 'enum', enum: ['pending', 'processing', 'retry', 'completed'] },
    attempts: { type: 'int', unsigned: true },
    availableAt: { name: 'available_at', type: 'datetime', precision: 3 },
    leaseUntil: { name: 'lease_until', type: 'datetime', precision: 3, nullable: true },
    expiresAt: { name: 'expires_at', type: 'datetime', precision: 3, nullable: true },
    scanOutcome: {
      name: 'scan_outcome',
      type: 'enum',
      enum: ['clean', 'rejected'],
      nullable: true,
    },
    rejectionReason: {
      name: 'rejection_reason',
      type: 'enum',
      enum: ['malware', 'integrity'],
      nullable: true,
    },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 3 },
  },
  indices: [
    { name: 'ix_file_saga_due', columns: ['stage', 'state', 'availableAt', 'leaseUntil'] },
    { name: 'ix_file_saga_expiry', columns: ['stage', 'expiresAt'] },
  ],
  foreignKeys: [
    {
      name: 'fk_file_saga_record',
      columnNames: ['tenantId', 'fileId'],
      target: FILE_TABLES.records,
      referencedColumnNames: ['tenantId', 'id'],
    },
  ],
});

export const FILE_ENTITIES = [FileRecordSchema, FileHistorySchema, FileSagaSchema] as const;
