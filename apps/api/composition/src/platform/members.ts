import { randomUUID } from 'node:crypto';
import {
  AuthError,
  type TenantContext,
} from '../../../../../packages/domain/identity/src/index.js';
import { subjectId, type TenantId } from '../../../../../packages/domain/tenants/src/index.js';
import { ROLE_PERMISSIONS, isRoleName, type RoleName } from '../access.js';
import { ROLE_LABELS } from '../directory.js';
import { PlatformError, failure, nonEmpty, success, type PlatformResponse } from './errors.js';
import type { PlatformKernel } from './kernel.js';
import type { MemberView, RoleView } from './types.js';

export async function bumpProjection(
  k: PlatformKernel,
  tenantId: string,
  identityId: string,
  status: 'active' | 'revoked',
): Promise<void> {
  const current = await k.tenants.getMembership(tenantId as TenantId, subjectId(identityId));
  await k.tenants.projectMembership(
    tenantId as TenantId,
    subjectId(identityId),
    (current?.version ?? 0) + 1,
    status,
  );
}

export async function adminOperation<T>(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  targetIdentityId: string,
  work: (context: TenantContext) => Promise<T>,
): Promise<PlatformResponse<T>> {
  try {
    if (!nonEmpty(targetIdentityId)) throw new PlatformError('invalid_input');
    const first = await k.identity.authenticate(token, correlationId);
    return success(
      await k.locked(first.tenantId, async () => {
        // Authorize again inside the lock: an earlier queued change may have revoked this actor.
        const context = await k.authorize(token, correlationId, ['manage_users']);
        return work(context);
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

/**
 * Changes the role of a member of the caller's tenant. The membership projection version is
 * bumped, so the target's existing sessions stop working and a new login picks up the new role.
 */
export function changeRole(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  targetIdentityId: string,
  role: RoleName,
): Promise<PlatformResponse<null>> {
  return adminOperation(k, token, correlationId, targetIdentityId, async (context) => {
    if (!isRoleName(role)) throw new PlatformError('invalid_input');
    const current = k.access.roleOf(context.tenantId, targetIdentityId);
    if (!current) throw new PlatformError('not_found');
    if (
      current === 'admin' &&
      role !== 'admin' &&
      k.access.activeAdmins(context.tenantId).length <= 1
    )
      throw new PlatformError('last_admin');
    // Persisted first: the store enforces the last-administrator rule across processes and bumps
    // the persisted authorization version. The in-memory directory follows; if the rest of the
    // change fails, both writes are compensated so the directory and the store never disagree.
    await k.persistRole(context.tenantId, targetIdentityId, role);
    try {
      k.access.setRole(context.tenantId, targetIdentityId, role);
      await bumpProjection(k, context.tenantId, targetIdentityId, 'active');
    } catch (error) {
      k.access.setRole(context.tenantId, targetIdentityId, current);
      await k.persistRole(context.tenantId, targetIdentityId, current).catch(() => undefined);
      throw error;
    }
    k.auditNow(
      k.userActor(context),
      'membership.role_changed',
      'membership',
      targetIdentityId,
      correlationId,
    );
    return null;
  });
}

/**
 * Revokes a membership of the caller's tenant (identity sessions end through the authorization
 * version bump). Serialized per tenant so two concurrent removals cannot delete the last administrator.
 */
export function removeMember(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  targetIdentityId: string,
): Promise<PlatformResponse<null>> {
  return adminOperation(k, token, correlationId, targetIdentityId, async (context) => {
    const current = k.access.roleOf(context.tenantId, targetIdentityId);
    if (!current) {
      if (!k.access.hasPending(targetIdentityId, context.tenantId))
        throw new PlatformError('not_found');
      // A pending invitation (of any role) is revoked: the token can no longer be redeemed. It
      // holds no active seat, so the last-administrator rule does not apply.
      try {
        await k.identity.revokeMembership(context.tenantId, targetIdentityId);
      } catch (error) {
        // The store already holds no live membership (revoked elsewhere): the directory entry
        // must still go, or the member would stay listed as "invited" forever.
        if (!(error instanceof AuthError && error.code === 'not_found')) throw error;
      }
      k.access.revokePending(targetIdentityId, context.tenantId);
      k.auditNow(
        k.userActor(context),
        'invitation.revoked',
        'membership',
        targetIdentityId,
        correlationId,
      );
      return null;
    }
    if (current === 'admin' && k.access.activeAdmins(context.tenantId).length <= 1)
      throw new PlatformError('last_admin');
    await k.identity.revokeMembership(context.tenantId, targetIdentityId);
    k.access.revoke(context.tenantId, targetIdentityId);
    await bumpProjection(k, context.tenantId, targetIdentityId, 'revoked');
    k.auditNow(
      k.userActor(context),
      'membership.revoked',
      'membership',
      targetIdentityId,
      correlationId,
    );
    return null;
  });
}

/** Members and pending invitations of the caller's tenant (`manage_users`). */
export async function listMembers(
  k: PlatformKernel,
  token: string,
  correlationId: string,
): Promise<PlatformResponse<{ tenantId: string; members: readonly MemberView[] }>> {
  try {
    const context = await k.authorize(token, correlationId, ['manage_users']);
    const status = { active: 'active', pending: 'invited', revoked: 'inactive' } as const;
    return success({
      tenantId: context.tenantId,
      members: k.access.membersOf(context.tenantId).map((member) => ({
        id: member.identityId,
        roleId: member.role,
        roleLabel: ROLE_LABELS[member.role],
        status: status[member.status],
      })),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function roleViews(k: PlatformKernel, tenantId: string): Promise<readonly RoleView[]> {
  const members = k.access.membersOf(tenantId);
  const count = (roleId: string) =>
    members.filter((member) => member.status === 'active' && member.role === roleId).length;
  const system = (Object.keys(ROLE_LABELS) as RoleName[]).map((id) => ({
    id,
    name: ROLE_LABELS[id],
    kind: 'system' as const,
    permissions: ROLE_PERMISSIONS[id],
    memberCount: count(id),
  }));
  const custom = (await k.roles.custom(tenantId)).map((role) => ({
    id: role.id,
    name: role.name,
    kind: 'custom' as const,
    permissions: role.permissions,
    memberCount: 0,
  }));
  return [...system, ...custom];
}

/** System templates plus the tenant's custom roles (`manage_users`). */
export async function listRoles(
  k: PlatformKernel,
  token: string,
  correlationId: string,
): Promise<PlatformResponse<readonly RoleView[]>> {
  try {
    const context = await k.authorize(token, correlationId, ['manage_users']);
    return success(await roleViews(k, context.tenantId));
  } catch (error) {
    return failure(error);
  }
}

/** Copies a role of the caller's tenant (or a system template) under a new name (`manage_users`). */
export async function copyRole(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  roleId: string,
  name: unknown,
): Promise<PlatformResponse<RoleView>> {
  try {
    const context = await k.authorize(token, correlationId, ['manage_users']);
    const source = typeof roleId === 'string' ? await k.roles.find(context.tenantId, roleId) : null;
    if (!source) throw new PlatformError('not_found');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > 80) throw new PlatformError('invalid_input');
    const role = { id: `custom-${randomUUID()}`, name: trimmed, permissions: source.permissions };
    if ((await k.roles.create(context.tenantId, role)) !== 'created')
      throw new PlatformError('conflict');
    k.auditNow(k.userActor(context), 'role.copied', 'role', role.id, correlationId);
    return success({ ...role, kind: 'custom' as const, memberCount: 0 });
  } catch (error) {
    return failure(error);
  }
}
