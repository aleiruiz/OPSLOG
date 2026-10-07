import type { ISODateTime, Page, Permission } from '../index.js';
import type { BffRouteDefinition } from './shared.js';

export type BffMfaPolicy = 'disabled' | 'optional' | 'required';
export type BffUserStatus = 'active' | 'invited' | 'inactive';

/** The browser never receives names or emails: identities are opaque ids. */
export interface BffUser {
  readonly id: string;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly status: BffUserStatus;
}

export interface BffCsrfResponse {
  readonly csrfToken: string;
}

/** OIDC authorization result obtained by the browser from the identity provider. */
export interface BffOidcCredentials {
  readonly code: string;
  readonly nonce: string;
}

export interface BffSession {
  readonly company: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string };
  readonly roleId: string;
  readonly roleLabel: string;
  readonly permissions: readonly Permission[];
  readonly expiresAt: ISODateTime;
  readonly csrfToken: string;
}

export interface BffInvitationPreview {
  readonly companyName: string;
  readonly roleLabel: string;
}

export interface BffSettings {
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly mfa: BffMfaPolicy;
  readonly sessionIdleHours: number;
}

export interface BffSettingsInput {
  readonly name: string;
  readonly mfa: BffMfaPolicy;
  readonly sessionIdleHours: number;
  /** Required by the server when a security setting changes. */
  readonly reason?: string;
}

export interface BffUsersQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly sort?: 'id' | 'roleLabel' | 'status';
  readonly direction?: 'asc' | 'desc';
  readonly search?: string;
}

export interface BffInviteResponse {
  readonly user: { readonly id: string; readonly roleId: string; readonly status: 'invited' };
  /** Delivery by email is not built yet: the administrator who invites receives the token. */
  readonly invitationToken: string;
  readonly expiresAt: ISODateTime;
}

export interface BffRole {
  readonly id: string;
  readonly name: string;
  readonly kind: 'system' | 'custom';
  readonly permissions: readonly Permission[];
  readonly memberCount: number;
}

export interface BffDraft {
  readonly scope: string;
  readonly values: Readonly<Record<string, string>>;
  readonly savedAt: ISODateTime;
}

/** Request and response types of the identity routes. */
export interface IdentityRouteTypes {
  'auth.csrf': { response: BffCsrfResponse };
  'auth.login': { body: BffOidcCredentials; response: BffSession };
  'auth.session': { response: BffSession };
  'auth.logout': { response: void };
  'auth.invitation.inspect': { body: { token: string }; response: BffInvitationPreview };
  'auth.invitation.accept': {
    body: BffOidcCredentials & { token: string };
    response: BffSession;
  };
  'company.settings.get': { response: BffSettings };
  'company.settings.update': { body: BffSettingsInput; response: BffSettings };
  'users.list': { query?: BffUsersQuery; response: Page<BffUser> };
  'users.invite': { body: { roleId: string }; response: BffInviteResponse };
  'users.deactivate': {
    params: { id: string };
    body: { reason: string };
    response: { id: string; status: 'inactive' };
  };
  'roles.list': { response: { items: readonly BffRole[] } };
  'roles.copy': { params: { id: string }; body: { name: string }; response: BffRole };
  'drafts.load': { params: { scope: string }; response: { draft: BffDraft | null } };
  'drafts.save': {
    params: { scope: string };
    body: { values: Readonly<Record<string, string>> };
    response: BffDraft;
  };
  'drafts.discard': { params: { scope: string }; response: void };
}

export const IDENTITY_ROUTES = {
  'auth.csrf': { method: 'GET', path: ['api', 'auth', 'csrf'], kind: 'public', status: 200 },
  'auth.login': {
    method: 'POST',
    path: ['api', 'auth', 'login'],
    kind: 'pre-session',
    status: 200,
  },
  'auth.session': {
    method: 'GET',
    path: ['api', 'auth', 'session'],
    kind: 'session',
    status: 200,
  },
  'auth.logout': {
    method: 'POST',
    path: ['api', 'auth', 'logout'],
    kind: 'session-csrf',
    status: 204,
  },
  'auth.invitation.inspect': {
    method: 'POST',
    path: ['api', 'auth', 'invitations', 'inspect'],
    kind: 'pre-session',
    status: 200,
  },
  'auth.invitation.accept': {
    method: 'POST',
    path: ['api', 'auth', 'invitations', 'accept'],
    kind: 'pre-session',
    status: 201,
  },
  'company.settings.get': {
    method: 'GET',
    path: ['api', 'company', 'settings'],
    kind: 'session',
    status: 200,
  },
  'company.settings.update': {
    method: 'PUT',
    path: ['api', 'company', 'settings'],
    kind: 'session-csrf',
    status: 200,
  },
  'users.list': { method: 'GET', path: ['api', 'users'], kind: 'session', status: 200 },
  'users.invite': {
    method: 'POST',
    path: ['api', 'users', 'invitations'],
    kind: 'session-csrf',
    status: 201,
  },
  'users.deactivate': {
    method: 'POST',
    path: ['api', 'users', ':id', 'deactivate'],
    kind: 'session-csrf',
    status: 200,
  },
  'roles.list': { method: 'GET', path: ['api', 'roles'], kind: 'session', status: 200 },
  'roles.copy': {
    method: 'POST',
    path: ['api', 'roles', ':id', 'copy'],
    kind: 'session-csrf',
    status: 201,
  },
  'drafts.load': {
    method: 'GET',
    path: ['api', 'drafts', ':scope'],
    kind: 'session',
    status: 200,
  },
  'drafts.save': {
    method: 'PUT',
    path: ['api', 'drafts', ':scope'],
    kind: 'session-csrf',
    status: 200,
  },
  'drafts.discard': {
    method: 'DELETE',
    path: ['api', 'drafts', ':scope'],
    kind: 'session-csrf',
    status: 204,
  },
} as const satisfies Record<keyof IdentityRouteTypes, BffRouteDefinition>;
