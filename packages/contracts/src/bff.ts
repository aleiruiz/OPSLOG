import type { IdentityRouteTypes } from './bff/identity.js';
import { IDENTITY_ROUTES } from './bff/identity.js';
import type { VehiclesRouteTypes } from './bff/vehicles.js';
import { VEHICLES_ROUTES } from './bff/vehicles.js';
import type { EmployeesRouteTypes } from './bff/employees.js';
import { EMPLOYEES_ROUTES } from './bff/employees.js';
import type { DocumentsRouteTypes } from './bff/documents.js';
import { DOCUMENTS_ROUTES } from './bff/documents.js';
import type { InsuranceRouteTypes } from './bff/insurance.js';
import { INSURANCE_ROUTES } from './bff/insurance.js';
import type { AssignmentsRouteTypes } from './bff/assignments.js';
import { ASSIGNMENTS_ROUTES } from './bff/assignments.js';
import type { ImportsRouteTypes } from './bff/imports.js';
import { IMPORTS_ROUTES } from './bff/imports.js';
import type { AlertsRouteTypes } from './bff/alerts.js';
import { ALERTS_ROUTES } from './bff/alerts.js';
import type { AreasRouteTypes } from './bff/areas.js';
import { AREAS_ROUTES } from './bff/areas.js';
import type { MaintenanceRouteTypes } from './bff/maintenance.js';
import { MAINTENANCE_ROUTES } from './bff/maintenance.js';
import type { WorkOrderRouteTypes } from './bff/work-orders.js';
import { WORK_ORDER_ROUTES } from './bff/work-orders.js';
import type { IncidentRouteTypes } from './bff/incidents.js';
import { INCIDENT_ROUTES } from './bff/incidents.js';
import type { IncidentChildRouteTypes } from './bff/incident-children.js';
import { INCIDENT_CHILD_ROUTES } from './bff/incident-children.js';
import type { IncidentCostRouteTypes } from './bff/incident-costs.js';
import { INCIDENT_COST_ROUTES } from './bff/incident-costs.js';
import type { IncidentSlaRouteTypes } from './bff/incident-sla.js';
import { INCIDENT_SLA_ROUTES } from './bff/incident-sla.js';
import type { IncidentWorkflowRouteTypes } from './bff/incident-workflow.js';
import { INCIDENT_WORKFLOW_ROUTES } from './bff/incident-workflow.js';
import type { AuditRouteTypes } from './bff/audit.js';
import { AUDIT_ROUTES } from './bff/audit.js';
import type { SearchRouteTypes } from './bff/search.js';
import { SEARCH_ROUTES } from './bff/search.js';
import type { BffRouteDefinition } from './bff/shared.js';

/**
 * Single source of truth for the HTTP surface between the web app and the BFF (`apps/api/bff`).
 * The BFF builds its routing table from `BFF_ROUTES` and types its responses with `BffRouteTypes`;
 * the web client (`apps/web/api`) derives every call from the same two. Anything that is not
 * declared here is not part of the contract, and a drift test (tests/integration/platform) fails
 * when the BFF and this module disagree.
 */

export * from './bff/exports.js';

/** Request and response types of every route. Keys are route ids. */
export interface BffRouteTypes
  extends IdentityRouteTypes,
    VehiclesRouteTypes,
    EmployeesRouteTypes,
    DocumentsRouteTypes,
    InsuranceRouteTypes,
    AssignmentsRouteTypes,
    ImportsRouteTypes,
    AlertsRouteTypes,
    AreasRouteTypes,
    MaintenanceRouteTypes,
    WorkOrderRouteTypes,
    IncidentRouteTypes,
    IncidentChildRouteTypes,
    IncidentWorkflowRouteTypes,
    IncidentCostRouteTypes,
    IncidentSlaRouteTypes,
    AuditRouteTypes,
    SearchRouteTypes {}

export type BffRouteId = keyof BffRouteTypes;

export const BFF_ROUTES = {
  ...IDENTITY_ROUTES,
  ...VEHICLES_ROUTES,
  ...EMPLOYEES_ROUTES,
  ...DOCUMENTS_ROUTES,
  ...INSURANCE_ROUTES,
  ...ASSIGNMENTS_ROUTES,
  ...IMPORTS_ROUTES,
  ...ALERTS_ROUTES,
  ...AREAS_ROUTES,
  ...MAINTENANCE_ROUTES,
  ...WORK_ORDER_ROUTES,
  ...INCIDENT_ROUTES,
  ...INCIDENT_CHILD_ROUTES,
  ...INCIDENT_WORKFLOW_ROUTES,
  ...INCIDENT_COST_ROUTES,
  ...INCIDENT_SLA_ROUTES,
  ...AUDIT_ROUTES,
  ...SEARCH_ROUTES,
} as const satisfies Record<BffRouteId, BffRouteDefinition>;

type Parts<K extends BffRouteId> = Omit<BffRouteTypes[K], 'response'>;

/** What a caller supplies for route `K`: path params, query and body, as the route declares them. */
export type BffCallInput<K extends BffRouteId> = { [P in keyof Parts<K>]: Parts<K>[P] };
export type BffCallArgs<K extends BffRouteId> =
  {} extends BffCallInput<K> ? [input?: BffCallInput<K>] : [input: BffCallInput<K>];
export type BffResponseOf<K extends BffRouteId> = BffRouteTypes[K]['response'];

export const bffRouteIds = Object.keys(BFF_ROUTES) as BffRouteId[];

/** Path of a route with its parameters encoded (and its query string, when given). */
export function bffPath(
  id: BffRouteId,
  params: Readonly<Record<string, string>> = {},
  query: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const path = BFF_ROUTES[id].path
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const value = params[segment.slice(1)];
      if (value === undefined || value === '') throw new Error(`Missing path parameter ${segment}`);
      return encodeURIComponent(value);
    })
    .join('/');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return `/${path}${text ? `?${text}` : ''}`;
}
