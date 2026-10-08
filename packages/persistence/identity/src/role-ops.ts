import { AuthError, type IdentityMutationAudit } from '../../../domain/identity/src/index.js';
import { MembershipEntity, RoleEntity, RolePermissionEntity } from './entities.js';
import { CUSTOM_ROLE_LIMITS } from './role-model.js';
import type { CreateCustomRoleOutcome, CustomRoleRecord } from './role-model.js';
import { toCustomRole } from './row-mappers.js';
import type { IdentityStoreCore } from './store-core.js';
import { PERMISSION_PATTERN, ROLE_ID_PATTERN, invalid, nonBlank } from './store-support.js';

/**
 * Custom roles of the tenant, oldest first. Roles are immutable and their permission rows commit
 * with them; reading roles before permissions therefore never shows a role without its permissions.
 */
export async function listCustomRoles(
  core: IdentityStoreCore,
  tenantId: string,
): Promise<readonly CustomRoleRecord[]> {
  if (!nonBlank(tenantId, 64)) return [];
  return core.single('listCustomRoles', async () => {
    const roles = await core.dataSource.getRepository(RoleEntity).find({ where: { tenantId } });
    const permissions = await core.dataSource
      .getRepository(RolePermissionEntity)
      .find({ where: { tenantId } });
    return [...roles]
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : 1),
      )
      .map((role) => toCustomRole(role, permissions));
  });
}

/** One custom role of this tenant; another tenant's role id answers null, like an unknown one. */
export async function findCustomRole(
  core: IdentityStoreCore,
  tenantId: string,
  roleId: string,
): Promise<CustomRoleRecord | null> {
  if (!nonBlank(tenantId, 64) || !nonBlank(roleId, 64)) return null;
  return core.single('findCustomRole', async () => {
    const role = await core.dataSource
      .getRepository(RoleEntity)
      .findOneBy({ tenantId, id: roleId });
    if (!role) return null;
    const permissions = await core.dataSource
      .getRepository(RolePermissionEntity)
      .find({ where: { tenantId, roleId } });
    return toCustomRole(role, permissions);
  });
}

/**
 * Stores a custom role of the tenant. The name check and the per-tenant limit run under the
 * tenant lock row (the same one that serializes administrator changes), so concurrent creations in
 * any process can neither duplicate a name (case-insensitive) nor exceed `maxRoles`. Only a tenant
 * that already has memberships can hold roles. The role and its permissions commit together.
 */
export async function createCustomRole(
  core: IdentityStoreCore,
  tenantId: string,
  role: CustomRoleRecord,
  maxRoles: number,
  audit?: IdentityMutationAudit,
): Promise<CreateCustomRoleOutcome> {
  const name = typeof role.name === 'string' ? role.name.trim() : '';
  if (
    !nonBlank(tenantId, 64) ||
    typeof role.id !== 'string' ||
    !ROLE_ID_PATTERN.test(role.id) ||
    !nonBlank(name, CUSTOM_ROLE_LIMITS.nameLength) ||
    !Array.isArray(role.permissions) ||
    role.permissions.length > CUSTOM_ROLE_LIMITS.permissions ||
    new Set(role.permissions).size !== role.permissions.length ||
    !role.permissions.every(
      (permission) => typeof permission === 'string' && PERMISSION_PATTERN.test(permission),
    ) ||
    !Number.isSafeInteger(maxRoles) ||
    maxRoles < 1
  )
    return invalid();
  // Only an existing membership proves the tenant: no lock rows are created for unknown tenants.
  const known = await core.single('createCustomRole', () =>
    core.dataSource.getRepository(MembershipEntity).count({ where: { tenantId } }),
  );
  if (known === 0) throw new AuthError('not_found');
  await core.ensureTenantLock('createCustomRole', tenantId);
  const nameKey = name.toLowerCase();
  return core.transaction('createCustomRole', async (manager) => {
    await core.lockTenant(manager, tenantId);
    const roles = manager.getRepository(RoleEntity);
    const existing = await roles.find({ where: { tenantId } });
    if (existing.length >= maxRoles) return 'limit_reached' as const;
    if (existing.some((candidate) => candidate.nameKey === nameKey)) return 'name_taken' as const;
    await roles.insert({ tenantId, id: role.id, name, nameKey, createdAt: core.now() });
    const permissions = manager.getRepository(RolePermissionEntity);
    for (const [position, permission] of role.permissions.entries())
      await permissions.insert({ tenantId, roleId: role.id, permission, position });
    if (audit) await core.appendAudit(manager, audit);
    return 'created' as const;
  });
}
