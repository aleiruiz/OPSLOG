import { randomUUID } from 'node:crypto';
import { IsNull, MoreThan } from 'typeorm';
import {
  AuthError,
  type Identity,
  type Invitation,
  type InvitationActivation,
  type Membership,
  type IdentityMutationAudit,
  type InvitationActivationAudit,
} from '../../../domain/identity/src/index.js';
import {
  ExternalIdentityEntity,
  IdentityEntity,
  InvitationEntity,
  MembershipEntity,
  SessionEntity,
} from './entities.js';
import { isDuplicateKey } from './errors.js';
import { ADMIN_ROLE, DEFAULT_ROLE, isRoleName } from './role-model.js';
import { toIdentity, toMembership } from './row-mappers.js';
import type { IdentityStoreCore } from './store-core.js';
import {
  ActivationRejected,
  HASH_PATTERN,
  invalid,
  isDate,
  lock,
  nonBlank,
} from './store-support.js';

export async function findMembership(
  core: IdentityStoreCore,
  tenantId: string,
  identityId: string,
): Promise<Membership | null> {
  if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64)) return null;
  return core.single('findMembership', async () => {
    const row = await core.dataSource
      .getRepository(MembershipEntity)
      .findOneBy({ tenantId, identityId });
    return row ? toMembership(row) : null;
  });
}

/** Tenant of a valid invitation, scoped only to the token hash. */
export async function findInvitationTenant(
  core: IdentityStoreCore,
  tokenHash: string,
  at: Date,
): Promise<string | null> {
  if (!HASH_PATTERN.test(tokenHash) || !isDate(at)) return null;
  return core.single('findInvitationTenant', async () => {
    const row = await core.dataSource.getRepository(InvitationEntity).findOne({
      where: { tokenHash, consumedAt: IsNull(), expiresAt: MoreThan(at) },
      select: { tenantId: true },
    });
    return row?.tenantId ?? null;
  });
}

/** Role of an active membership of this tenant, or null (never reads another tenant's rows). */
export async function findRole(
  core: IdentityStoreCore,
  tenantId: string,
  identityId: string,
): Promise<string | null> {
  if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64)) return null;
  return core.single('findRole', async () => {
    const row = await core.dataSource
      .getRepository(MembershipEntity)
      .findOneBy({ tenantId, identityId, status: 'active' });
    return row ? row.role : null;
  });
}

export async function countActiveAdmins(
  core: IdentityStoreCore,
  tenantId: string,
): Promise<number> {
  if (!nonBlank(tenantId, 64)) return 0;
  return core.single('countActiveAdmins', () =>
    core.dataSource
      .getRepository(MembershipEntity)
      .count({ where: { tenantId, role: ADMIN_ROLE, status: 'active' } }),
  );
}

/**
 * Changes the role of a pending or active membership of the tenant. Demoting the last active
 * administrator is refused (`LastAdministratorError`). An active membership's role change bumps
 * the identity's authorization version so existing sessions stop working. Returns false when the
 * membership does not exist or is revoked.
 */
export async function setRole(
  core: IdentityStoreCore,
  tenantId: string,
  identityId: string,
  role: string,
  audit?: IdentityMutationAudit,
): Promise<boolean> {
  if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64) || !isRoleName(role)) return invalid();
  const known = await findMembership(core, tenantId, identityId);
  if (!known || known.status === 'revoked') return false;
  await core.ensureTenantLock('setRole', tenantId);
  return core.transaction('setRole', async (manager) => {
    await core.lockTenant(manager, tenantId);
    const identities = manager.getRepository(IdentityEntity);
    const memberships = manager.getRepository(MembershipEntity);
    if (!(await identities.findOne({ where: { id: identityId }, lock }))) return false;
    const current = await memberships.findOne({ where: { tenantId, identityId }, lock });
    if (!current || current.status === 'revoked') return false;
    if (current.role === role) return true;
    if (current.status === 'active' && current.role === ADMIN_ROLE && role !== ADMIN_ROLE)
      await core.assertAnotherAdmin(manager, tenantId);
    await memberships.update({ tenantId, identityId }, { role });
    if (current.status === 'active')
      await identities.increment({ id: identityId }, 'authorizationVersion', 1);
    if (audit) await core.appendAudit(manager, audit);
    return true;
  });
}

export async function writeInvitation(
  core: IdentityStoreCore,
  identity: Identity,
  membership: Membership,
  invitation: Invitation,
  supersededAt: Date,
  role: string | undefined,
  audit?: IdentityMutationAudit,
): Promise<void> {
  if (
    !nonBlank(identity.id, 64) ||
    !nonBlank(membership.tenantId, 64) ||
    !nonBlank(membership.id, 64) ||
    !nonBlank(invitation.id, 64) ||
    membership.identityId !== identity.id ||
    invitation.identityId !== identity.id ||
    membership.tenantId !== invitation.tenantId ||
    !HASH_PATTERN.test(invitation.tokenHash) ||
    !isDate(invitation.expiresAt) ||
    !isDate(supersededAt) ||
    !isDate(membership.createdAt) ||
    !isDate(identity.createdAt)
  )
    return invalid();
  const tenantId = membership.tenantId;
  await core.transaction('createInvitation', async (manager) => {
    const identities = manager.getRepository(IdentityEntity);
    const memberships = manager.getRepository(MembershipEntity);
    const existingIdentity = await identities.findOne({ where: { id: identity.id }, lock });
    if (existingIdentity?.status === 'revoked') throw new AuthError('conflict');
    if (!existingIdentity)
      await identities.insert({
        id: identity.id,
        status: identity.status,
        mfa: identity.mfa,
        authorizationVersion: identity.authorizationVersion,
        createdAt: identity.createdAt,
      });
    const current = await memberships.findOne({
      where: { tenantId, identityId: identity.id },
      lock,
    });
    if (current?.status === 'active') throw new AuthError('conflict');
    if (!current)
      await memberships.insert({
        tenantId,
        identityId: identity.id,
        id: membership.id,
        role: role ?? DEFAULT_ROLE,
        status: 'pending',
        createdAt: membership.createdAt,
        activatedAt: null,
      });
    else if (current.status === 'revoked')
      await memberships.update(
        { tenantId, identityId: identity.id },
        {
          id: membership.id,
          role: role ?? DEFAULT_ROLE,
          status: 'pending',
          createdAt: membership.createdAt,
          activatedAt: null,
        },
      );
    else if (role !== undefined && current.role !== role)
      await memberships.update({ tenantId, identityId: identity.id }, { role });
    // A newer invitation supersedes earlier unconsumed links of the same tenant and identity.
    await manager
      .getRepository(InvitationEntity)
      .update(
        { tenantId, identityId: identity.id, consumedAt: IsNull() },
        { consumedAt: supersededAt },
      );
    await manager.getRepository(InvitationEntity).insert({
      id: invitation.id,
      tenantId,
      identityId: identity.id,
      tokenHash: invitation.tokenHash,
      expiresAt: invitation.expiresAt,
      consumedAt: invitation.consumedAt,
    });
    if (audit) await core.appendAudit(manager, audit);
  });
}

export async function activateInvitation(
  core: IdentityStoreCore,
  tokenHash: string,
  provider: string,
  subject: string,
  activatedAt: Date,
  audit?: IdentityMutationAudit | InvitationActivationAudit,
): Promise<InvitationActivation | null> {
  if (
    !HASH_PATTERN.test(tokenHash) ||
    !nonBlank(provider, 200) ||
    !nonBlank(subject, 200) ||
    !isDate(activatedAt)
  )
    return null;
  try {
    return await core.transaction('activateInvitation', async (manager) => {
      const invitation = await manager.getRepository(InvitationEntity).findOneBy({ tokenHash });
      if (!invitation || invitation.consumedAt || invitation.expiresAt <= activatedAt)
        throw new ActivationRejected();
      const { tenantId, identityId } = invitation;
      const identities = manager.getRepository(IdentityEntity);
      const memberships = manager.getRepository(MembershipEntity);
      const externals = manager.getRepository(ExternalIdentityEntity);
      // Serialize concurrent activations of one identity (row lock), then re-validate under the lock.
      const identity = await identities.findOne({ where: { id: identityId }, lock });
      const membership = await memberships.findOne({ where: { tenantId, identityId }, lock });
      const linked = await externals.findOneBy({ provider, subject });
      const identityLink = await externals.findOneBy({ identityId });
      if (
        !identity ||
        identity.status === 'revoked' ||
        !membership ||
        membership.status !== 'pending' ||
        (linked !== null && linked.identityId !== identity.id) ||
        (identityLink !== null && identityLink.id !== linked?.id) ||
        (identityLink === null && identity.status !== 'pending')
      )
        throw new ActivationRejected();
      if (!linked) {
        try {
          await externals.insert({
            id: randomUUID(),
            provider,
            subject,
            identityId: identity.id,
            status: 'active',
            createdAt: activatedAt,
          });
        } catch (error) {
          // A concurrent winner linked this subject (or this identity) first.
          if (isDuplicateKey(error)) throw new ActivationRejected();
          throw error;
        }
      }
      await identities.update({ id: identity.id }, { status: 'active' });
      await memberships.update({ tenantId, identityId }, { status: 'active', activatedAt });
      const consumed = await manager
        .getRepository(InvitationEntity)
        .update(
          { id: invitation.id, consumedAt: IsNull(), expiresAt: MoreThan(activatedAt) },
          { consumedAt: activatedAt },
        );
      if (consumed.affected !== 1) throw new ActivationRejected();
      const activation = {
        identity: { ...toIdentity(identity), status: 'active' },
        membership: { ...toMembership(membership), status: 'active', activatedAt },
      } satisfies InvitationActivation;
      if (audit)
        await core.appendAudit(manager, typeof audit === 'function' ? audit(activation) : audit);
      return activation;
    });
  } catch (error) {
    if (error instanceof ActivationRejected) return null;
    throw error;
  }
}

/**
 * Revokes the membership and bumps the identity's authorization version in one transaction. The
 * tenant's final active administrator cannot be revoked (`LastAdministratorError`): the check runs
 * under the tenant lock row, so concurrent removals in any process serialize. The membership's
 * sessions are also marked revoked, and any unconsumed invitation of the membership is consumed (revoking a
 * pending invitation). Returns false when the membership is missing or already revoked.
 */
export async function revokeMembership(
  core: IdentityStoreCore,
  tenantId: string,
  identityId: string,
  audit?: IdentityMutationAudit,
): Promise<boolean> {
  if (!nonBlank(tenantId, 64) || !nonBlank(identityId, 64)) return false;
  // No lock rows are created for unknown tenants: only an existing membership proves the tenant.
  const known = await findMembership(core, tenantId, identityId);
  if (!known || known.status === 'revoked') return false;
  await core.ensureTenantLock('revokeMembership', tenantId);
  return core.transaction('revokeMembership', async (manager) => {
    await core.lockTenant(manager, tenantId);
    const identities = manager.getRepository(IdentityEntity);
    const memberships = manager.getRepository(MembershipEntity);
    if (!(await identities.findOne({ where: { id: identityId }, lock }))) return false;
    const current = await memberships.findOne({ where: { tenantId, identityId }, lock });
    if (!current || current.status === 'revoked') return false;
    if (current.status === 'active' && current.role === ADMIN_ROLE)
      await core.assertAnotherAdmin(manager, tenantId);
    await memberships.update({ tenantId, identityId }, { status: 'revoked' });
    // Revoking a pending membership also consumes its invitation links (single use, never redeemable again).
    await manager
      .getRepository(InvitationEntity)
      .update({ tenantId, identityId, consumedAt: IsNull() }, { consumedAt: core.now() });
    await manager
      .getRepository(SessionEntity)
      .update({ tenantId, identityId, revokedAt: IsNull() }, { revokedAt: core.now() });
    await identities.increment({ id: identityId }, 'authorizationVersion', 1);
    if (audit) await core.appendAudit(manager, audit);
    return true;
  });
}
