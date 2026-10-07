import { apiError, badRequest, ok } from './mockApiErrors';
import type { Guarded } from './mockApiTypes';
import type { ApiPorts, Page, RoleSummary, UserSummary } from './types';

/** Users and roles ports over the mock's shared identity state. */
export function createAccessPorts(
  guarded: Guarded,
  users: UserSummary[],
  roles: RoleSummary[],
  invitations: Map<string, { roleId: string; userId: string | null }>,
  roleName: (roleId: string) => string,
): Pick<ApiPorts, 'users' | 'roles'> {
  return {
    users: {
      listUsers: (query) =>
        guarded('listUsers', 'manage_users', () => {
          const sort = query.sort ?? 'id';
          const direction = query.direction ?? 'asc';
          const needle = (query.search ?? '').trim().toLowerCase();
          const limit = query.limit ?? 25;
          const offset =
            query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
          if (
            ![25, 50, 100].includes(limit) ||
            !['id', 'roleLabel', 'status'].includes(sort) ||
            !['asc', 'desc'].includes(direction) ||
            needle.length > 100 ||
            !Number.isSafeInteger(offset)
          )
            return badRequest();
          const sign = direction === 'asc' ? 1 : -1;
          // Same matching rule as the BFF: identifier or role label substring, or the exact status.
          const matches = users
            .filter(
              (user) =>
                !needle ||
                user.id.toLowerCase().includes(needle) ||
                user.roleLabel.toLowerCase().includes(needle) ||
                user.status === needle,
            )
            .sort((a, b) => sign * a[sort].localeCompare(b[sort]) || a.id.localeCompare(b.id));
          const items = matches.slice(offset, offset + limit);
          const next = offset + limit;
          const page: Page<UserSummary> = {
            items,
            nextCursor: next < matches.length ? `mock:${next}` : null,
            total: matches.length,
            sort: { field: sort, direction },
          };
          return ok(page);
        }),
      inviteUser: (input) =>
        guarded('inviteUser', 'manage_users', () => {
          if (!roles.some((role) => role.id === input.roleId)) return badRequest();
          const n = users.length + 1;
          const invited: UserSummary = {
            id: `user-invitado-${n}`,
            roleId: input.roleId,
            roleLabel: roleName(input.roleId),
            status: 'invited',
          };
          users.push(invited);
          const invitationToken = `invitacion-emitida-${n}`;
          invitations.set(invitationToken, { roleId: input.roleId, userId: invited.id });
          return ok({
            user: { id: invited.id, roleId: invited.roleId, status: 'invited' as const },
            invitationToken,
            expiresAt: '2026-10-09T12:00:00Z',
          });
        }),
      deactivateUser: (userId, reason) =>
        guarded('deactivateUser', 'manage_users', () => {
          const index = users.findIndex((user) => user.id === userId);
          const target = users[index];
          if (!target) return apiError(404, 'not_found', 'Resource not found');
          if (!reason.trim()) return badRequest();
          const admins = users.filter(
            (user) => user.roleId === 'role-admin' && user.status === 'active',
          );
          if (target.roleId === 'role-admin' && target.status === 'active' && admins.length === 1)
            return apiError(409, 'last_admin', 'Conflict');
          if (target.status === 'invited') {
            // Like the server: deactivating a pending member revokes the invitation, so its token
            // can no longer be inspected or accepted, and the pending row disappears.
            users.splice(index, 1);
            for (const [token, invitation] of invitations)
              if (invitation.userId === target.id) invitations.delete(token);
          } else users[index] = { ...target, status: 'inactive' };
          return ok({ id: target.id, status: 'inactive' as const });
        }),
    },
    roles: {
      listRoles: () =>
        guarded('listRoles', 'manage_users', () => ok(roles.map((role) => ({ ...role })))),
      copyRole: (roleId, name) =>
        guarded('copyRole', 'manage_users', () => {
          const source = roles.find((role) => role.id === roleId);
          if (!source) return apiError(404, 'not_found', 'Resource not found');
          if (!name.trim()) return badRequest();
          if (roles.some((role) => role.name.toLowerCase() === name.trim().toLowerCase()))
            return apiError(409, 'conflict', 'Conflict');
          const copy: RoleSummary = {
            id: `role-custom-${roles.length + 1}`,
            name: name.trim(),
            kind: 'custom',
            permissions: [...source.permissions],
            memberCount: 0,
          };
          roles.push(copy);
          return ok({ ...copy });
        }),
    },
  };
}
