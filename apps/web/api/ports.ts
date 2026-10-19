import {
  createAlertsClient,
  createAuditClient,
  createAreasClient,
  createAssignmentsClient,
  createBffClient,
  createDocumentsClient,
  createInsuranceClient,
  createEmployeesClient,
  createImportsClient,
  createVehiclesClient,
  type BffClient,
  type BffClientOptions,
  type BffSession,
} from '@opslog/contracts';
import type { ApiPorts, OidcPort, Result, SessionInfo } from '../app/types';
import { createIncidentPorts } from '../features/incidents/ports';
import { createMaintenancePorts } from '../features/maintenance/ports';
import { createDashboardPort } from '../features/dashboard/ports';
import { createSearchPorts } from '../features/search/ports';
import { createViewsPorts } from '../features/search/views/ports';

function mapResult<T, U>(result: Result<T>, map: (value: T) => U): Result<U> {
  return result.ok ? { ok: true, value: map(result.value) } : result;
}

/** The browser-facing session: the CSRF token stays inside the client. */
function toSession(session: BffSession): SessionInfo {
  return {
    company: session.company,
    user: session.user,
    roleId: session.roleId,
    roleLabel: session.roleLabel,
    permissions: session.permissions,
    expiresAt: session.expiresAt,
  };
}

/** `ApiPorts` over the real BFF. The identity provider is injected (fake locally, redirecting in production). */
export function createHttpApi(
  oidc: OidcPort,
  options: BffClientOptions = {},
  client: BffClient = createBffClient(options),
): ApiPorts {
  const { call } = client;
  const vehicles = createVehiclesClient(client);
  const areas = createAreasClient(client);
  const documents = createDocumentsClient(client);
  const insurance = createInsuranceClient(client);
  const employees = createEmployeesClient(client);
  const alerts = createAlertsClient(client);
  return {
    oidc,
    maintenance: createMaintenancePorts(client),
    incidents: createIncidentPorts(client),
    search: createSearchPorts(client),
    dashboard: createDashboardPort(client),
    views: createViewsPorts(client),
    auth: {
      getSession: async () => mapResult(await call('auth.session'), toSession),
      login: async (body) => mapResult(await call('auth.login', { body }), toSession),
      logout: async () => mapResult(await call('auth.logout'), () => null),
      inspectInvitation: (token) => call('auth.invitation.inspect', { body: { token } }),
      acceptInvitation: async (token, credentials) =>
        mapResult(
          await call('auth.invitation.accept', { body: { token, ...credentials } }),
          toSession,
        ),
    },
    tenant: {
      getCompanySettings: () => call('company.settings.get'),
      updateCompanySettings: ({ reason, ...rest }) =>
        call('company.settings.update', {
          body: { ...rest, ...(reason === undefined ? {} : { reason }) },
        }),
    },
    users: {
      listUsers: ({ search, ...query }) =>
        call('users.list', { query: { ...query, ...(search ? { search } : {}) } }),
      inviteUser: (body) => call('users.invite', { body }),
      deactivateUser: (id, reason) =>
        call('users.deactivate', { params: { id }, body: { reason } }),
    },
    roles: {
      listRoles: async () => mapResult(await call('roles.list'), (value) => value.items),
      copyRole: (id, name) => call('roles.copy', { params: { id }, body: { name } }),
    },
    drafts: {
      load: async (scope) =>
        mapResult(await call('drafts.load', { params: { scope } }), (value) => value.draft),
      save: (scope, values) => call('drafts.save', { params: { scope }, body: { values } }),
      discard: async (scope) =>
        mapResult(await call('drafts.discard', { params: { scope } }), () => null),
    },
    // Only what the screens use: status changes and history are in the contract but have no screen yet.
    vehicles: {
      list: vehicles.list,
      get: vehicles.get,
      create: vehicles.create,
      update: vehicles.update,
      recordOdometer: vehicles.recordOdometer,
      archive: vehicles.archive,
    },
    areas: {
      list: areas.list,
      get: areas.get,
      create: areas.create,
      update: areas.update,
      deactivate: areas.deactivate,
      activate: areas.activate,
      history: areas.history,
    },
    documents,
    insurance,
    employees: {
      list: employees.list,
      get: employees.get,
      create: employees.create,
      update: employees.update,
      changeStatus: employees.changeStatus,
      archive: employees.archive,
      history: employees.history,
    },
    alerts,
    audit: createAuditClient(client),
    assignments: createAssignmentsClient(client),
    imports: createImportsClient(client),
  };
}
