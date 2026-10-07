import {
  TenantAccessDeniedError,
  type Membership,
  type ProvisioningJob,
  type Session,
  type SessionId,
  type SubjectId,
  type Tenant,
  type TenantDatabaseLocation,
  type TenantId,
} from '@opslog/domain-tenants';
import type {
  MembershipProjectionEntity,
  ProvisioningJobEntity,
  TenantDatabaseLocationEntity,
  TenantEntity,
  TenantSessionEntity,
} from './entities.js';

export function toTenant(row: TenantEntity): Tenant {
  return Object.freeze({
    id: row.id as TenantId,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
  });
}
export function toMembership(row: MembershipProjectionEntity): Membership {
  return Object.freeze({
    tenantId: row.tenantId as TenantId,
    subjectId: row.subjectId as SubjectId,
    status: row.status,
    version: Number(row.version),
  });
}
export function toSession(row: TenantSessionEntity, id: SessionId): Session {
  return Object.freeze({
    id,
    tenantId: row.tenantId as TenantId,
    subjectId: row.subjectId as SubjectId,
    authorizationVersion: Number(row.authorizationVersion),
    expiresAt: row.expiresAt,
    revoked: row.revoked,
  });
}
export function toLocation(row: TenantDatabaseLocationEntity): TenantDatabaseLocation {
  if (
    !row.migrationVersion ||
    !row.verifiedAt ||
    !row.runtimeRoleVerified ||
    !row.isolationProbeVerified
  )
    throw new TenantAccessDeniedError();
  return Object.freeze({
    tenantId: row.tenantId as TenantId,
    databaseName: row.databaseName,
    credentialRef: row.credentialRef,
    secretVersion: Number(row.secretVersion),
    migrationVersion: row.migrationVersion,
    runtimeRoleVerified: row.runtimeRoleVerified,
    isolationProbeVerified: row.isolationProbeVerified,
    verifiedAt: row.verifiedAt,
  });
}
export function toJob(row: ProvisioningJobEntity): ProvisioningJob {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId as TenantId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    status: row.status,
    attempt: Number(row.attempt),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  });
}
