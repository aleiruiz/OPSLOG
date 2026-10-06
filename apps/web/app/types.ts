import type { ApiError, ISODateTime, Page, PageQuery, Permission } from '@opslog/contracts';

export type { ApiError, ISODateTime, Page, PageQuery, Permission };

/** Outcome of every port call. Ports never throw for expected failures (401/403/422...). */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

export interface CompanyInfo {
  readonly id: string;
  readonly name: string;
}

/** What the BFF tells the browser about the current session. Never contains a token. */
export interface SessionInfo {
  readonly company: CompanyInfo;
  readonly user: { readonly id: string; readonly displayName: string; readonly email: string };
  readonly roleLabel: string;
  readonly permissions: readonly Permission[];
  readonly expiresAt: ISODateTime;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export interface InvitationPreview {
  readonly companyName: string;
  readonly roleLabel: string;
}

export interface AcceptInvitationInput {
  readonly displayName: string;
  readonly password: string;
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

export type UserStatus = 'active' | 'invited' | 'inactive';

export interface UserSummary {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly status: UserStatus;
}

export interface UserListQuery extends PageQuery {
  readonly search?: string | undefined;
}

export interface InviteUserInput {
  readonly email: string;
  readonly roleId: string;
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

/** Session and invitation flows, implemented later by the BFF (httpOnly cookie, no token in JS). */
export interface AuthPort {
  getSession(): Promise<Result<SessionInfo>>;
  login(input: LoginInput): Promise<Result<SessionInfo>>;
  logout(): Promise<Result<null>>;
  inspectInvitation(token: string): Promise<Result<InvitationPreview>>;
  acceptInvitation(token: string, input: AcceptInvitationInput): Promise<Result<SessionInfo>>;
}

export interface TenantAdminPort {
  getCompanySettings(): Promise<Result<CompanySettings>>;
  updateCompanySettings(input: UpdateCompanySettingsInput): Promise<Result<CompanySettings>>;
}

export interface UsersPort {
  listUsers(query: UserListQuery): Promise<Result<Page<UserSummary>>>;
  inviteUser(input: InviteUserInput): Promise<Result<UserSummary>>;
  deactivateUser(userId: string, reason: string): Promise<Result<UserSummary>>;
}

export interface RolesPort {
  listRoles(): Promise<Result<readonly RoleSummary[]>>;
  copyRole(roleId: string, name: string): Promise<Result<RoleSummary>>;
}

/** Drafts live on the server so an expired session or a closed tab never loses them. */
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
}
