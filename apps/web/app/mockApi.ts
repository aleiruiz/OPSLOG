import type { ApiError, FieldError } from '@opslog/contracts';
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
} from './types';

/**
 * Contract-typed in-memory API used until the real BFF client exists. It models the BFF session as a
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
  | 'discardDraft';

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
}

export interface MockApi extends ApiPorts {
  readonly controls: MockControls;
}

export const demoCredentials = {
  admin: { email: 'admin@demo.opslog.test', password: 'demo-password-123' },
  viewer: { email: 'consulta@demo.opslog.test', password: 'demo-password-456' },
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
  { id: 'user-admin', name: 'Ana Prueba', email: demoCredentials.admin.email, role: 'role-admin' },
  {
    id: 'user-viewer',
    name: 'Luis Consulta',
    email: demoCredentials.viewer.email,
    role: 'role-viewer',
  },
  {
    id: 'user-dispatch',
    name: 'Diana Despacho',
    email: 'diana@demo.opslog.test',
    role: 'role-dispatch',
  },
] as const;

let correlation = 0;
function apiError(
  status: ApiError['status'],
  code: string,
  message: string,
  fieldErrors?: readonly FieldError[],
): Result<never> {
  correlation += 1;
  const error: ApiError = {
    code,
    status,
    message,
    correlationId: `corr-mock-${correlation}`,
    ...(fieldErrors ? { fieldErrors } : {}),
  };
  return { ok: false, error };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createMockApi(): MockApi {
  let signedInAs: string | null = null;
  const failures = new Map<MockOperation, ApiError['status']>();
  const drafts = new Map<string, DraftRecord>();
  let company: CompanySettings = {
    name: 'Transportes Demo SA',
    status: 'active',
    mfa: 'optional',
    sessionIdleHours: 8,
  };
  // Mock credential store (email -> password). Only active users may authenticate.
  const usedInvitations = new Set<string>();
  const credentials = new Map<string, string>(
    Object.values(demoCredentials).map((item) => [item.email, item.password]),
  );
  const roles: RoleSummary[] = systemRoles.map((role) => ({ ...role }));
  const users: UserSummary[] = [
    ...people.map((person) => ({
      id: person.id,
      displayName: person.name,
      email: person.email,
      roleId: person.role,
      roleLabel: roleName(person.role),
      status: 'active' as const,
    })),
    ...Array.from({ length: 24 }, (_, index) => {
      const n = String(index + 1).padStart(2, '0');
      return {
        id: `user-sintetico-${n}`,
        displayName: `Persona sintética ${n}`,
        email: `persona${n}@demo.opslog.test`,
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
      user: { id: user.id, displayName: user.displayName, email: user.email },
      roleLabel: role.name,
      permissions: role.permissions,
      expiresAt: '2026-10-06T20:00:00Z',
    };
  };
  const injected = (operation: MockOperation): Result<never> | null => {
    const status = failures.get(operation);
    if (status === undefined) return null;
    failures.delete(operation);
    return apiError(status, 'injected_failure', 'La operación falló de forma simulada.');
  };
  const draftKey = (scope: string) => `${signedInAs ?? ''}:${scope}`;
  const unauthorized = () =>
    apiError(401, 'session_expired', 'La sesión expiró. Inicia sesión de nuevo.');
  /** Runs `action` only for a live session holding `permission` (when given). */
  function guarded<T>(
    operation: MockOperation,
    permission: Permission | null,
    action: () => Result<T>,
  ): Promise<Result<T>> {
    const failed = injected(operation);
    if (failed) return Promise.resolve(failed);
    const user = currentUser();
    if (!user) return Promise.resolve(unauthorized());
    const role = roles.find((item) => item.id === user.roleId);
    if (permission && !role?.permissions.includes(permission))
      return Promise.resolve(apiError(403, 'forbidden', 'Tu rol no permite esta acción.'));
    return Promise.resolve(action());
  }

  const invitationUnavailable = () =>
    apiError(
      404,
      'invitation_unavailable',
      'La invitación no es válida, ya se usó o expiró. Pide una nueva a tu administrador.',
    );

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
  };

  return {
    controls,
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
        const email = input.email.trim().toLowerCase();
        const user = users.find((item) => item.email === email);
        const valid = credentials.has(email) && credentials.get(email) === input.password;
        if (!user || user.status !== 'active' || !valid)
          return Promise.resolve(
            apiError(401, 'invalid_credentials', 'El correo o la contraseña no son correctos.'),
          );
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
        if (token !== demoInvitations.valid) return Promise.resolve(invitationUnavailable());
        return Promise.resolve(
          ok({ companyName: company.name, roleLabel: roleName('role-fleet') }),
        );
      },
      acceptInvitation: (token, input) => {
        const failed = injected('acceptInvitation');
        if (failed) return Promise.resolve(failed);
        if (token !== demoInvitations.valid || usedInvitations.has(token))
          return Promise.resolve(invitationUnavailable());
        if (input.password.length < 12)
          return Promise.resolve(
            apiError(422, 'weak_password', 'La contraseña no cumple los requisitos.', [
              {
                field: 'password',
                code: 'too_short',
                message: 'Usa al menos 12 caracteres.',
              },
            ]),
          );
        const user: UserSummary = {
          id: 'user-invitada',
          displayName: input.displayName,
          email: 'invitada@demo.opslog.test',
          roleId: 'role-fleet',
          roleLabel: roleName('role-fleet'),
          status: 'active',
        };
        // Never replace an existing account.
        if (users.some((item) => item.email === user.email))
          return Promise.resolve(invitationUnavailable());
        users.push(user);
        usedInvitations.add(token);
        credentials.set(user.email, input.password);
        signedInAs = user.id;
        return Promise.resolve(ok(sessionFor(user.id)));
      },
    },
    tenant: {
      getCompanySettings: () => guarded('getCompanySettings', 'manage_config', () => ok(company)),
      updateCompanySettings: (input) =>
        guarded('updateCompanySettings', 'manage_config', () => {
          const fieldErrors: FieldError[] = [];
          if (!input.name.trim())
            fieldErrors.push({ field: 'name', code: 'required', message: 'Escribe el nombre.' });
          if (
            !Number.isInteger(input.sessionIdleHours) ||
            input.sessionIdleHours < 1 ||
            input.sessionIdleHours > 24
          )
            fieldErrors.push({
              field: 'sessionIdleHours',
              code: 'out_of_range',
              message: 'Elige entre 1 y 24 horas.',
            });
          if (fieldErrors.length)
            return apiError(400, 'invalid_input', 'Revisa los campos marcados.', fieldErrors);
          const securityChanged =
            input.mfa !== company.mfa || input.sessionIdleHours !== company.sessionIdleHours;
          if (securityChanged && !input.reason?.trim())
            return apiError(422, 'reason_required', 'Indica el motivo del cambio de seguridad.', [
              { field: 'reason', code: 'required', message: 'Indica el motivo.' },
            ]);
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
          const needle = (query.search ?? '').trim().toLowerCase();
          const matches = users.filter(
            (user) =>
              !needle ||
              user.displayName.toLowerCase().includes(needle) ||
              user.email.toLowerCase().includes(needle),
          );
          const limit = query.limit ?? 25;
          const offset = query.cursor ? Number(query.cursor) : 0;
          const items = matches.slice(offset, offset + limit);
          const next = offset + limit;
          const page: Page<UserSummary> = {
            items,
            nextCursor: next < matches.length ? String(next) : null,
            total: matches.length,
            sort: { field: 'displayName', direction: 'asc' },
          };
          return ok(page);
        }),
      inviteUser: (input) =>
        guarded('inviteUser', 'manage_users', () => {
          const email = input.email.trim().toLowerCase();
          if (!emailPattern.test(email))
            return apiError(400, 'invalid_input', 'Revisa los campos marcados.', [
              { field: 'email', code: 'invalid_email', message: 'Escribe un correo válido.' },
            ]);
          if (!roles.some((role) => role.id === input.roleId))
            return apiError(400, 'invalid_input', 'Revisa los campos marcados.', [
              { field: 'roleId', code: 'unknown_role', message: 'Elige un rol de la lista.' },
            ]);
          if (users.some((user) => user.email === email))
            return apiError(409, 'user_exists', 'Ya existe un usuario con ese correo.', [
              {
                field: 'email',
                code: 'duplicate',
                message: 'Ya existe un usuario con ese correo.',
              },
            ]);
          const invited: UserSummary = {
            id: `user-invitado-${users.length + 1}`,
            displayName: email,
            email,
            roleId: input.roleId,
            roleLabel: roleName(input.roleId),
            status: 'invited',
          };
          users.push(invited);
          return ok(invited);
        }),
      deactivateUser: (userId, reason) =>
        guarded('deactivateUser', 'manage_users', () => {
          const index = users.findIndex((user) => user.id === userId);
          const target = users[index];
          if (!target) return apiError(404, 'not_found', 'No encontramos al usuario.');
          if (target.id === signedInAs)
            return apiError(422, 'self_deactivation', 'No puedes desactivar tu propia cuenta.');
          if (!reason.trim())
            return apiError(400, 'invalid_input', 'Indica el motivo.', [
              { field: 'reason', code: 'required', message: 'Indica el motivo.' },
            ]);
          const updated: UserSummary = { ...target, status: 'inactive' };
          users[index] = updated;
          return ok(updated);
        }),
    },
    roles: {
      listRoles: () =>
        guarded('listRoles', 'manage_users', () => ok(roles.map((role) => ({ ...role })))),
      copyRole: (roleId, name) =>
        guarded('copyRole', 'manage_users', () => {
          const source = roles.find((role) => role.id === roleId);
          if (!source) return apiError(404, 'not_found', 'No encontramos el rol.');
          if (!name.trim())
            return apiError(400, 'invalid_input', 'Escribe un nombre.', [
              { field: 'name', code: 'required', message: 'Escribe un nombre.' },
            ]);
          if (roles.some((role) => role.name.toLowerCase() === name.trim().toLowerCase()))
            return apiError(409, 'role_exists', 'Ya existe un rol con ese nombre.', [
              { field: 'name', code: 'duplicate', message: 'Ya existe un rol con ese nombre.' },
            ]);
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
