import type { AccessDirectory, StoredRoleReader } from '../access.js';
import { isRoleName } from '../access.js';
import type { PersistentTenantStore } from './persistent-tenant-store.js';

/**
 * Rebuilds the in-memory access directory after a restart from the durable control plane: every
 * active membership regains the role stored by the identity store. A membership whose stored role
 * is missing or unknown stays out, so that member cannot sign in until an administrator fixes it.
 * Pending invitations are not restored (their tokens fail closed); an administrator can re-invite.
 */
export async function hydrateAccessDirectory(
  access: AccessDirectory,
  tenants: PersistentTenantStore,
  roles: StoredRoleReader,
): Promise<number> {
  let restored = 0;
  for (const membership of tenants.activeMemberships()) {
    const role = await roles.findRole(membership.tenantId, membership.subjectId);
    if (!isRoleName(role)) continue;
    access.grant(membership.tenantId, membership.subjectId, role);
    restored += 1;
  }
  return restored;
}
