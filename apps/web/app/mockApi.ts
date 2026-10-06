import type { ApiError } from '@opslog/contracts';
import { createFakeOidc, fakeOidcCode, fakeOidcSubject } from '../api/fakeOidc';
import { createMockAreaStore, type MockAreaStore } from './mockAreas';
import { createMockVehicleStore, type MockVehicleStore } from './mockVehicles';
import type {
  ApiPorts,
  CompanySettings,
  DraftRecord,
  DraftValues,
  Page,
  Permission,
  Result,
  RoleSummary,
  SessionInfo,
  UserSummary,
  Vehicle,
  Area,
} from './types';

/**
 * Contract-typed in-memory API with the wire shapes of the BFF (opaque identities, OIDC sign-in,
 * uniform errors). It stays available for UI tests and local work without a server. It models the BFF session as a
 * private boolean (the httpOnly cookie) so nothing session-like is ever handed to browser code.
 * All data is synthetic.
 */
export type MockOperation =
  | 'getSession'
  | 'login'
  | 'logout'
  | 'inspectInvitation'
  | 'acceptInvitation'
  | 'getCompanySettings'
  | 'updateCompanySettings'
  | 'listUsers'
  | 'inviteUser'
  | 'deactivateUser'
  | 'listRoles'
  | 'copyRole'
  | 'loadDraft'
  | 'saveDraft'
  | 'discardDraft'
  | 'listVehicles'
  | 'getVehicle'
  | 'createVehicle'
  | 'updateVehicle'
  | 'recordOdometer'
  | 'archiveVehicle'
  | 'listAreas'
  | 'getArea'
  | 'createArea'
  | 'updateArea'
  | 'deactivateArea'
  | 'activateArea'
  | 'areaHistory';

export interface MockControls {
  /** Simulates the server-side session expiring (cookie no longer valid). */
  expireSession(): void;
  /** Makes the next call of `operation` fail with the given status. */
  failNext(operation: MockOperation, status?: ApiError['status']): void;
  isSignedIn(): boolean;
  /** Simulates a server-side status change of a user (e.g. suspension) without a UI path. */
  setUserStatus(userId: string, status: UserSummary['status']): void;
  /** Server-side drafts of the current user, for assertions. */
  storedDrafts(): Readonly<Record<string, DraftValues>>;
  /** Another actor edits a vehicle on the server: its version moves on, so a form that loaded it is stale. */
  changeVehicleExternally(
    id: string,
    change: Partial<Pick<Vehicle, 'odometerKm' | 'make' | 'model'>>,
  ): void;
  /** Another actor archives a vehicle on the server. */
  archiveVehicleExternally(id: string): void;
  /** Vehicles currently on the server, for assertions. */
  vehicles(): readonly Vehicle[];
  /** Another actor renames an area on the server: its version moves on, so a form that loaded it is stale. */
  changeAreaExternally(id: string, change: { name: string }): void;
  /** Another actor deactivates an area on the server. */
  deactivateAreaExternally(id: string): void;
  /** Active people the (not yet built) personnel module reports for an area: they block its deactivation. */
  setAreaPeople(id: string, people: number): void;
  /** Areas currently on the server, for assertions. */
  areas(): readonly Area[];
}

export interface MockApi extends ApiPorts {
  readonly controls: MockControls;
}

/** Synthetic accounts of the fake identity provider (what the person types as "Cuenta de prueba"). */
export const demoSubjects = {
  admin: 'cuenta-admin',
  viewer: 'cuenta-consulta',
  /** Can view, create and edit, but not archive (role "Despachador"). */
  dispatch: 'cuenta-despacho',
} as const;

/** What the fake provider hands the browser for each demo account. */
export const demoCredentials = {
  admin: { code: fakeOidcCode(demoSubjects.admin), nonce: 'nonce-demo-admin' },
  viewer: { code: fakeOidcCode(demoSubjects.viewer), nonce: 'nonce-demo-viewer' },
  dispatch: { code: fakeOidcCode(demoSubjects.dispatch), nonce: 'nonce-demo-dispatch' },
} as const;

export const demoInvitations = {
  valid: 'invitacion-vigente',
  expired: 'invitacion-vencida',
} as const;

const allPermissions: readonly Permission[] = [
  'manage_users',
  'manage_config',
  'view',
  'create',
  'edit',
  'delete',
  'export',
  'view_pii',
  'view_costs',
  'view_audit',
  'approve',
  'reopen',
  'incidents:report',
];

const systemRoles: RoleSummary[] = [
  {
    id: 'role-admin',
    name: 'Administrador de empresa',
    kind: 'system',
    permissions: allPermissions,
    memberCount: 1,
  },
  {
    id: 'role-fleet',
    name: 'Responsable de flotilla',
    kind: 'system',
    permissions: ['view', 'create', 'edit', 'export', 'view_costs', 'approve'],
    memberCount: 2,
  },
  {
    id: 'role-dispatch',
    name: 'Despachador',
    kind: 'system',
    permissions: ['view', 'create', 'edit', 'incidents:report'],
    memberCount: 3,
  },
  {
    id: 'role-claims',
    name: 'Responsable de siniestros',
    kind: 'system',
    permissions: ['view', 'create', 'edit', 'approve', 'reopen', 'view_costs'],
    memberCount: 1,
  },
  {
    id: 'role-mechanic',
    name: 'Mecánico',
    kind: 'system',
    permissions: ['view', 'edit'],
    memberCount: 4,
  },
  {
    id: 'role-supervisor',
    name: 'Supervisor o gerente',
    kind: 'system',
    permissions: ['view', 'export', 'view_costs', 'view_audit', 'approve'],
    memberCount: 1,
  },
  {
    id: 'role-viewer',
    name: 'Consulta',
    kind: 'system',
    permissions: ['view'],
    memberCount: 1,
  },
];

const people = [
  { id: 'user-admin', subject: demoSubjects.admin, role: 'role-admin' },
  { id: 'user-viewer', subject: demoSubjects.viewer, role: 'role-viewer' },
  { id: 'user-dispatch', subject: demoSubjects.dispatch, role: 'role-dispatch' },
] as const;

let correlation = 0;
/** Uniform error body of the BFF: a code, the status and a generic message; no per-field detail. */
function apiError(status: ApiError['status'], code: string, message: string): Result<never> {
  correlation += 1;
  const error: ApiError = { code, status, message, correlationId: `corr-mock-${correlation}` };
  return { ok: false, error };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => apiError(400, 'bad_request', 'Invalid request');

export interface MockApiOptions {
  /** Initial fleet: the synthetic demo fleet by default; pass `[]` for a company without vehicles. */
  readonly vehicles?: readonly Vehicle[];
  /** Initial areas: the synthetic demo tree by default; pass `[]` for a company without areas. */
  readonly areas?: readonly Area[];
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const fleet: MockVehicleStore = createMockVehicleStore(options.vehicles, undefined, (areaId) =>
    orgTree.snapshot().some((area) => area.id === areaId && area.active),
  );
  let signedInAs: string | null = null;
  const orgTree: MockAreaStore = createMockAreaStore(
    {
      liveVehicles: (areaId) =>
        fleet
          .snapshot()
          .filter(
            (vehicle) =>
              vehicle.areaId === areaId &&
              vehicle.archivedAt === null &&
              vehicle.status !== 'decommissioned',
          ).length,
      isMember: (userId) => users.some((user) => user.id === userId && user.status === 'active'),
      actorId: () => signedInAs ?? 'user-admin',
    },
    ...(options.areas ? [options.areas] : []),
  );
  const failures = new Map<MockOperation, ApiError['status']>();
  const drafts = new Map<string, DraftRecord>();
  let company: CompanySettings = {
    name: 'Transportes Demo SA',
    status: 'active',
    mfa: 'optional',
    sessionIdleHours: 8,
  };
  const roles: RoleSummary[] = systemRoles.map((role) => ({ ...role }));
  // Identity provider accounts (subject -> user id). Only active users may sign in.
  const subjects = new Map<string, string>(people.map((person) => [person.subject, person.id]));
  // Invitations by token: the role they grant and, for issued ones, the pending user they activate.
  const invitations = new Map<string, { roleId: string; userId: string | null }>([
    [demoInvitations.valid, { roleId: 'role-fleet', userId: null }],
  ]);
  const users: UserSummary[] = [
    ...people.map((person) => ({
      id: person.id,
      roleId: person.role,
      roleLabel: roleName(person.role),
      status: 'active' as const,
    })),
    ...Array.from({ length: 24 }, (_, index) => {
      const n = String(index + 1).padStart(2, '0');
      return {
        id: `user-sintetico-${n}`,
        roleId: 'role-mechanic',
        roleLabel: roleName('role-mechanic'),
        status: 'active' as const,
      };
    }),
  ];

  function roleName(roleId: string): string {
    return roles.find((role) => role.id === roleId)?.name ?? roleId;
  }
  const currentUser = () =>
    users.find((user) => user.id === signedInAs && user.status === 'active');
  const sessionFor = (userId: string): SessionInfo => {
    const user = users.find((item) => item.id === userId) as UserSummary;
    const role = roles.find((item) => item.id === user.roleId) as RoleSummary;
    return {
      company: { id: 'company-demo', name: company.name },
      user: { id: user.id },
      roleId: role.id,
      roleLabel: role.name,
      permissions: role.permissions,
      expiresAt: '2026-10-06T20:00:00Z',
    };
  };
  const injected = (operation: MockOperation): Result<never> | null => {
    const status = failures.get(operation);
    if (status === undefined) return null;
    failures.delete(operation);
    return apiError(status, 'injected_failure', 'Request failed');
  };
  const draftKey = (scope: string) => `${signedInAs ?? ''}:${scope}`;
  const unauthorized = () => apiError(401, 'unauthorized', 'Authentication required');
  /** Runs `action` only for a live session holding `permission` (when given). */
  function guarded<T>(
    operation: MockOperation,
    permission: Permission | null,
    action: () => Result<T> | Promise<Result<T>>,
  ): Promise<Result<T>> {
    const failed = injected(operation);
    if (failed) return Promise.resolve(failed);
    const user = currentUser();
    if (!user) return Promise.resolve(unauthorized());
    const role = roles.find((item) => item.id === user.roleId);
    if (permission && !role?.permissions.includes(permission))
      return Promise.resolve(apiError(403, 'forbidden', 'Permission denied'));
    return Promise.resolve(action());
  }

  // Unknown, used, expired or mismatched invitations are indistinguishable.
  const invitationUnavailable = () => apiError(404, 'not_found', 'Resource not found');

  const controls: MockControls = {
    expireSession: () => {
      signedInAs = null;
    },
    failNext: (operation, status = 500) => {
      failures.set(operation, status);
    },
    isSignedIn: () => signedInAs !== null,
    setUserStatus: (userId, status) => {
      const index = users.findIndex((user) => user.id === userId);
      const target = users[index];
      if (target) users[index] = { ...target, status };
    },
    storedDrafts: () =>
      Object.fromEntries(
        [...drafts.entries()]
          .filter(([key]) => key.startsWith(`${signedInAs ?? ''}:`))
          .map(([key, record]) => [key.slice(key.indexOf(':') + 1), record.values]),
      ),
    changeVehicleExternally: (id, change) => fleet.changeExternally(id, change),
    archiveVehicleExternally: (id) => fleet.archiveExternally(id),
    vehicles: () => fleet.snapshot(),
    changeAreaExternally: (id, change) => orgTree.changeExternally(id, change),
    deactivateAreaExternally: (id) => orgTree.deactivateExternally(id),
    setAreaPeople: (id, people) => orgTree.setPeople(id, people),
    areas: () => orgTree.snapshot(),
  };

  return {
    controls,
    oidc: createFakeOidc(),
    auth: {
      getSession: () =>
        guarded('getSession', null, () => ok(sessionFor(signedInAs as string))).then((result) => {
          // An inactive user's session is gone, consistent with the 401.
          if (!result.ok && result.error.status === 401) signedInAs = null;
          return result;
        }),
      login: (input) => {
        const failed = injected('login');
        if (failed) return Promise.resolve(failed);
        const subject = fakeOidcSubject(input.code);
        const userId = subject === null || !input.nonce ? undefined : subjects.get(subject);
        const user = users.find((item) => item.id === userId);
        // Every login failure is the same 401.
        if (!user || user.status !== 'active') return Promise.resolve(unauthorized());
        signedInAs = user.id;
        return Promise.resolve(ok(sessionFor(user.id)));
      },
      logout: () => {
        const failed = injected('logout');
        if (failed) return Promise.resolve(failed);
        signedInAs = null;
        return Promise.resolve(ok(null));
      },
      inspectInvitation: (token) => {
        const failed = injected('inspectInvitation');
        if (failed) return Promise.resolve(failed);
        const invitation = invitations.get(token);
        if (!invitation) return Promise.resolve(invitationUnavailable());
        return Promise.resolve(
          ok({ companyName: company.name, roleLabel: roleName(invitation.roleId) }),
        );
      },
      acceptInvitation: (token, input) => {
        const failed = injected('acceptInvitation');
        if (failed) return Promise.resolve(failed);
        const subject = fakeOidcSubject(input.code);
        if (subject === null || !input.nonce) return Promise.resolve(unauthorized());
        const invitation = invitations.get(token);
        // Never replace an existing account.
        if (!invitation || subjects.has(subject)) return Promise.resolve(invitationUnavailable());
        const pending = invitation.userId
          ? users.findIndex((item) => item.id === invitation.userId)
          : -1;
        let userId: string;
        if (pending >= 0) {
          userId = (users[pending] as UserSummary).id;
          users[pending] = { ...(users[pending] as UserSummary), status: 'active' };
        } else {
          userId = `user-${subject}`;
          users.push({
            id: userId,
            roleId: invitation.roleId,
            roleLabel: roleName(invitation.roleId),
            status: 'active',
          });
        }
        invitations.delete(token);
        subjects.set(subject, userId);
        signedInAs = userId;
        return Promise.resolve(ok(sessionFor(userId)));
      },
    },
    tenant: {
      getCompanySettings: () => guarded('getCompanySettings', 'manage_config', () => ok(company)),
      updateCompanySettings: (input) =>
        guarded('updateCompanySettings', 'manage_config', () => {
          if (
            !input.name.trim() ||
            !Number.isInteger(input.sessionIdleHours) ||
            input.sessionIdleHours < 1 ||
            input.sessionIdleHours > 24
          )
            return badRequest();
          const securityChanged =
            input.mfa !== company.mfa || input.sessionIdleHours !== company.sessionIdleHours;
          if (securityChanged && !input.reason?.trim()) return badRequest();
          company = {
            ...company,
            name: input.name.trim(),
            mfa: input.mfa,
            sessionIdleHours: input.sessionIdleHours,
          };
          return ok(company);
        }),
    },
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
    vehicles: {
      list: (query) => guarded('listVehicles', 'view', () => fleet.port.list(query)),
      get: (id) => guarded('getVehicle', 'view', () => fleet.port.get(id)),
      create: (input) => guarded('createVehicle', 'create', () => fleet.port.create(input)),
      update: (id, patch) => guarded('updateVehicle', 'edit', () => fleet.port.update(id, patch)),
      recordOdometer: (id, reading) =>
        guarded('recordOdometer', 'edit', () => fleet.port.recordOdometer(id, reading)),
      archive: (id, version) =>
        guarded('archiveVehicle', 'delete', () => fleet.port.archive(id, version)),
    },
    areas: {
      list: (query) => guarded('listAreas', 'view', () => orgTree.port.list(query)),
      get: (id) => guarded('getArea', 'view', () => orgTree.port.get(id)),
      create: (input) => guarded('createArea', 'create', () => orgTree.port.create(input)),
      update: (id, patch) => guarded('updateArea', 'edit', () => orgTree.port.update(id, patch)),
      deactivate: (id, version) =>
        guarded('deactivateArea', 'delete', () => orgTree.port.deactivate(id, version)),
      activate: (id, version) =>
        guarded('activateArea', 'edit', () => orgTree.port.activate(id, version)),
      history: (id, query) => guarded('areaHistory', 'view', () => orgTree.port.history(id, query)),
    },
    drafts: {
      load: (scope) => guarded('loadDraft', null, () => ok(drafts.get(draftKey(scope)) ?? null)),
      save: (scope, values) =>
        guarded('saveDraft', null, () => {
          const record: DraftRecord = {
            scope,
            values: { ...values },
            savedAt: '2026-10-06T12:00:00Z',
          };
          drafts.set(draftKey(scope), record);
          return ok(record);
        }),
      discard: (scope) =>
        guarded('discardDraft', null, () => {
          drafts.delete(draftKey(scope));
          return ok(null);
        }),
    },
  };
}
