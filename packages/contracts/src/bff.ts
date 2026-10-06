import type { ISODateTime, Page, Permission } from './index.js';

/**
 * Single source of truth for the HTTP surface between the web app and the BFF (`apps/api/bff`).
 * The BFF builds its routing table from `BFF_ROUTES` and types its responses with `BffRouteTypes`;
 * the web client (`apps/web/api`) derives every call from the same two. Anything that is not
 * declared here is not part of the contract, and a drift test (tests/integration/platform) fails
 * when the BFF and this module disagree.
 */

export const CSRF_HEADER = 'x-csrf-token';

export type BffMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** How a route is protected. `session-csrf` also requires the session-bound token on state changes. */
export type BffRouteKind = 'public' | 'pre-session' | 'session' | 'session-csrf';

/** Uniform error bodies: fixed texts, never anything from the request, a stack or a store. */
export const BFF_ERRORS = {
  bad_request: { status: 400, message: 'Invalid request' },
  unauthorized: { status: 401, message: 'Authentication required' },
  forbidden: { status: 403, message: 'Permission denied' },
  csrf_failed: { status: 403, message: 'Request rejected' },
  not_found: { status: 404, message: 'Resource not found' },
  method_not_allowed: { status: 405, message: 'Method not allowed' },
  conflict: { status: 409, message: 'Conflict' },
  last_admin: { status: 409, message: 'Conflict' },
  payload_too_large: { status: 413, message: 'Payload too large' },
  unsupported_media_type: { status: 415, message: 'Unsupported media type' },
  internal_error: { status: 500, message: 'Request failed' },
} as const;

export type BffErrorCode = keyof typeof BFF_ERRORS;

export interface BffErrorBody {
  readonly code: BffErrorCode;
  readonly status: number;
  readonly message: string;
  readonly correlationId: string;
}

export const isBffErrorBody = (value: unknown): value is BffErrorBody => {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<BffErrorBody>;
  return (
    typeof body.code === 'string' &&
    Object.hasOwn(BFF_ERRORS, body.code) &&
    typeof body.status === 'number' &&
    typeof body.message === 'string' &&
    typeof body.correlationId === 'string'
  );
};

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

/** Request and response types of every route. Keys are route ids. */
export interface BffRouteTypes {
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

export type BffRouteId = keyof BffRouteTypes;

export interface BffRouteDefinition {
  readonly method: BffMethod;
  /** Path segments; `:name` is a parameter segment. */
  readonly path: readonly string[];
  readonly kind: BffRouteKind;
  /** Status of the successful response. */
  readonly status: 200 | 201 | 204;
}

export const BFF_ROUTES = {
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
