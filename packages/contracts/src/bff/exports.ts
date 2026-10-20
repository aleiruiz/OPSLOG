// Re-exports of the contract types by module, kept apart from the route table (`../bff.ts`).
export {
  CSRF_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  BFF_ERRORS,
  isBffErrorBody,
  isIdempotencyKey,
} from './shared.js';
export type {
  BffMethod,
  BffRouteKind,
  BffErrorCode,
  BffErrorBody,
  BffFieldError,
  BffRouteDefinition,
} from './shared.js';
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
} from './identity.js';
export { BFF_VEHICLE_STATUSES } from './vehicles.js';
export type {
  BffVehicleStatus,
  BffVehicle,
  BffVehicleInput,
  BffVehiclePatch,
  BffVehiclesQuery,
  BffVehicleStatusEntry,
} from './vehicles.js';
export { BFF_EMPLOYEE_KINDS, BFF_EMPLOYEE_STATUSES } from './employees.js';
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
} from './employees.js';
export { BFF_DOCUMENT_OWNER_TYPES, BFF_DOCUMENT_STATUSES } from './documents.js';
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
} from './documents.js';
export { BFF_COVERAGE_TYPES, BFF_POLICY_STATUSES } from './insurance.js';
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
} from './insurance.js';
export { BFF_ASSIGNMENT_TYPES, BFF_ASSIGNMENT_STATUSES } from './assignments.js';
export type {
  BffAssignmentType,
  BffAssignmentStatus,
  BffAssignmentEndKind,
  BffAssignmentActor,
  BffVehicleAssignment,
  BffVehicleAssignmentInput,
  BffVehicleAssignmentCreated,
  BffVehicleAssignmentEnd,
  BffVehicleAssignmentsQuery,
  BffVehicleAssignmentEvent,
  BffVehicleAssignmentHistoryQuery,
} from './assignments.js';
export {
  BFF_IMPORT_ENTITIES,
  BFF_IMPORT_MODES,
  BFF_IMPORT_STATUSES,
  BFF_IMPORT_OUTCOMES,
  BFF_IMPORT_ROW_CODES,
  BFF_IMPORT_TEMPLATES,
  BFF_IMPORT_MAX_ROWS,
  BFF_IMPORT_MAX_BODY_BYTES,
} from './imports.js';
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
} from './imports.js';
export {
  BFF_ALERT_SOURCES,
  BFF_ALERT_SEVERITIES,
  BFF_ALERT_RECIPIENT_ROLES,
  BFF_MAINTENANCE_EVIDENCE_REQUIREMENTS,
  BFF_INCIDENT_REPORT_PHOTO_MODES,
} from './alerts.js';
export type {
  BffAlertSource,
  BffAlertSeverity,
  BffAlertRecipientRole,
  BffAlert,
  BffAlertsQuery,
  BffAlertPage,
  BffAlertSettings,
  BffAlertSettingsInput,
  BffMaintenanceEvidenceRequirement,
  BffCloseCostThreshold,
  BffIncidentReportPhoto,
  BffIncidentSlaDays,
} from './alerts.js';
export { BFF_AREA_ACTIONS, BFF_AREA_FIELDS } from './areas.js';
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
} from './areas.js';
export type {
  BffMaintenanceAlert,
  BffMaintenanceAlertsQuery,
  BffMaintenancePlan,
  BffMaintenancePlanInput,
  BffMaintenancePlanPatch,
  BffMaintenancePlanOccurrence,
  BffScheduledMaintenanceOrder,
  BffMaintenancePlanSchedule,
  BffMaintenanceWorkshop,
  BffMaintenanceWorkshopInput,
  BffMaintenanceMechanic,
  BffMaintenanceMechanicInput,
} from './maintenance.js';
export type {
  BffMoney,
  BffWorkOrder,
  BffWorkOrderCommand,
  BffWorkOrderCost,
  BffWorkOrderCostsInput,
  BffWorkOrderPart,
  BffWorkOrderStatus,
  BffWorkOrderTransition,
  BffWorkOrderTransitionInput,
  BffWorkOrderWorkInput,
  BffWorkOrderFile,
  BffWorkOrderFileCommand,
  BffWorkOrderFileContent,
  BffWorkOrderFileKind,
  BffWorkOrderFileStatus,
  BffWorkOrderFileUpload,
} from './work-orders.js';
export {
  BFF_INCIDENT_STATUSES,
  BFF_INCIDENT_SEVERITIES,
  BFF_INCIDENT_TYPES,
  BFF_DAMAGE_ZONES,
  BFF_INCIDENT_SORT_FIELDS,
} from './incidents.js';
export type {
  BffIncidentStatus,
  BffIncidentSeverity,
  BffIncidentType,
  BffDamageZone,
  BffIncidentSortField,
  BffCoverageStatus,
  BffCoverageAlert,
  BffIncidentPerson,
  BffIncidentPolicy,
  BffIncidentLocation,
  BffIncidentDamage,
  BffIncidentField,
  BffIncident,
  BffIncidentInput,
  BffIncidentPatch,
  BffIncidentsQuery,
  BffIncidentSuggestionsQuery,
  BffIncidentTimelineEntry,
  BffIncidentSuggestions,
} from './incidents.js';
export {
  BFF_COST_KINDS,
  BFF_COST_MAX_LINES,
  BFF_EXPENSE_CATEGORIES,
  BFF_RECOVERY_CATEGORIES,
} from './incident-costs.js';
export type {
  BffCostCategory,
  BffCostKind,
  BffCostLine,
  BffCostLineInput,
  BffCostSnapshot,
  BffCurrencyTotals,
  BffIncidentCosts,
  BffIncidentCostsInput,
  BffPolicyDeductible,
  BffRepairLink,
  BffRepairLinkChange,
  BffRepairLinkInput,
  BffRepairLinkList,
  BffRepairOrder,
  BffRepairUnlink,
  BffRepairUnlinkInput,
} from './incident-costs.js';
export {
  BFF_INCIDENT_ALERT_KINDS,
  BFF_INCIDENT_ALERT_PAGE_SIZES,
  BFF_INCIDENT_SLA_STATES,
} from './incident-sla.js';
export type {
  BffIncidentAlert,
  BffIncidentAlertKind,
  BffIncidentAlertPage,
  BffIncidentAlertsQuery,
  BffIncidentSla,
  BffIncidentSlaPreviousCycle,
  BffIncidentSlaState,
} from './incident-sla.js';
export { BFF_INCIDENT_IDEMPOTENCY_REQUIRED_COMMANDS } from './incident-workflow.js';
export type {
  BffIncidentTransitionInput,
  BffIncidentNextStep,
  BffIncidentInsuranceInput,
  BffIncidentResolutionInput,
} from './incident-workflow.js';
export {
  BFF_THIRD_PARTY_KINDS,
  BFF_EVIDENCE_CATEGORIES,
  BFF_EVIDENCE_STAGES,
  BFF_EVIDENCE_MAX_BYTES,
  BFF_EVIDENCE_MAX_BODY_BYTES,
} from './incident-children.js';
export type {
  BffThirdPartyKind,
  BffEvidenceCategory,
  BffEvidenceStage,
  BffThirdParty,
  BffThirdPartyList,
  BffThirdPartyInput,
  BffThirdPartyPatch,
  BffThirdPartyChange,
  BffIncidentVersion,
  BffEvidenceFileStatus,
  BffIncidentEvidence,
  BffIncidentEvidenceChange,
  BffIncidentEvidenceUpload,
  BffIncidentEvidenceContent,
} from './incident-children.js';
export {
  BFF_IDEMPOTENCY_REQUIRED_COMMANDS,
  BFF_WORK_ORDER_FILE_KINDS,
  BFF_WORK_ORDER_FILE_MAX_BYTES,
  BFF_WORK_ORDER_FILE_MAX_BODY_BYTES,
} from './work-orders.js';

export { BFF_AUDIT_CHANGE_STATES, BFF_AUDIT_RESULTS } from './audit.js';
export type {
  BffAuditActorKind,
  BffAuditChange,
  BffAuditChangeState,
  BffAuditEntityQuery,
  BffAuditEntry,
  BffAuditPage,
  BffAuditPendingEvent,
  BffAuditQuery,
  BffAuditReconciliation,
  BffAuditReconciliationQuery,
  BffAuditResult,
} from './audit.js';
export { BFF_SEARCH_TYPES, BFF_SEARCH_PER_TYPE, BFF_SEARCH_MAX_TERM } from './search.js';
export type {
  BffSearchType,
  BffSearchHit,
  BffSearchGroup,
  BffSearchResult,
  BffSearchQuery,
} from './search.js';
export * from './analytics.js';
