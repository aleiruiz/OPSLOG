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
import type { BffRouteDefinition } from './bff/shared.js';

/**
 * Single source of truth for the HTTP surface between the web app and the BFF (`apps/api/bff`).
 * The BFF builds its routing table from `BFF_ROUTES` and types its responses with `BffRouteTypes`;
 * the web client (`apps/web/api`) derives every call from the same two. Anything that is not
 * declared here is not part of the contract, and a drift test (tests/integration/platform) fails
 * when the BFF and this module disagree.
 */

export { CSRF_HEADER, BFF_ERRORS, isBffErrorBody } from './bff/shared.js';
export type {
  BffMethod,
  BffRouteKind,
  BffErrorCode,
  BffErrorBody,
  BffRouteDefinition,
} from './bff/shared.js';
export type {
  BffMfaPolicy,
  BffUserStatus,
  BffUser,
  BffCsrfResponse,
  BffOidcCredentials,
  BffSession,
  BffInvitationPreview,
  BffSettings,
  BffSettingsInput,
  BffUsersQuery,
  BffInviteResponse,
  BffRole,
  BffDraft,
} from './bff/identity.js';
export { BFF_VEHICLE_STATUSES } from './bff/vehicles.js';
export type {
  BffVehicleStatus,
  BffVehicle,
  BffVehicleInput,
  BffVehiclePatch,
  BffVehiclesQuery,
  BffVehicleStatusEntry,
} from './bff/vehicles.js';
export { BFF_EMPLOYEE_KINDS, BFF_EMPLOYEE_STATUSES } from './bff/employees.js';
export type {
  BffEmployeeKind,
  BffEmployeeStatus,
  BffEmployeePiiPresent,
  BffFitnessReason,
  BffFitness,
  BffEmployee,
  BffEmployeePii,
  BffEmployeeDetail,
  BffEmployeeInput,
  BffEmployeePatch,
  BffEmployeesQuery,
  BffEmployeeHistoryEntry,
  BffEmployeeHistoryQuery,
} from './bff/employees.js';
export { BFF_DOCUMENT_OWNER_TYPES, BFF_DOCUMENT_STATUSES } from './bff/documents.js';
export type {
  BffDocumentOwnerType,
  BffDocumentStatus,
  BffDocumentRevisionStatus,
  BffDocument,
  BffDocumentInput,
  BffDocumentPatch,
  BffDocumentRenewal,
  BffDocumentsQuery,
  BffDocumentRevision,
  BffDocumentHistoryQuery,
} from './bff/documents.js';
export { BFF_COVERAGE_TYPES, BFF_POLICY_STATUSES } from './bff/insurance.js';
export type {
  BffCoverageType,
  BffPolicyStatus,
  BffPolicyRevisionStatus,
  BffDeductible,
  BffInsurancePolicy,
  BffInsurancePolicyInput,
  BffInsurancePolicyPatch,
  BffInsurancePolicyRenewal,
  BffInsurancePoliciesQuery,
  BffInsurancePolicyRevision,
  BffInsurancePolicyHistoryQuery,
} from './bff/insurance.js';
export { BFF_ASSIGNMENT_TYPES, BFF_ASSIGNMENT_STATUSES } from './bff/assignments.js';
export type {
  BffAssignmentType,
  BffAssignmentStatus,
  BffAssignmentEndKind,
  BffVehicleAssignment,
  BffVehicleAssignmentInput,
  BffVehicleAssignmentCreated,
  BffVehicleAssignmentEnd,
  BffVehicleAssignmentsQuery,
  BffVehicleAssignmentEvent,
  BffVehicleAssignmentHistoryQuery,
} from './bff/assignments.js';
export {
  BFF_IMPORT_ENTITIES,
  BFF_IMPORT_MODES,
  BFF_IMPORT_STATUSES,
  BFF_IMPORT_OUTCOMES,
  BFF_IMPORT_ROW_CODES,
  BFF_IMPORT_TEMPLATES,
  BFF_IMPORT_MAX_ROWS,
  BFF_IMPORT_MAX_BODY_BYTES,
} from './bff/imports.js';
export type {
  BffImportEntity,
  BffImportMode,
  BffImportStatus,
  BffImportOutcome,
  BffImportRowCode,
  BffImportInput,
  BffImportJob,
  BffImportSubmitted,
  BffImportRow,
  BffImportEvent,
  BffImportsQuery,
  BffImportRowsQuery,
  BffImportHistoryQuery,
} from './bff/imports.js';
export {
  BFF_ALERT_SOURCES,
  BFF_ALERT_SEVERITIES,
  BFF_ALERT_RECIPIENT_ROLES,
} from './bff/alerts.js';
export type {
  BffAlertSource,
  BffAlertSeverity,
  BffAlertRecipientRole,
  BffAlert,
  BffAlertsQuery,
  BffAlertPage,
  BffAlertSettings,
  BffAlertSettingsInput,
} from './bff/alerts.js';
export { BFF_AREA_ACTIONS, BFF_AREA_FIELDS } from './bff/areas.js';
export type {
  BffArea,
  BffAreaDetail,
  BffAreaInput,
  BffAreaPatch,
  BffAreasQuery,
  BffAreaAction,
  BffAreaField,
  BffAreaHistoryEntry,
  BffAreaHistoryQuery,
} from './bff/areas.js';

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
    AreasRouteTypes {}

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
