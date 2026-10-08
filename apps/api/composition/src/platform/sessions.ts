import { randomUUID } from 'node:crypto';
import {
  AuthError,
  type TenantContext,
} from '../../../../../packages/domain/identity/src/index.js';
import { isVerifiedExternalPrincipal } from '../../../../../packages/platform/auth/src/index.js';
import { subjectId, type TenantId } from '../../../../../packages/domain/tenants/src/index.js';
import { ROLE_LABELS } from '../directory.js';
import { PlatformError, failure, success, type PlatformResponse } from './errors.js';
import { sessionIdOf } from './gate.js';
import type { PlatformKernel } from './kernel.js';
import type { SessionDetails } from './types.js';

/**
 * Creates an active tenant and its first administrator from a verified external principal.
 * If the administrator cannot be activated, the tenant is marked failed and never serves requests.
 */
export async function bootstrapTenant(
  k: PlatformKernel,
  input: {
    name: string;
    adminPrincipal: unknown;
  },
): Promise<PlatformResponse<{ tenantId: string; adminIdentityId: string }>> {
  try {
    if (!isVerifiedExternalPrincipal(input.adminPrincipal)) throw new PlatformError('unauthorized');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 160)
      throw new PlatformError('invalid_input');
    const tenant = k.tenants.provisionVerified(input.name);
    try {
      const invitation = await k.identity.issueInvitation(tenant.id);
      // The persisted role is set while the membership is pending, so activation grants it directly.
      await k.persistRole(tenant.id, invitation.identityId, 'admin');
      const activation = await k.identity.activateInvitation(
        invitation.token,
        input.adminPrincipal.provider,
        input.adminPrincipal.subject,
      );
      const identityId = activation.identity.id;
      k.access.grant(tenant.id, identityId, 'admin');
      await k.tenants.projectMembership(tenant.id, subjectId(identityId), 1, 'active');
      await k.auditNow(
        { tenantId: tenant.id, actorId: 'system', actorKind: 'system' },
        'tenant.bootstrapped',
        'tenant',
        tenant.id,
        `bootstrap-${tenant.id}`,
      );
      return success({ tenantId: tenant.id, adminIdentityId: identityId });
    } catch (error) {
      await k.tenants.setTenantStatus(tenant.id, 'failed');
      throw error;
    }
  } catch (error) {
    return failure(error);
  }
}

/** Operator action (not reachable from a tenant session): the tenant stops serving requests and jobs. */
export function suspendTenant(k: PlatformKernel, tenantId: string): Promise<void> {
  return setStatus(k, tenantId, 'suspended', 'tenant.suspended');
}

export function reactivateTenant(k: PlatformKernel, tenantId: string): Promise<void> {
  return setStatus(k, tenantId, 'active', 'tenant.reactivated');
}

/** Status changes take the tenant lock, so they never interleave with a redemption in flight. */
export function setStatus(
  k: PlatformKernel,
  tenantId: string,
  status: 'active' | 'suspended',
  action: string,
) {
  return k.locked(tenantId, async () => {
    await k.tenants.setTenantStatus(tenantId as TenantId, status);
    await k.auditNow(
      { tenantId, actorId: 'system', actorKind: 'system' },
      action,
      'tenant',
      tenantId,
      `operator-${randomUUID()}`,
    );
  });
}

/** Login through the auth API, then mirror the session into the control plane at the current membership version. */
export async function signIn(
  k: PlatformKernel,
  principal: unknown,
): Promise<PlatformResponse<{ token: string; expiresAt: Date }>> {
  try {
    const login = await k.auth.login(principal);
    if (!login.ok || !login.value) return failure(new AuthError('unauthorized'));
    const { token, expiresAt } = login.value;
    try {
      const context = await k.identityOnly.authenticate(token, `signin-${randomUUID()}`);
      const membership = await k.tenants.getMembership(
        context.tenantId as TenantId,
        subjectId(context.actor.subject),
      );
      if (membership?.status !== 'active') throw new AuthError('unauthorized');
      await k.tenants.saveSession({
        id: sessionIdOf(token),
        subjectId: membership.subjectId,
        tenantId: membership.tenantId,
        authorizationVersion: membership.version,
        expiresAt,
        revoked: false,
      });
    } catch (error) {
      await k.identity.revoke(token);
      throw error;
    }
    return success({ token, expiresAt });
  } catch (error) {
    return failure(error);
  }
}

export async function signOut(k: PlatformKernel, token: string): Promise<PlatformResponse<null>> {
  try {
    await k.identity.revoke(token);
    const mirrored = await k.tenants.getSession(sessionIdOf(token));
    if (mirrored) await k.tenants.saveSession({ ...mirrored, revoked: true });
    return success(null);
  } catch (error) {
    return failure(error);
  }
}

export async function session(
  k: PlatformKernel,
  token: string,
  correlationId: string,
): Promise<PlatformResponse<TenantContext>> {
  try {
    return success(await k.identity.authenticate(token, correlationId));
  } catch (error) {
    return failure(error);
  }
}

/** What the browser may know about its own session: never a token. Fails closed like any authentication. */
export async function sessionDetails(
  k: PlatformKernel,
  token: string,
  correlationId: string,
): Promise<PlatformResponse<SessionDetails>> {
  try {
    const context = await k.identity.authenticate(token, correlationId);
    const role = await k.access.effectiveRole(context.tenantId, context.actor.subject);
    const mirrored = await k.tenants.getSession(sessionIdOf(token));
    if (!role || !mirrored) throw new AuthError('unauthorized');
    return success({
      tenantId: context.tenantId,
      companyName: k.tenantName(context.tenantId),
      identityId: context.actor.subject,
      roleId: role,
      roleLabel: ROLE_LABELS[role],
      permissions: await k.access.resolvePermissions(context),
      expiresAt: mirrored.expiresAt,
    });
  } catch (error) {
    return failure(error);
  }
}
