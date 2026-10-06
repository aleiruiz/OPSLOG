import type {
  ApiError,
  BffOidcCredentials,
  BffUser,
  BffUsersQuery,
  BffUserStatus,
  ISODateTime,
  Page,
  Permission,
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

export interface ApiPorts {
  readonly auth: AuthPort;
  readonly tenant: TenantAdminPort;
  readonly users: UsersPort;
  readonly roles: RolesPort;
  readonly drafts: DraftsPort;
  readonly oidc: OidcPort;
}
