import type { ApiError } from '@opslog/contracts';
import { createFakeOidc, fakeOidcSubject } from '../api/fakeOidc';
import { demoEmployeeIds } from '../documents/fixtures';
import { createAccessPorts } from './mockApiAccessPorts';
import { createControls } from './mockApiControls';
import { apiError, badRequest, ok } from './mockApiErrors';
import { demoInvitations, people, systemRoles } from './mockApiFixtures';
import { createModulePorts } from './mockApiModulePorts';
import type { Guarded, MockApi, MockApiOptions, MockOperation } from './mockApiTypes';
import { createMockAreaStore, type MockAreaStore } from './mockAreas';
import { createMockDocumentStore, type MockDocumentStore } from './mockDocuments';
import { createMockInsuranceStore, type MockInsuranceStore } from './mockInsurance';
import { createMockEmployeeStore, type MockEmployeeStore } from './mockEmployees';
import { createMockVehicleStore, type MockVehicleStore } from './mockVehicles';
import type {
  CompanySettings,
  DraftRecord,
  Permission,
  Result,
  RoleSummary,
  SessionInfo,
  UserSummary,
} from './types';

export type { MockApi, MockApiOptions, MockControls, MockOperation } from './mockApiTypes';
export { demoCredentials, demoInvitations, demoSubjects } from './mockApiFixtures';

/**
 * Contract-typed in-memory API with the wire shapes of the BFF (opaque identities, OIDC sign-in,
 * uniform errors). It stays available for UI tests and local work without a server. It models the BFF session as a
 * private boolean (the httpOnly cookie) so nothing session-like is ever handed to browser code.
 * All data is synthetic.
 */

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const fleet: MockVehicleStore = createMockVehicleStore(options.vehicles, undefined, (areaId) =>
    orgTree.snapshot().some((area) => area.id === areaId && area.active),
  );
  let signedInAs: string | null = null;
  const staff: MockEmployeeStore = createMockEmployeeStore(
    {
      isActiveArea: (areaId) =>
        orgTree.snapshot().some((area) => area.id === areaId && area.active),
      canViewPii: () => can('view_pii'),
      actorId: () => signedInAs ?? 'user-admin',
    },
    options.employees,
  );
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
      livePeople: (areaId) => staff.countLiveInArea(areaId),
      isMember: (subject) =>
        users.some((user) => user.id === `user-${subject}` && user.status === 'active'),
      actorId: () => signedInAs ?? 'user-admin',
    },
    ...(options.areas ? [options.areas] : []),
  );
  const paperwork: MockDocumentStore = createMockDocumentStore(options.documents, {
    isLiveOwner: (ownerType, ownerId) =>
      ownerType === 'vehicle'
        ? fleet.snapshot().some((vehicle) => vehicle.id === ownerId && vehicle.archivedAt === null)
        : demoEmployeeIds.includes(ownerId),
    actorId: () => signedInAs ?? 'user-admin',
  });
  const cover: MockInsuranceStore = createMockInsuranceStore(options.policies, {
    isLiveVehicle: (vehicleId) =>
      fleet.snapshot().some((vehicle) => vehicle.id === vehicleId && vehicle.archivedAt === null),
    canViewCosts: () =>
      roles.find((role) => role.id === currentUser()?.roleId)?.permissions.includes('view_costs') ??
      false,
    actorId: () => signedInAs ?? 'user-admin',
  });
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
    ...Array.from({ length: 23 }, (_, index) => {
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
  /** Whether the signed-in user's role grants `permission` (the role is looked up on every call). */
  function can(permission: Permission): boolean {
    const user = currentUser();
    return Boolean(
      user && roles.find((item) => item.id === user.roleId)?.permissions.includes(permission),
    );
  }
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
  const guarded: Guarded = <T>(
    operation: MockOperation,
    permission: Permission | readonly Permission[] | null,
    action: () => Result<T> | Promise<Result<T>>,
  ): Promise<Result<T>> => {
    const failed = injected(operation);
    if (failed) return Promise.resolve(failed);
    const user = currentUser();
    if (!user) return Promise.resolve(unauthorized());
    const required = permission === null ? [] : ([] as Permission[]).concat(permission);
    if (!required.every(can))
      return Promise.resolve(apiError(403, 'forbidden', 'Permission denied'));
    return Promise.resolve(action());
  };

  // Unknown, used, expired or mismatched invitations are indistinguishable.
  const invitationUnavailable = () => apiError(404, 'not_found', 'Resource not found');

  const session = {
    current: () => signedInAs,
    clear: () => {
      signedInAs = null;
    },
  };
  const controls = createControls(
    session,
    failures,
    users,
    drafts,
    fleet,
    orgTree,
    paperwork,
    cover,
    staff,
  );

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
    ...createAccessPorts(guarded, users, roles, invitations, roleName),
    ...createModulePorts(guarded, fleet, orgTree, paperwork, cover, staff),
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
