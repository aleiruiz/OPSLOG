import type {
  ApiError,
  AreasClient,
  BffArea,
  BffAreaDetail,
  BffAreaHistoryEntry,
  BffAreaHistoryQuery,
  BffAreaInput,
  BffAreaPatch,
  BffAreasQuery,
  BffEmployee,
  BffEmployeeDetail,
  BffEmployeeHistoryEntry,
  BffEmployeeHistoryQuery,
  BffEmployeeInput,
  BffEmployeeKind,
  BffEmployeePatch,
  BffEmployeeStatus,
  BffEmployeesQuery,
  BffFitness,
  BffFitnessReason,
  BffOidcCredentials,
  BffUser,
  BffUsersQuery,
  BffUserStatus,
  BffVehicle,
  BffVehicleInput,
  BffVehiclePatch,
  BffVehicleStatus,
  BffVehiclesQuery,
  EmployeesClient,
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

export interface ApiPorts {
  readonly auth: AuthPort;
  readonly tenant: TenantAdminPort;
  readonly users: UsersPort;
  readonly roles: RolesPort;
  readonly drafts: DraftsPort;
  readonly vehicles: VehiclesPort;
  readonly areas: AreasPort;
  readonly employees: EmployeesPort;
  readonly oidc: OidcPort;
}
