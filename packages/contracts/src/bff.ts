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
  duplicate: { status: 409, message: 'Conflict' },
  stale_version: { status: 409, message: 'Conflict' },
  invalid_transition: { status: 409, message: 'Conflict' },
  immutable: { status: 409, message: 'Conflict' },
  area_in_use: { status: 409, message: 'Conflict' },
  odometer_decrease: { status: 422, message: 'Unprocessable request' },
  invalid_area: { status: 422, message: 'Unprocessable request' },
  invalid_hierarchy: { status: 422, message: 'Unprocessable request' },
  invalid_responsible: { status: 422, message: 'Unprocessable request' },
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
  /**
   * Only on `duplicate` (the unique field that collided), `area_in_use` (the kind of resource
   * that blocks: `sub_areas`, `vehicles` or `people`) and `invalid_area` (`area_id`); never a value
   * or a count.
   */
  readonly field?: string;
}

export const isBffErrorBody = (value: unknown): value is BffErrorBody => {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<BffErrorBody>;
  return (
    typeof body.code === 'string' &&
    Object.hasOwn(BFF_ERRORS, body.code) &&
    typeof body.status === 'number' &&
    typeof body.message === 'string' &&
    typeof body.correlationId === 'string' &&
    (body.field === undefined || typeof body.field === 'string')
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

export const BFF_VEHICLE_STATUSES = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
] as const;
export type BffVehicleStatus = (typeof BFF_VEHICLE_STATUSES)[number];

/** A fleet vehicle. The company is implicit (the session's); `version` is the concurrency token. */
export interface BffVehicle {
  readonly id: string;
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly status: BffVehicleStatus;
  readonly statusReason: string;
  readonly odometerKm: number;
  /** `YYYY-MM-DD`. */
  readonly registeredOn: string;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

export interface BffVehicleInput {
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin?: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly odometerKm: number;
  /** `YYYY-MM-DD`, not in the future; defaults to today. */
  readonly registeredOn?: string;
}

/** Fields that can be edited in place; at least one besides `version`. Status and odometer have their own commands. */
export interface BffVehiclePatch {
  readonly version: number;
  readonly economicNumber?: string;
  readonly plate?: string;
  readonly vin?: string | null;
  readonly make?: string;
  readonly model?: string;
  readonly year?: number;
  readonly areaId?: string;
}

export interface BffVehiclesQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly status?: BffVehicleStatus;
  readonly areaId?: string;
  /** `true` to include archived vehicles (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

export interface BffVehicleStatusEntry {
  readonly id: string;
  readonly from: BffVehicleStatus | null;
  readonly to: BffVehicleStatus;
  readonly reason: string;
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

/** An area of the company's organizational tree (up to four levels). The company is implicit. */
export interface BffArea {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  /** `null` for a root area. */
  readonly parentId: string | null;
  /** Level in the tree: 1 for a root, at most 4. */
  readonly depth: number;
  readonly active: boolean;
  /**
   * Responsible users as raw identity subjects (no `user-` prefix, unlike `BffAreaHistoryEntry.actorId`),
   * sorted. Names and emails never reach the browser.
   */
  readonly responsibleIds: readonly string[];
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly deactivatedAt: ISODateTime | null;
}

/** The single-area read adds the active resources that block its deactivation. */
export interface BffAreaDetail extends BffArea {
  readonly resourceCounts: { readonly vehicles: number; readonly people: number };
}

export interface BffAreaInput {
  readonly name: string;
  readonly code?: string | null;
  readonly parentId?: string | null;
  readonly responsibleIds?: readonly string[];
}

/** Fields that can be edited in place; at least one besides `version`. `parentId` moves the whole subtree. */
export interface BffAreaPatch {
  readonly version: number;
  readonly name?: string;
  readonly code?: string | null;
  readonly parentId?: string | null;
  readonly responsibleIds?: readonly string[];
}

export interface BffAreasQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  /** An area id for its direct children, `root` for the roots; omitted for every level. */
  readonly parentId?: string;
  /** `true` to include deactivated areas (default: hidden). */
  readonly includeInactive?: 'true' | 'false';
}

export const BFF_AREA_ACTIONS = ['created', 'updated', 'activated', 'deactivated'] as const;
export type BffAreaAction = (typeof BFF_AREA_ACTIONS)[number];
export const BFF_AREA_FIELDS = ['name', 'code', 'parent', 'responsibles'] as const;
export type BffAreaField = (typeof BFF_AREA_FIELDS)[number];

/**
 * Who changed what and when. Field names only: no names, codes or responsible ids. `actorId` is the
 * acting user's id with the `user-` prefix (`user-<subject>`); `BffArea.responsibleIds` are the raw
 * identity subjects without that prefix.
 */
export interface BffAreaHistoryEntry {
  readonly id: string;
  readonly action: BffAreaAction;
  readonly fields: readonly BffAreaField[];
  readonly fromParentId: string | null;
  readonly toParentId: string | null;
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

export interface BffAreaHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
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
  'vehicles.list': { query?: BffVehiclesQuery; response: Page<BffVehicle> };
  'vehicles.create': { body: BffVehicleInput; response: BffVehicle };
  'vehicles.get': { params: { id: string }; response: BffVehicle };
  'vehicles.update': { params: { id: string }; body: BffVehiclePatch; response: BffVehicle };
  'vehicles.status': {
    params: { id: string };
    body: { version: number; status: BffVehicleStatus; reason: string };
    response: BffVehicle;
  };
  'vehicles.odometer': {
    params: { id: string };
    body: { version: number; odometerKm: number };
    response: BffVehicle;
  };
  'vehicles.archive': { params: { id: string }; body: { version: number }; response: BffVehicle };
  'vehicles.history': {
    params: { id: string };
    response: { items: readonly BffVehicleStatusEntry[] };
  };
  'areas.list': { query?: BffAreasQuery; response: Page<BffArea> };
  'areas.create': { body: BffAreaInput; response: BffArea };
  'areas.get': { params: { id: string }; response: BffAreaDetail };
  'areas.update': { params: { id: string }; body: BffAreaPatch; response: BffArea };
  'areas.deactivate': { params: { id: string }; body: { version: number }; response: BffArea };
  'areas.activate': { params: { id: string }; body: { version: number }; response: BffArea };
  'areas.history': {
    params: { id: string };
    query?: BffAreaHistoryQuery;
    response: Page<BffAreaHistoryEntry>;
  };
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
  'vehicles.list': { method: 'GET', path: ['api', 'vehicles'], kind: 'session', status: 200 },
  'vehicles.create': {
    method: 'POST',
    path: ['api', 'vehicles'],
    kind: 'session-csrf',
    status: 201,
  },
  'vehicles.get': {
    method: 'GET',
    path: ['api', 'vehicles', ':id'],
    kind: 'session',
    status: 200,
  },
  'vehicles.update': {
    method: 'PUT',
    path: ['api', 'vehicles', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.status': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'status'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.odometer': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'odometer'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.archive': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.history': {
    method: 'GET',
    path: ['api', 'vehicles', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
  'areas.list': { method: 'GET', path: ['api', 'areas'], kind: 'session', status: 200 },
  'areas.create': {
    method: 'POST',
    path: ['api', 'areas'],
    kind: 'session-csrf',
    status: 201,
  },
  'areas.get': { method: 'GET', path: ['api', 'areas', ':id'], kind: 'session', status: 200 },
  'areas.update': {
    method: 'PUT',
    path: ['api', 'areas', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.deactivate': {
    method: 'POST',
    path: ['api', 'areas', ':id', 'deactivate'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.activate': {
    method: 'POST',
    path: ['api', 'areas', ':id', 'activate'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.history': {
    method: 'GET',
    path: ['api', 'areas', ':id', 'history'],
    kind: 'session',
    status: 200,
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
