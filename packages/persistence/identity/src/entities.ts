import { EntitySchema } from 'typeorm';

/**
 * Every key-like column uses a binary NO PAD collation: provider/subject pairs, tenant ids and token
 * hashes are case- and whitespace-sensitive. The default case-insensitive collation would let two
 * different OIDC subjects (or tenants) collide on a unique key.
 */
export const BINARY_COLLATION = 'utf8mb4_0900_bin';

export const IDENTITY_TABLES = {
  identities: 'opslog_identity_identities',
  external: 'opslog_identity_external_identities',
  memberships: 'opslog_identity_memberships',
  invitations: 'opslog_identity_invitations',
  recoveries: 'opslog_identity_recoveries',
  sessions: 'opslog_identity_sessions',
  tenantLocks: 'opslog_identity_tenant_locks',
} as const;

export class IdentityEntity {
  id!: string;
  status!: string;
  mfa!: string;
  authorizationVersion!: number;
  createdAt!: Date;
}

export class ExternalIdentityEntity {
  id!: string;
  provider!: string;
  subject!: string;
  identityId!: string;
  status!: string;
  createdAt!: Date;
}

export class MembershipEntity {
  tenantId!: string;
  identityId!: string;
  id!: string;
  role!: string;
  status!: string;
  createdAt!: Date;
  activatedAt!: Date | null;
}

export class InvitationEntity {
  id!: string;
  tenantId!: string;
  identityId!: string;
  tokenHash!: string;
  expiresAt!: Date;
  consumedAt!: Date | null;
}

export class RecoveryEntity {
  id!: string;
  identityId!: string;
  tokenHash!: string;
  issuedAt!: Date;
  expiresAt!: Date;
  usedAt!: Date | null;
  supersededAt!: Date | null;
}

export class SessionEntity {
  id!: string;
  identityId!: string;
  tenantId!: string;
  tokenHash!: string;
  createdAt!: Date;
  lastSeenAt!: Date;
  expiresAt!: Date;
  revokedAt!: Date | null;
  authorizationVersion!: number;
}

export class TenantLockEntity {
  tenantId!: string;
  createdAt!: Date;
}

const bin = BINARY_COLLATION;

export const IdentityEntitySchema = new EntitySchema<IdentityEntity>({
  name: 'IdentityEntity',
  target: IdentityEntity,
  tableName: IDENTITY_TABLES.identities,
  columns: {
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    status: { type: 'varchar', length: 16, collation: bin },
    mfa: { type: 'varchar', length: 16, collation: bin },
    authorizationVersion: { name: 'authorization_version', type: 'int', unsigned: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
  },
});

export const ExternalIdentityEntitySchema = new EntitySchema<ExternalIdentityEntity>({
  name: 'ExternalIdentityEntity',
  target: ExternalIdentityEntity,
  tableName: IDENTITY_TABLES.external,
  columns: {
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    provider: { type: 'varchar', length: 200, collation: bin },
    subject: { type: 'varchar', length: 200, collation: bin },
    identityId: { name: 'identity_id', type: 'varchar', length: 64, collation: bin },
    status: { type: 'varchar', length: 16, collation: bin },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
  },
  uniques: [
    { name: 'uq_identity_external_subject', columns: ['provider', 'subject'] },
    { name: 'uq_identity_external_identity', columns: ['identityId'] },
  ],
});

export const MembershipEntitySchema = new EntitySchema<MembershipEntity>({
  name: 'MembershipEntity',
  target: MembershipEntity,
  tableName: IDENTITY_TABLES.memberships,
  columns: {
    tenantId: { name: 'tenant_id', type: 'varchar', length: 64, collation: bin, primary: true },
    identityId: { name: 'identity_id', type: 'varchar', length: 64, collation: bin, primary: true },
    id: { type: 'varchar', length: 64, collation: bin },
    role: { type: 'varchar', length: 32, collation: bin },
    status: { type: 'varchar', length: 16, collation: bin },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    activatedAt: { name: 'activated_at', type: 'datetime', precision: 6, nullable: true },
  },
  uniques: [{ name: 'uq_identity_memberships_id', columns: ['id'] }],
  indices: [
    { name: 'ix_identity_memberships_identity', columns: ['identityId'] },
    { name: 'ix_identity_memberships_role', columns: ['tenantId', 'role', 'status'] },
  ],
});

export const InvitationEntitySchema = new EntitySchema<InvitationEntity>({
  name: 'InvitationEntity',
  target: InvitationEntity,
  tableName: IDENTITY_TABLES.invitations,
  columns: {
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    tenantId: { name: 'tenant_id', type: 'varchar', length: 64, collation: bin },
    identityId: { name: 'identity_id', type: 'varchar', length: 64, collation: bin },
    tokenHash: { name: 'token_hash', type: 'char', length: 64, collation: bin },
    expiresAt: { name: 'expires_at', type: 'datetime', precision: 6 },
    consumedAt: { name: 'consumed_at', type: 'datetime', precision: 6, nullable: true },
  },
  uniques: [{ name: 'uq_identity_invitations_token', columns: ['tokenHash'] }],
  indices: [
    { name: 'ix_identity_invitations_member', columns: ['tenantId', 'identityId', 'consumedAt'] },
  ],
});

export const RecoveryEntitySchema = new EntitySchema<RecoveryEntity>({
  name: 'RecoveryEntity',
  target: RecoveryEntity,
  tableName: IDENTITY_TABLES.recoveries,
  columns: {
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    identityId: { name: 'identity_id', type: 'varchar', length: 64, collation: bin },
    tokenHash: { name: 'token_hash', type: 'char', length: 64, collation: bin },
    issuedAt: { name: 'issued_at', type: 'datetime', precision: 6 },
    expiresAt: { name: 'expires_at', type: 'datetime', precision: 6 },
    usedAt: { name: 'used_at', type: 'datetime', precision: 6, nullable: true },
    supersededAt: { name: 'superseded_at', type: 'datetime', precision: 6, nullable: true },
  },
  uniques: [{ name: 'uq_identity_recoveries_token', columns: ['tokenHash'] }],
  indices: [{ name: 'ix_identity_recoveries_identity', columns: ['identityId', 'usedAt'] }],
});

export const SessionEntitySchema = new EntitySchema<SessionEntity>({
  name: 'SessionEntity',
  target: SessionEntity,
  tableName: IDENTITY_TABLES.sessions,
  columns: {
    id: { type: 'varchar', length: 64, collation: bin, primary: true },
    identityId: { name: 'identity_id', type: 'varchar', length: 64, collation: bin },
    tenantId: { name: 'tenant_id', type: 'varchar', length: 64, collation: bin },
    tokenHash: { name: 'token_hash', type: 'char', length: 64, collation: bin },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
    lastSeenAt: { name: 'last_seen_at', type: 'datetime', precision: 6 },
    expiresAt: { name: 'expires_at', type: 'datetime', precision: 6 },
    revokedAt: { name: 'revoked_at', type: 'datetime', precision: 6, nullable: true },
    authorizationVersion: { name: 'authorization_version', type: 'int', unsigned: true },
  },
  uniques: [{ name: 'uq_identity_sessions_token', columns: ['tokenHash'] }],
  indices: [
    { name: 'ix_identity_sessions_member', columns: ['tenantId', 'identityId', 'revokedAt'] },
    { name: 'ix_identity_sessions_expires', columns: ['expiresAt'] },
  ],
});

export const TenantLockEntitySchema = new EntitySchema<TenantLockEntity>({
  name: 'TenantLockEntity',
  target: TenantLockEntity,
  tableName: IDENTITY_TABLES.tenantLocks,
  columns: {
    tenantId: { name: 'tenant_id', type: 'varchar', length: 64, collation: bin, primary: true },
    createdAt: { name: 'created_at', type: 'datetime', precision: 6 },
  },
});

export const IDENTITY_ENTITIES = [
  IdentityEntitySchema,
  ExternalIdentityEntitySchema,
  MembershipEntitySchema,
  InvitationEntitySchema,
  RecoveryEntitySchema,
  SessionEntitySchema,
  TenantLockEntitySchema,
] as const;
