import type {
  ExternalIdentity,
  Identity,
  IdentityStatus,
  MfaStatus,
  Membership,
  RecoveryRequest,
  Session,
} from '../../../domain/identity/src/index.js';
import type {
  ExternalIdentityEntity,
  IdentityEntity,
  MembershipEntity,
  RecoveryEntity,
  RoleEntity,
  RolePermissionEntity,
  SessionEntity,
} from './entities.js';
import type { CustomRoleRecord } from './role-model.js';

export const toIdentity = (row: IdentityEntity): Identity => ({
  id: row.id,
  status: row.status as IdentityStatus,
  mfa: row.mfa as MfaStatus,
  authorizationVersion: row.authorizationVersion,
  createdAt: row.createdAt,
});
export const toExternal = (row: ExternalIdentityEntity): ExternalIdentity => ({
  id: row.id,
  provider: row.provider,
  subject: row.subject,
  identityId: row.identityId,
  status: row.status as IdentityStatus,
  createdAt: row.createdAt,
});
export const toMembership = (row: MembershipEntity): Membership => ({
  id: row.id,
  tenantId: row.tenantId,
  identityId: row.identityId,
  status: row.status as Membership['status'],
  createdAt: row.createdAt,
  activatedAt: row.activatedAt,
});
export const toCustomRole = (
  role: RoleEntity,
  permissions: readonly RolePermissionEntity[],
): CustomRoleRecord => ({
  id: role.id,
  name: role.name,
  permissions: permissions
    .filter((permission) => permission.roleId === role.id)
    .sort((left, right) => left.position - right.position)
    .map((permission) => permission.permission),
});
export const toRecovery = (row: RecoveryEntity): RecoveryRequest => ({
  id: row.id,
  identityId: row.identityId,
  tokenHash: row.tokenHash,
  issuedAt: row.issuedAt,
  expiresAt: row.expiresAt,
  usedAt: row.usedAt,
  supersededAt: row.supersededAt,
});
export const toSession = (row: SessionEntity): Session => ({
  id: row.id,
  identityId: row.identityId,
  tenantId: row.tenantId,
  tokenHash: row.tokenHash,
  createdAt: row.createdAt,
  lastSeenAt: row.lastSeenAt,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  authorizationVersion: row.authorizationVersion,
});
