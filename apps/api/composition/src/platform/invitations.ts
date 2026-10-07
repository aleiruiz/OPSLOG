import { randomUUID } from 'node:crypto';
import {
  AuthError,
  opaqueTokenGenerator,
} from '../../../../../packages/domain/identity/src/index.js';
import { subjectId, type TenantId } from '../../../../../packages/domain/tenants/src/index.js';
import { isRoleName, type RoleName } from '../access.js';
import { ROLE_LABELS } from '../directory.js';
import { PlatformError, failure, success, type PlatformResponse } from './errors.js';
import type { PlatformKernel } from './kernel.js';

export async function inviteUser(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  role: RoleName,
): Promise<PlatformResponse<{ invitationToken: string; expiresAt: Date; identityId: string }>> {
  try {
    if (!isRoleName(role)) throw new PlatformError('invalid_input');
    const context = await k.authorize(token, correlationId, ['manage_users']);
    const invitation = await k.identity.issueInvitation(context.tenantId);
    await k.persistRole(context.tenantId, invitation.identityId, role);
    k.access.expectInvitation(invitation.identityId, context.tenantId, role);
    const nowMs = k.now().getTime();
    for (const [hash, meta] of k.invitations)
      if (meta.expiresAt.getTime() <= nowMs) k.invitations.delete(hash);
    k.invitations.set(opaqueTokenGenerator.hash(invitation.token), {
      tenantId: context.tenantId,
      identityId: invitation.identityId,
      role,
      expiresAt: invitation.expiresAt,
    });
    k.auditNow(
      k.userActor(context),
      'user.invited',
      'membership',
      invitation.identityId,
      correlationId,
    );
    return success({
      invitationToken: invitation.token,
      expiresAt: invitation.expiresAt,
      identityId: invitation.identityId,
    });
  } catch (error) {
    return failure(error);
  }
}

/** Activates an invitation for a verified principal and projects the new membership into the control plane. */
export async function acceptInvitation(
  k: PlatformKernel,
  invitationToken: string,
  principal: unknown,
): Promise<PlatformResponse<{ identityId: string; tenantId: string }>> {
  try {
    // Same gate as `inspectInvitation`: a suspended or failed tenant is frozen, so the redemption
    // fails with the uniform error before anything is consumed, activated or audited. The
    // invitation stays redeemable (until it expires) once the tenant is active again.
    const meta =
      typeof invitationToken === 'string'
        ? k.invitations.get(opaqueTokenGenerator.hash(invitationToken))
        : undefined;
    // Activation and directory update run under the tenant lock, like every other change of
    // membership, so a concurrent revocation of the same pending invitation cannot interleave.
    // An invitation unknown to the composition keeps the unlocked, fail-closed path below.
    return await (meta
      ? k.locked(meta.tenantId, () => redeem(k, invitationToken, principal, meta.tenantId))
      : redeem(k, invitationToken, principal, null));
  } catch (error) {
    return failure(error);
  }
}

export async function redeem(
  k: PlatformKernel,
  invitationToken: string,
  principal: unknown,
  lockedTenantId: string | null,
): Promise<PlatformResponse<{ identityId: string; tenantId: string }>> {
  try {
    if (lockedTenantId !== null && k.tenants.status(lockedTenantId) !== 'active')
      throw new AuthError('unauthorized');
    const activated = await k.auth.activateInvitation(invitationToken, principal);
    if (!activated.ok || !activated.value) return failure(new AuthError('unauthorized'));
    const { identity, membership } = activated.value;
    k.invitations.delete(opaqueTokenGenerator.hash(invitationToken));
    if (!k.access.activate(identity.id, membership.tenantId)) {
      // No role was recorded for this invitation: it did not come from `inviteUser`; fail closed.
      await k.identity.revokeMembership(membership.tenantId, identity.id);
      throw new PlatformError('forbidden');
    }
    const current = await k.tenants.getMembership(
      membership.tenantId as TenantId,
      subjectId(identity.id),
    );
    await k.tenants.projectMembership(
      membership.tenantId as TenantId,
      subjectId(identity.id),
      (current?.version ?? 0) + 1,
      'active',
    );
    k.auditNow(
      { tenantId: membership.tenantId, actorId: `user-${identity.id}`, actorKind: 'user' },
      'user.joined',
      'membership',
      identity.id,
      `accept-${randomUUID()}`,
    );
    return success({ identityId: identity.id, tenantId: membership.tenantId });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Public preview of an invitation (company and role) for the person about to accept it. Unknown,
 * expired, used and revoked invitations are indistinguishable: all answer not_found.
 */
export async function inspectInvitation(
  k: PlatformKernel,
  invitationToken: string,
): Promise<PlatformResponse<{ companyName: string; roleLabel: string }>> {
  try {
    if (typeof invitationToken !== 'string' || !invitationToken || invitationToken.length > 512)
      throw new PlatformError('not_found');
    const hash = opaqueTokenGenerator.hash(invitationToken);
    const meta = k.invitations.get(hash);
    if (!meta) throw new PlatformError('not_found');
    const expired = meta.expiresAt.getTime() <= k.now().getTime();
    if (
      expired ||
      !k.access.hasPending(meta.identityId, meta.tenantId) ||
      k.tenants.status(meta.tenantId) !== 'active'
    ) {
      if (expired) k.invitations.delete(hash);
      throw new PlatformError('not_found');
    }
    return success({
      companyName: k.tenantName(meta.tenantId),
      roleLabel: ROLE_LABELS[meta.role],
    });
  } catch (error) {
    return failure(error);
  }
}
