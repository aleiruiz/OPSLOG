import type {
  AlertsClient,
  AssignmentsClient,
  ApiError,
  AreasClient,
  BffAlert,
  BffAlertPage,
  BffAlertRecipientRole,
  BffAlertSettings,
  BffAlertSettingsInput,
  BffAlertSeverity,
  BffAlertSource,
  BffAlertsQuery,
  BffAssignmentEndKind,
  BffAssignmentStatus,
  BffAssignmentType,
  BffArea,
  BffAreaDetail,
  BffAreaHistoryEntry,
  BffAreaHistoryQuery,
  BffAreaInput,
  BffAreaPatch,
  BffAreasQuery,
  BffCoverageType,
  BffDeductible,
  BffDocument,
  BffDocumentHistoryQuery,
  BffDocumentInput,
  BffDocumentOwnerType,
  BffDocumentPatch,
  BffDocumentRenewal,
  BffDocumentRevision,
  BffDocumentsQuery,
  BffDocumentStatus,
  BffInsurancePoliciesQuery,
  BffInsurancePolicy,
  BffInsurancePolicyHistoryQuery,
  BffInsurancePolicyInput,
  BffInsurancePolicyPatch,
  BffInsurancePolicyRenewal,
  BffInsurancePolicyRevision,
  BffPolicyStatus,
  BffEmployee,
  BffEmployeeDetail,
  BffEmployeeHistoryEntry,
  BffEmployeeHistoryQuery,
  BffEmployeeInput,
  BffEmployeeKind,
  BffEmployeePatch,
  BffEmployeeStatus,
  BffEmployeesQuery,
  BffImportEntity,
  BffImportEvent,
  BffImportHistoryQuery,
  BffImportInput,
  BffImportJob,
  BffImportMode,
  BffImportOutcome,
  BffImportRow,
  BffImportRowCode,
  BffImportRowsQuery,
  BffImportStatus,
  BffImportSubmitted,
  BffImportsQuery,
  BffFitness,
  BffFitnessReason,
  BffOidcCredentials,
  BffUser,
  BffUsersQuery,
  BffUserStatus,
  BffVehicle,
  BffVehicleAssignment,
  BffVehicleAssignmentCreated,
  BffVehicleAssignmentEnd,
  BffVehicleAssignmentEvent,
  BffVehicleAssignmentHistoryQuery,
  BffVehicleAssignmentInput,
  BffVehicleAssignmentsQuery,
  BffVehicleInput,
  BffVehiclePatch,
  BffVehicleStatus,
  BffVehiclesQuery,
  DocumentsClient,
  InsuranceClient,
  EmployeesClient,
  ImportsClient,
  ISODateTime,
  Page,
  Permission,
  VehiclesClient,
} from '@opslog/contracts';

export type { ApiError, ISODateTime, Page, Permission };

/** Outcome of every port call. Ports never throw for expected failures (401/403/422...). */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

export interface CompanyInfo {
  readonly id: string;
  readonly name: string;
}

/** What the BFF tells the browser about the current session. Never contains a token or a name. */
export interface SessionInfo {
  readonly company: CompanyInfo;
  readonly user: { readonly id: string };
  readonly roleId: string;
  readonly roleLabel: string;
  readonly permissions: readonly Permission[];
  readonly expiresAt: ISODateTime;
}

/** Result of the OIDC authorization the browser obtained from the identity provider. */
export type OidcCredentials = BffOidcCredentials;

export interface InvitationPreview {
  readonly companyName: string;
  readonly roleLabel: string;
}

export type MfaPolicy = 'disabled' | 'optional' | 'required';

export interface CompanySettings {
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly mfa: MfaPolicy;
  readonly sessionIdleHours: number;
}

export interface UpdateCompanySettingsInput {
  readonly name: string;
  readonly mfa: MfaPolicy;
  readonly sessionIdleHours: number;
  /** Required by the server when a security setting changes. */
  readonly reason?: string | undefined;
}

export type UserStatus = BffUserStatus;

/** Opaque identity: the BFF exposes neither names nor emails. */
export type UserSummary = BffUser;

export type UserListQuery = BffUsersQuery;

export interface InviteUserInput {
  readonly roleId: string;
}

/** The invitation the administrator hands over (email delivery is not built yet). */
export interface InvitationIssued {
  readonly user: { readonly id: string; readonly roleId: string; readonly status: 'invited' };
  readonly invitationToken: string;
  readonly expiresAt: ISODateTime;
}

export interface DeactivatedUser {
  readonly id: string;
  readonly status: 'inactive';
}

export interface RoleSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: 'system' | 'custom';
  readonly permissions: readonly Permission[];
  readonly memberCount: number;
}

export type DraftValues = Readonly<Record<string, string>>;

export interface DraftRecord {
  readonly scope: string;
  readonly values: DraftValues;
  readonly savedAt: ISODateTime;
}

/** Session and invitation flows of the BFF (httpOnly cookie, no token in JS). */
export interface AuthPort {
  getSession(): Promise<Result<SessionInfo>>;
  login(input: OidcCredentials): Promise<Result<SessionInfo>>;
  logout(): Promise<Result<null>>;
  inspectInvitation(token: string): Promise<Result<InvitationPreview>>;
  acceptInvitation(token: string, input: OidcCredentials): Promise<Result<SessionInfo>>;
}

/**
 * Identity provider as the browser sees it: it yields the authorization code and nonce that the BFF
 * verifies server side. A real provider redirects away and needs no hint; the fake used for local
 * work and UI tests asks which synthetic account to sign in as (`hintLabel`).
 */
export interface OidcPort {
  readonly hintLabel?: string | undefined;
  authorize(hint: string): Promise<Result<OidcCredentials>>;
}

export interface TenantAdminPort {
  getCompanySettings(): Promise<Result<CompanySettings>>;
  updateCompanySettings(input: UpdateCompanySettingsInput): Promise<Result<CompanySettings>>;
}

export interface UsersPort {
  listUsers(query: UserListQuery): Promise<Result<Page<UserSummary>>>;
  inviteUser(input: InviteUserInput): Promise<Result<InvitationIssued>>;
  deactivateUser(userId: string, reason: string): Promise<Result<DeactivatedUser>>;
}

export interface RolesPort {
  listRoles(): Promise<Result<readonly RoleSummary[]>>;
  copyRole(roleId: string, name: string): Promise<Result<RoleSummary>>;
}

/**
 * Drafts saved through this port survive an expired session and a closed tab. Edits that could not be
 * sent yet (session expired) exist only in page memory until the person signs in again; closing or
 * reloading the page before that loses them.
 */
export interface DraftsPort {
  load(scope: string): Promise<Result<DraftRecord | null>>;
  save(scope: string, values: DraftValues): Promise<Result<DraftRecord>>;
  discard(scope: string): Promise<Result<null>>;
}

export type Vehicle = BffVehicle;
export type VehicleStatus = BffVehicleStatus;
export type VehicleInput = BffVehicleInput;
export type VehiclePatch = BffVehiclePatch;
export type VehicleListQuery = BffVehiclesQuery;

/**
 * Vehicles over the generated BFF client. Every change carries the `version` of the last read: a lost
 * race comes back as a 409 `stale_version` value, a lower odometer as a 422 `odometer_decrease`, and
 * a repeated economic number, plate or VIN as a 409 `duplicate` with `fieldErrors`. Status changes and
 * history exist in the contract but have no screen yet, so the port does not expose them.
 */
export type VehiclesPort = Pick<
  VehiclesClient,
  'list' | 'get' | 'create' | 'update' | 'recordOdometer' | 'archive'
>;

export type Area = BffArea;
export type AreaDetail = BffAreaDetail;
export type AreaInput = BffAreaInput;
export type AreaPatch = BffAreaPatch;
export type AreaHistoryEntry = BffAreaHistoryEntry;
export type AreaListQuery = BffAreasQuery;
export type AreaHistoryQuery = BffAreaHistoryQuery;

/**
 * Areas over the generated BFF client. Moving an area is an `update` with a new `parentId`. Every change
 * carries the `version` of the last read (409 `stale_version`); deactivating an area that still holds
 * resources is a 409 `area_in_use` whose `fieldErrors[0].field` is `sub_areas`, `vehicles` or `people`; a
 * repeated name among siblings or a repeated code is a 409 `duplicate` naming `name` or `code`; a bad
 * placement (cycle, more than four levels, inactive parent) is a 422 `invalid_hierarchy`.
 */
export type AreasPort = AreasClient;

export type Document = BffDocument;
export type DocumentOwnerType = BffDocumentOwnerType;
export type DocumentStatus = BffDocumentStatus;
export type DocumentInput = BffDocumentInput;
export type DocumentPatch = BffDocumentPatch;
export type DocumentRenewal = BffDocumentRenewal;
export type DocumentRevision = BffDocumentRevision;
export type DocumentListQuery = BffDocumentsQuery;
export type DocumentHistoryQuery = BffDocumentHistoryQuery;

/**
 * Documents (metadata with an expiry date) over the generated BFF client. Every change carries the
 * `version` of the last read (409 `stale_version`); an archived document is read-only (409 `immutable`); an
 * owner that is unknown, of another company or archived is a 422 `invalid_owner` whose `fieldErrors[0].field` is
 * `owner_id`. Only the title and the notes are edited in place: correcting a date is a renewal.
 */
export type DocumentsPort = DocumentsClient;

export type InsurancePolicy = BffInsurancePolicy;
export type InsurancePolicyInput = BffInsurancePolicyInput;
export type InsurancePolicyPatch = BffInsurancePolicyPatch;
export type InsurancePolicyRenewal = BffInsurancePolicyRenewal;
export type InsurancePolicyRevision = BffInsurancePolicyRevision;
export type InsuranceListQuery = BffInsurancePoliciesQuery;
export type InsuranceHistoryQuery = BffInsurancePolicyHistoryQuery;
export type CoverageType = BffCoverageType;
export type PolicyStatus = BffPolicyStatus;
export type Deductible = BffDeductible;

/**
 * Vehicle insurance policies over the generated BFF client. Same concurrency and renewal model as documents; a
 * vehicle that is unknown, of another company or archived is a 422 `invalid_vehicle` (`vehicle_id`). The deductible
 * is financial data: without `view_costs` it comes back `null` (`hasDeductible` says whether one exists), and a
 * request that mentions `deductible` at all, a `null` included, is a 403.
 */
export type InsurancePort = InsuranceClient;
export type Employee = BffEmployee;
export type EmployeeDetail = BffEmployeeDetail;
export type EmployeeKind = BffEmployeeKind;
export type EmployeeStatus = BffEmployeeStatus;
export type EmployeeInput = BffEmployeeInput;
export type EmployeePatch = BffEmployeePatch;
export type EmployeeListQuery = BffEmployeesQuery;
export type EmployeeHistoryEntry = BffEmployeeHistoryEntry;
export type EmployeeHistoryQuery = BffEmployeeHistoryQuery;
export type Fitness = BffFitness;
export type FitnessReason = BffFitnessReason;

/**
 * Employees over the generated BFF client. Every change carries the `version` of the last read (409
 * `stale_version`); a repeated employee number, identification or e-mail is a 409 `duplicate` whose
 * `fieldErrors[0].field` is `employee_number`, `national_id` or `email`; an unknown, foreign or inactive
 * area is a 422 `invalid_area` (`area_id`). `get` returns the personal data (`pii`) only to a session
 * holding `view_pii` (and the server audits that disclosure); everyone else gets `pii: null`. Writing
 * personal data needs `view_pii` as well (403 otherwise). Terminated and archived employees are
 * read-only (409 `immutable`); a status change that the matrix does not allow is a 409 `invalid_transition`.
 */
export type EmployeesPort = EmployeesClient;

export type Alert = BffAlert;
export type AlertSource = BffAlertSource;
export type AlertSeverity = BffAlertSeverity;
export type AlertPage = BffAlertPage;
export type AlertListQuery = BffAlertsQuery;
export type AlertSettings = BffAlertSettings;
export type AlertSettingsInput = BffAlertSettingsInput;
export type AlertRecipientRole = BffAlertRecipientRole;

/**
 * Expiry alerts and their settings over the generated BFF client. Alerts are derived by the server on every read from
 * the company's vehicle documents and insurance policies (never stored): `list` needs `view`. The settings (expiry
 * window and recipient roles) are read with `view`; `saveSettings` needs `manage_config` (403 otherwise) and carries
 * the `version` of the last read (0 while the company has never saved): a lost race is a 409 `stale_version`, and
 * invalid input a uniform 400.
 */
export type AlertsPort = AlertsClient;

export type VehicleAssignment = BffVehicleAssignment;
export type AssignmentType = BffAssignmentType;
export type AssignmentStatus = BffAssignmentStatus;
export type AssignmentEndKind = BffAssignmentEndKind;
export type AssignmentInput = BffVehicleAssignmentInput;
export type AssignmentCreated = BffVehicleAssignmentCreated;
export type AssignmentEnd = BffVehicleAssignmentEnd;
export type AssignmentEvent = BffVehicleAssignmentEvent;
export type AssignmentListQuery = BffVehicleAssignmentsQuery;
export type AssignmentHistoryQuery = BffVehicleAssignmentHistoryQuery;
/** Assignments are closed, never edited or deleted; conflicts and permissions are enforced by the BFF. */
export type AssignmentsPort = AssignmentsClient;

export type ImportEntity = BffImportEntity;
export type ImportMode = BffImportMode;
export type ImportStatus = BffImportStatus;
export type ImportOutcome = BffImportOutcome;
export type ImportRowCode = BffImportRowCode;
export type ImportInput = BffImportInput;
export type ImportJob = BffImportJob;
export type ImportSubmitted = BffImportSubmitted;
export type ImportRow = BffImportRow;
export type ImportEvent = BffImportEvent;
export type ImportListQuery = BffImportsQuery;
export type ImportRowsQuery = BffImportRowsQuery;
export type ImportHistoryQuery = BffImportHistoryQuery;
/** Reports contain row numbers/codes/columns only; employee PII requires view_pii server-side. */
export type ImportsPort = ImportsClient;

export interface ApiPorts {
  readonly auth: AuthPort;
  readonly tenant: TenantAdminPort;
  readonly users: UsersPort;
  readonly roles: RolesPort;
  readonly drafts: DraftsPort;
  readonly vehicles: VehiclesPort;
  readonly areas: AreasPort;
  readonly documents: DocumentsPort;
  readonly insurance: InsurancePort;
  readonly employees: EmployeesPort;
  readonly alerts: AlertsPort;
  readonly assignments: AssignmentsPort;
  readonly imports: ImportsPort;
  readonly oidc: OidcPort;
}
