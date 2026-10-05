import { EntitySchema } from 'typeorm';
import type { MembershipStatus, TenantStatus } from '@opslog/domain-tenants';

export class TenantEntity {
  id!: string;
  name!: string;
  status!: TenantStatus;
  authorizationVersion!: number;
  createdAt!: Date;
}

export class TenantDatabaseLocationEntity {
  tenantId!: string;
  databaseName!: string;
  credentialRef!: string;
  secretVersion!: number;
  migrationVersion!: string | null;
  runtimeRoleVerified!: boolean;
  isolationProbeVerified!: boolean;
  verifiedAt!: Date | null;
}

export class MembershipProjectionEntity {
  tenantId!: string;
  subjectId!: string;
  status!: MembershipStatus;
  version!: number;
}

export class TenantSessionEntity {
  sessionIdHash!: string;
  tenantId!: string;
  subjectId!: string;
  authorizationVersion!: number;
  expiresAt!: Date;
  revoked!: boolean;
}

export class ProvisioningJobEntity {
  id!: string;
  idempotencyKey!: string;
  tenantId!: string;
  payloadHash!: string;
  status!: 'pending' | 'running' | 'succeeded' | 'failed';
  attempt!: number;
  leaseOwner!: string | null;
  leaseExpiresAt!: Date | null;
  errorCode!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export class TenantDataRecordEntity {
  id!: string;
  tenantId!: string;
  value!: string;
  version!: number;
}

export const TenantEntitySchema = new EntitySchema<TenantEntity>({
  name: 'TenantEntity',
  target: TenantEntity,
  tableName: 'opslog_control_tenants',
  columns: {
    id: { type: 'char', length: 36, primary: true },
    name: { type: 'varchar', length: 160 },
    status: { type: 'varchar', length: 24 },
    authorizationVersion: { name: 'authorization_version', type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
  },
});

export const TenantDatabaseLocationEntitySchema = new EntitySchema<TenantDatabaseLocationEntity>({
  name: 'TenantDatabaseLocationEntity',
  target: TenantDatabaseLocationEntity,
  tableName: 'opslog_control_tenant_locations',
  columns: {
    tenantId: { name: 'tenant_id', type: 'char', length: 36, primary: true },
    databaseName: { name: 'database_name', type: 'varchar', length: 128, unique: true },
    credentialRef: { name: 'credential_ref', type: 'varchar', length: 255, unique: true },
    secretVersion: { name: 'secret_version', type: 'int', unsigned: true },
    migrationVersion: { name: 'migration_version', type: 'varchar', length: 64, nullable: true },
    runtimeRoleVerified: { name: 'runtime_role_verified', type: 'boolean', default: false },
    isolationProbeVerified: { name: 'isolation_probe_verified', type: 'boolean', default: false },
    verifiedAt: { name: 'verified_at', type: 'datetime', precision: 6, nullable: true },
  },
});

export const MembershipProjectionEntitySchema = new EntitySchema<MembershipProjectionEntity>({
  name: 'MembershipProjectionEntity',
  target: MembershipProjectionEntity,
  tableName: 'opslog_control_memberships',
  columns: {
    tenantId: { name: 'tenant_id', type: 'char', length: 36, primary: true },
    subjectId: { name: 'subject_id', type: 'varchar', length: 255, primary: true },
    status: { type: 'varchar', length: 24 },
    version: { type: 'int', unsigned: true },
  },
});

export const TenantSessionEntitySchema = new EntitySchema<TenantSessionEntity>({
  name: 'TenantSessionEntity',
  target: TenantSessionEntity,
  tableName: 'opslog_control_sessions',
  columns: {
    sessionIdHash: { name: 'session_id_hash', type: 'char', length: 64, primary: true },
    tenantId: { name: 'tenant_id', type: 'char', length: 36 },
    subjectId: { name: 'subject_id', type: 'varchar', length: 255 },
    authorizationVersion: { name: 'authorization_version', type: 'int', unsigned: true },
    expiresAt: { name: 'expires_at', type: 'datetime', precision: 6 },
    revoked: { type: 'boolean', default: false },
  },
});

export const ProvisioningJobEntitySchema = new EntitySchema<ProvisioningJobEntity>({
  name: 'ProvisioningJobEntity',
  target: ProvisioningJobEntity,
  tableName: 'opslog_control_provisioning_jobs',
  columns: {
    id: { type: 'char', length: 36, unique: true },
    idempotencyKey: { name: 'idempotency_key', type: 'varchar', length: 255, primary: true },
    tenantId: { name: 'tenant_id', type: 'char', length: 36, unique: true },
    payloadHash: { name: 'payload_hash', type: 'char', length: 64 },
    status: { type: 'varchar', length: 24 },
    attempt: { type: 'int', unsigned: true },
    leaseOwner: { name: 'lease_owner', type: 'char', length: 36, nullable: true },
    leaseExpiresAt: { name: 'lease_expires_at', type: 'datetime', precision: 6, nullable: true },
    errorCode: { name: 'error_code', type: 'varchar', length: 64, nullable: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    updatedAt: { name: 'updated_at', type: 'datetime', precision: 6 },
  },
  indices: [{ name: 'ix_provisioning_status_lease', columns: ['status', 'leaseExpiresAt'] }],
});

export const TenantDataRecordEntitySchema = new EntitySchema<TenantDataRecordEntity>({
  name: 'TenantDataRecordEntity',
  target: TenantDataRecordEntity,
  tableName: 'opslog_tenant_records',
  columns: {
    id: { type: 'char', length: 36, primary: true },
    tenantId: { name: 'tenant_id', type: 'char', length: 36 },
    value: { type: 'varchar', length: 255 },
    version: { type: 'int', unsigned: true },
  },
  indices: [{ name: 'uq_tenant_record_tenant_id', columns: ['tenantId', 'id'], unique: true }],
});

export const CONTROL_PLANE_ENTITIES = [
  TenantEntitySchema,
  TenantDatabaseLocationEntitySchema,
  MembershipProjectionEntitySchema,
  TenantSessionEntitySchema,
  ProvisioningJobEntitySchema,
] as const;

export const TENANT_DATA_ENTITIES = [TenantDataRecordEntitySchema] as const;
