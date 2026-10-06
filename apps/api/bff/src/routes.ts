import {
  BFF_ROUTES,
  BFF_ASSIGNMENT_STATUSES,
  BFF_ASSIGNMENT_TYPES,
  BFF_DOCUMENT_OWNER_TYPES,
  BFF_DOCUMENT_STATUSES,
  BFF_COVERAGE_TYPES,
  BFF_EMPLOYEE_KINDS,
  BFF_EMPLOYEE_STATUSES,
  BFF_IMPORT_ENTITIES,
  BFF_IMPORT_OUTCOMES,
  BFF_IMPORT_STATUSES,
  BFF_POLICY_STATUSES,
  BFF_VEHICLE_STATUSES,
  type BffArea,
  type BffRouteDefinition,
  type BffAreaDetail,
  type BffAssignmentStatus,
  type BffAssignmentType,
  type BffVehicleAssignment,
  type BffVehicleAssignmentEvent,
  type BffAreaHistoryEntry,
  type BffCsrfResponse,
  type BffDocument,
  type BffDocumentOwnerType,
  type BffDocumentRevision,
  type BffDocumentStatus,
  type BffCoverageType,
  type BffEmployee,
  type BffEmployeeDetail,
  type BffEmployeeHistoryEntry,
  type BffInsurancePolicy,
  type BffInsurancePolicyRevision,
  type BffPolicyStatus,
  type BffEmployeeKind,
  type BffEmployeeStatus,
  type BffImportEntity,
  type BffImportEvent,
  type BffImportJob,
  type BffImportOutcome,
  type BffImportRow,
  type BffImportStatus,
  type BffResponseOf,
  type BffRouteId,
  type BffRouteKind,
  type BffSession,
  type BffUser,
  type BffVehicle,
  type BffVehicleStatus,
  type Page,
} from '../../../../packages/contracts/src/index.js';
import type {
  AreaDetailView,
  AreaView,
  AssignmentView,
  DocumentView,
  EmployeeDetailView,
  EmployeeView,
  ImportJobView,
  PolicyView,
  MemberView,
  Platform,
  PlatformResponse,
  RoleName,
  SessionDetails,
  VehicleView,
} from '../../composition/src/index.js';
import { parseObject, text } from './body.js';
import {
  clearPreCsrfCookie,
  clearSessionCookie,
  preCsrfCookie,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
  parseCookies,
} from './cookies.js';
import type { BffCrypto } from './csrf.js';
import { errorResponse, respond, singleHeader, type BffResponse, type ErrorCode } from './http.js';

/** How a route is protected. Declared once, in the contract module. */
export type RouteKind = BffRouteKind;

export interface RouteContext {
  readonly platform: Platform;
  readonly crypto: BffCrypto;
  readonly now: () => Date;
  readonly correlationId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Uint8Array;
  /** Opaque session token from the cookie (server side only), when the route is authenticated. */
  readonly token: string | null;
  /** Session facts established by the pipeline before the handler runs (session routes). */
  readonly session: SessionDetails | null;
  /** Cookies to emit with the response. */
  readonly cookies: string[];
}

/** Method, path and protection come from the contract; only parameter patterns and the handler live here. */
export interface Route {
  readonly id: BffRouteId;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: readonly string[];
  readonly kind: RouteKind;
  /** Body limit of this route when it needs more than the handler's default. */
  readonly maxBodyBytes?: number;
  readonly params?: Readonly<Record<string, RegExp>>;
  readonly handle: (ctx: RouteContext) => Promise<BffResponse>;
}

function route(
  id: BffRouteId,
  handle: Route['handle'],
  params?: Readonly<Record<string, RegExp>>,
): Route {
  const definition: BffRouteDefinition = BFF_ROUTES[id];
  const { method, path, kind, maxBodyBytes } = definition;
  return {
    id,
    method,
    path,
    kind,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    ...(params ? { params } : {}),
    handle,
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const PRE_CSRF_MAX_AGE = 3600;

/** Maps a composition failure to a uniform error. Unknown codes are internal errors, never echoed. */
function failure(
  ctx: RouteContext,
  error: { code: string; field?: string } | undefined,
): BffResponse {
  const map: Readonly<Record<string, ErrorCode>> = {
    invalid_input: 'bad_request',
    unauthorized: 'unauthorized',
    forbidden: 'forbidden',
    not_found: 'not_found',
    conflict: 'conflict',
    last_admin: 'last_admin',
    duplicate: 'duplicate',
    stale_version: 'stale_version',
    invalid_transition: 'invalid_transition',
    immutable: 'immutable',
    odometer_decrease: 'odometer_decrease',
    invalid_area: 'invalid_area',
    invalid_owner: 'invalid_owner',
    invalid_vehicle: 'invalid_vehicle',
    invalid_employee: 'invalid_employee',
    principal_taken: 'principal_taken',
    already_assigned: 'already_assigned',
    area_in_use: 'area_in_use',
    invalid_hierarchy: 'invalid_hierarchy',
    invalid_responsible: 'invalid_responsible',
  };
  const code = map[error?.code ?? ''] ?? 'internal_error';
  return errorResponse(
    code,
    ctx.correlationId,
    {},
    code === 'duplicate' ||
      code === 'area_in_use' ||
      code === 'invalid_area' ||
      code === 'invalid_owner' ||
      code === 'invalid_vehicle' ||
      code === 'invalid_employee' ||
      code === 'principal_taken' ||
      code === 'already_assigned'
      ? error?.field
      : undefined,
  );
}

/** A successful response typed by the contract, with the status the contract declares. */
function success<K extends BffRouteId>(
  ctx: RouteContext,
  id: K,
  body: BffResponseOf<K>,
): BffResponse {
  return respond(BFF_ROUTES[id].status, body, ctx.correlationId);
}

function reply<K extends BffRouteId, T>(
  ctx: RouteContext,
  id: K,
  result: PlatformResponse<T>,
  shape: (value: T) => BffResponseOf<K>,
): BffResponse {
  if (!result.ok || result.value === undefined) return failure(ctx, result.error);
  return success(ctx, id, shape(result.value));
}

const iso = (date: Date): string => date.toISOString();

function sessionBody(ctx: RouteContext, details: SessionDetails, token: string): BffSession {
  return {
    company: { id: details.tenantId, name: details.companyName },
    user: { id: details.identityId },
    roleId: details.roleId,
    roleLabel: details.roleLabel,
    permissions: details.permissions,
    expiresAt: iso(details.expiresAt),
    csrfToken: ctx.crypto.sessionToken(token),
  };
}

/** Parses a strict body; any malformed or unexpected property is a uniform 400. */
function body(
  ctx: RouteContext,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> | null {
  try {
    return parseObject(ctx.body, allowed, required);
  } catch {
    return null;
  }
}

const bad = (ctx: RouteContext): BffResponse => errorResponse('bad_request', ctx.correlationId);

/**
 * Opens a session for a verified principal: replaces any session the browser still holds (no fixation,
 * no accumulation), sets the httpOnly cookie and returns the session facts plus the CSRF token.
 */
async function openSession(
  ctx: RouteContext,
  principal: unknown,
  id: 'auth.login' | 'auth.invitation.accept',
): Promise<BffResponse> {
  const login = await ctx.platform.signIn(principal);
  if (!login.ok || !login.value) {
    // Every login failure is the same 401; only infrastructure failures differ.
    return login.error?.code === 'internal_error'
      ? failure(ctx, login.error)
      : errorResponse('unauthorized', ctx.correlationId);
  }
  const { token, expiresAt } = login.value;
  const details = await ctx.platform.sessionDetails(token, ctx.correlationId);
  if (!details.ok || !details.value) {
    await ctx.platform.signOut(token);
    return errorResponse('unauthorized', ctx.correlationId);
  }
  const previous = readCookie(parseCookies(cookieHeader(ctx)), SESSION_COOKIE);
  if (previous !== null && previous !== token) await ctx.platform.signOut(previous);
  const maxAge = (expiresAt.getTime() - ctx.now().getTime()) / 1000;
  ctx.cookies.push(sessionCookie(token, maxAge), clearPreCsrfCookie());
  return success(ctx, id, sessionBody(ctx, details.value, token));
}

function cookieHeader(ctx: RouteContext): string | undefined {
  // Through `singleHeader`: Node's adapter delivers every header as an array.
  return singleHeader(ctx.headers, 'cookie');
}

const SORT_FIELDS = ['id', 'roleLabel', 'status'] as const;
type SortField = (typeof SORT_FIELDS)[number];
const LIMITS = [25, 50, 100] as const;

interface UserCursor {
  readonly t: string;
  readonly o: number;
  readonly s: SortField;
  readonly d: 'asc' | 'desc';
  readonly q: string;
}

function isUserCursor(value: unknown): value is UserCursor {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<UserCursor>;
  return (
    typeof c.t === 'string' &&
    Number.isSafeInteger(c.o) &&
    (c.o as number) >= 0 &&
    SORT_FIELDS.includes(c.s as SortField) &&
    (c.d === 'asc' || c.d === 'desc') &&
    typeof c.q === 'string'
  );
}

function listUsers(ctx: RouteContext, members: readonly MemberView[], tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'sort', 'direction', 'search']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const sort = (ctx.query.get('sort') ?? 'id') as SortField;
  const direction = ctx.query.get('direction') ?? 'asc';
  const search = (ctx.query.get('search') ?? '').trim().toLowerCase();
  const cursorRaw = ctx.query.get('cursor');
  if (
    limit === undefined ||
    !SORT_FIELDS.includes(sort) ||
    (direction !== 'asc' && direction !== 'desc') ||
    search.length > 100
  )
    return null;
  let offset = 0;
  if (cursorRaw !== null) {
    // Cursors are signed and bound to tenant and query: another tenant's cursor is just invalid.
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (
      !isUserCursor(opened) ||
      opened.t !== tenantId ||
      opened.s !== sort ||
      opened.d !== direction ||
      opened.q !== search
    )
      return null;
    offset = opened.o;
  }
  const filtered = members.filter(
    (member) =>
      !search ||
      member.id.toLowerCase().includes(search) ||
      member.roleLabel.toLowerCase().includes(search) ||
      member.status === search,
  );
  const sign = direction === 'asc' ? 1 : -1;
  const sorted = [...filtered].sort(
    (a, b) => sign * a[sort].localeCompare(b[sort]) || a.id.localeCompare(b.id),
  );
  const items = sorted.slice(offset, offset + limit);
  const next = offset + limit < sorted.length ? offset + limit : null;
  const page: Page<BffUser> = {
    items,
    nextCursor:
      next === null
        ? null
        : ctx.crypto.signCursor({ t: tenantId, o: next, s: sort, d: direction, q: search }),
    total: sorted.length,
    sort: { field: sort, direction },
  };
  return page;
}

const SETTINGS_KEYS = ['name', 'mfa', 'sessionIdleHours', 'reason'] as const;

const VEHICLE_CREATE_KEYS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
  'odometerKm',
  'registeredOn',
] as const;
const VEHICLE_CREATE_REQUIRED = [
  'economicNumber',
  'plate',
  'make',
  'model',
  'year',
  'areaId',
  'odometerKm',
] as const;
const VEHICLE_PATCH_KEYS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
] as const;

const vehicleBody = (view: VehicleView): BffVehicle => ({ ...view });

/** Position of a signed list cursor: tenant, offset and the filter it was issued for. */
interface OffsetCursor {
  readonly t: string;
  readonly o: number;
  readonly q: string;
}

function isOffsetCursor(value: unknown): value is OffsetCursor {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<OffsetCursor>;
  return (
    typeof c.t === 'string' &&
    Number.isSafeInteger(c.o) &&
    (c.o as number) >= 0 &&
    typeof c.q === 'string'
  );
}

/** Strict query of the vehicle listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function vehicleQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'status', 'areaId', 'includeArchived']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const status = ctx.query.get('status');
  const areaId = ctx.query.get('areaId');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (status !== null && !(BFF_VEHICLE_STATUSES as readonly string[]).includes(status)) ||
    (areaId !== null && !ID.test(areaId)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([status, areaId, archived === 'true', limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      includeArchived: archived === 'true',
      ...(status === null ? {} : { status: status as BffVehicleStatus }),
      ...(areaId === null ? {} : { areaId }),
    },
  };
}

const AREA_KEYS = ['name', 'code', 'parentId', 'responsibleIds'] as const;

const areaBody = (view: AreaView): BffArea => ({ ...view });
const areaDetailBody = (view: AreaDetailView): BffAreaDetail => ({ ...view });

/** Strict query of the area listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function areaQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'parentId', 'includeInactive']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const parentId = ctx.query.get('parentId');
  const inactive = ctx.query.get('includeInactive');
  if (
    limit === undefined ||
    (parentId !== null && !ID.test(parentId)) ||
    (inactive !== null && inactive !== 'true' && inactive !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([parentId, inactive === 'true', limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      includeInactive: inactive === 'true',
      // `root` is the literal for "no parent": the roots of the tree.
      ...(parentId === null ? {} : { parentId: parentId === 'root' ? null : parentId }),
    },
  };
}

/** Strict query of the area history: only `limit` and a signed cursor bound to the tenant and the area. */
function areaHistoryQuery(ctx: RouteContext, tenantId: string, areaId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify([areaId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

const EMPLOYEE_KEYS = [
  'firstName',
  'lastName',
  'areaId',
  'employeeNumber',
  'position',
  'hireDate',
  'idType',
  'nationalId',
  'phone',
  'email',
  'licenseNumber',
  'licenseType',
  'licenseExpiresOn',
] as const;

const employeeBody = (view: EmployeeView): BffEmployee => ({ ...view });
const employeeDetailBody = (view: EmployeeDetailView): BffEmployeeDetail => ({ ...view });

/** Strict query of the employee listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function employeeQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'kind', 'status', 'areaId', 'includeArchived']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const kind = ctx.query.get('kind');
  const status = ctx.query.get('status');
  const areaId = ctx.query.get('areaId');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (kind !== null && !(BFF_EMPLOYEE_KINDS as readonly string[]).includes(kind)) ||
    (status !== null && !(BFF_EMPLOYEE_STATUSES as readonly string[]).includes(status)) ||
    (areaId !== null && !ID.test(areaId)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([kind, status, areaId, archived === 'true', limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      includeArchived: archived === 'true',
      ...(kind === null ? {} : { kind: kind as BffEmployeeKind }),
      ...(status === null ? {} : { status: status as BffEmployeeStatus }),
      ...(areaId === null ? {} : { areaId }),
    },
  };
}

/** Strict query of the employee history: only `limit` and a signed cursor bound to the tenant and the employee. */
function employeeHistoryQuery(ctx: RouteContext, tenantId: string, employeeId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['employee', employeeId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

const DOCUMENT_TYPE_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const DOCUMENT_VALIDITY_KEYS = ['issuedOn', 'expiresOn', 'documentNumber'] as const;

const documentBody = (view: DocumentView): BffDocument => ({ ...view });

/** Strict query of the document listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function documentQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set([
    'limit',
    'cursor',
    'ownerType',
    'ownerId',
    'typeCode',
    'status',
    'includeArchived',
  ]);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const ownerType = ctx.query.get('ownerType');
  const ownerId = ctx.query.get('ownerId');
  const typeCode = ctx.query.get('typeCode');
  const status = ctx.query.get('status');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (ownerType !== null && !(BFF_DOCUMENT_OWNER_TYPES as readonly string[]).includes(ownerType)) ||
    (ownerId !== null && (ownerType === null || !ID.test(ownerId))) ||
    (typeCode !== null && !DOCUMENT_TYPE_CODE.test(typeCode)) ||
    (status !== null && !(BFF_DOCUMENT_STATUSES as readonly string[]).includes(status)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([ownerType, ownerId, typeCode, status, archived === 'true', limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      includeArchived: archived === 'true',
      ...(ownerType === null ? {} : { ownerType: ownerType as BffDocumentOwnerType }),
      ...(ownerId === null ? {} : { ownerId }),
      ...(typeCode === null ? {} : { typeCode }),
      ...(status === null ? {} : { status: status as BffDocumentStatus }),
    },
  };
}

/** Strict query of the document history: only `limit` and a signed cursor bound to the tenant and the document. */
function documentHistoryQuery(ctx: RouteContext, tenantId: string, documentId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['document', documentId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const POLICY_RENEWAL_KEYS = [
  'version',
  'startsOn',
  'endsOn',
  'policyNumber',
  'coverageType',
  'deductible',
] as const;

const policyBody = (view: PolicyView): BffInsurancePolicy => ({ ...view });

/** Strict query of the policy listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function policyQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set([
    'limit',
    'cursor',
    'vehicleId',
    'coverageType',
    'status',
    'coversOn',
    'includeArchived',
  ]);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const vehicleId = ctx.query.get('vehicleId');
  const coverageType = ctx.query.get('coverageType');
  const status = ctx.query.get('status');
  const coversOn = ctx.query.get('coversOn');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (vehicleId !== null && !ID.test(vehicleId)) ||
    (coverageType !== null && !(BFF_COVERAGE_TYPES as readonly string[]).includes(coverageType)) ||
    (status !== null && !(BFF_POLICY_STATUSES as readonly string[]).includes(status)) ||
    (coversOn !== null && !ISO_DAY.test(coversOn)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([
    vehicleId,
    coverageType,
    status,
    coversOn,
    archived === 'true',
    limit,
  ]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      includeArchived: archived === 'true',
      ...(vehicleId === null ? {} : { vehicleId }),
      ...(coverageType === null ? {} : { coverageType: coverageType as BffCoverageType }),
      ...(status === null ? {} : { status: status as BffPolicyStatus }),
      ...(coversOn === null ? {} : { coversOn }),
    },
  };
}

/** Strict query of the policy history: only `limit` and a signed cursor bound to the tenant and the policy. */
function policyHistoryQuery(ctx: RouteContext, tenantId: string, policyId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['policy', policyId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

const assignmentBody = (view: AssignmentView): BffVehicleAssignment => ({ ...view });

/** Strict query of the assignment listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function assignmentQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'vehicleId', 'employeeId', 'type', 'status']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const vehicleId = ctx.query.get('vehicleId');
  const employeeId = ctx.query.get('employeeId');
  const type = ctx.query.get('type');
  const status = ctx.query.get('status');
  if (
    limit === undefined ||
    (vehicleId !== null && !ID.test(vehicleId)) ||
    (employeeId !== null && !ID.test(employeeId)) ||
    (type !== null && !(BFF_ASSIGNMENT_TYPES as readonly string[]).includes(type)) ||
    (status !== null && !(BFF_ASSIGNMENT_STATUSES as readonly string[]).includes(status))
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([vehicleId, employeeId, type, status, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      ...(vehicleId === null ? {} : { vehicleId }),
      ...(employeeId === null ? {} : { employeeId }),
      ...(type === null ? {} : { type: type as BffAssignmentType }),
      ...(status === null ? {} : { status: status as BffAssignmentStatus }),
    },
  };
}

/** Strict query of the assignment history: only `limit` and a signed cursor bound to the tenant and the assignment. */
function assignmentHistoryQuery(ctx: RouteContext, tenantId: string, assignmentId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['assignment', assignmentId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

const importBody = (view: ImportJobView): BffImportJob => ({ ...view });

/** Strict query of the import listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function importQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'entity', 'status']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const entity = ctx.query.get('entity');
  const status = ctx.query.get('status');
  if (
    limit === undefined ||
    (entity !== null && !(BFF_IMPORT_ENTITIES as readonly string[]).includes(entity)) ||
    (status !== null && !(BFF_IMPORT_STATUSES as readonly string[]).includes(status))
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([entity, status, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      ...(entity === null ? {} : { entity: entity as BffImportEntity }),
      ...(status === null ? {} : { status: status as BffImportStatus }),
    },
  };
}

/** Strict query of the per-row report: `outcome`, `limit` and a signed cursor bound to the tenant, the job and the filter. */
function importRowsQuery(ctx: RouteContext, tenantId: string, jobId: string) {
  const allowed = new Set(['limit', 'cursor', 'outcome']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const outcome = ctx.query.get('outcome');
  if (
    limit === undefined ||
    (outcome !== null && !(BFF_IMPORT_OUTCOMES as readonly string[]).includes(outcome))
  )
    return null;
  const filter = JSON.stringify(['import-rows', jobId, outcome, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: { limit, offset, ...(outcome === null ? {} : { outcome: outcome as BffImportOutcome }) },
  };
}

/** Strict query of the job history: only `limit` and a signed cursor bound to the tenant and the job. */
function importHistoryQuery(ctx: RouteContext, tenantId: string, jobId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['import', jobId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

export const ROUTES: readonly Route[] = [
  route('auth.csrf', async (ctx) => {
    // Always a fresh nonce: a client-supplied one is never re-issued (no fixation of the pre-login token).
    const nonce = ctx.crypto.newNonce();
    ctx.cookies.push(preCsrfCookie(nonce, PRE_CSRF_MAX_AGE));
    const csrf: BffCsrfResponse = { csrfToken: ctx.crypto.preToken(nonce) };
    return success(ctx, 'auth.csrf', csrf);
  }),
  route('auth.login', async (ctx) => {
    const input = body(ctx, ['code', 'nonce']);
    if (!input) return bad(ctx);
    let code: string, nonce: string;
    try {
      code = text(input['code'], 512);
      nonce = text(input['nonce'], 200);
    } catch {
      return bad(ctx);
    }
    const principal = await ctx.platform.verifyPrincipal(code, nonce);
    if (!principal.ok) return errorResponse('unauthorized', ctx.correlationId);
    return openSession(ctx, principal.value, 'auth.login');
  }),
  route('auth.session', async (ctx) =>
    success(
      ctx,
      'auth.session',
      sessionBody(ctx, ctx.session as SessionDetails, ctx.token as string),
    ),
  ),
  route('auth.logout', async (ctx) => {
    const result = await ctx.platform.signOut(ctx.token as string);
    if (!result.ok) return failure(ctx, result.error);
    ctx.cookies.push(clearSessionCookie());
    return success(ctx, 'auth.logout', undefined);
  }),
  route('auth.invitation.inspect', async (ctx) => {
    const input = body(ctx, ['token']);
    if (!input) return bad(ctx);
    let token: string;
    try {
      token = text(input['token'], 512);
    } catch {
      return bad(ctx);
    }
    return reply(
      ctx,
      'auth.invitation.inspect',
      await ctx.platform.inspectInvitation(token),
      (value) => value,
    );
  }),
  route('auth.invitation.accept', async (ctx) => {
    const input = body(ctx, ['token', 'code', 'nonce']);
    if (!input) return bad(ctx);
    let token: string, code: string, nonce: string;
    try {
      token = text(input['token'], 512);
      code = text(input['code'], 512);
      nonce = text(input['nonce'], 200);
    } catch {
      return bad(ctx);
    }
    const principal = await ctx.platform.verifyPrincipal(code, nonce);
    if (!principal.ok) return errorResponse('unauthorized', ctx.correlationId);
    const accepted = await ctx.platform.acceptInvitation(token, principal.value);
    // Unknown, used, expired or mismatched invitations are indistinguishable.
    if (!accepted.ok)
      return accepted.error?.code === 'internal_error'
        ? failure(ctx, accepted.error)
        : errorResponse('not_found', ctx.correlationId);
    return openSession(ctx, principal.value, 'auth.invitation.accept');
  }),
  route('company.settings.get', async (ctx) =>
    reply(
      ctx,
      'company.settings.get',
      await ctx.platform.getSettings(ctx.token as string, ctx.correlationId),
      (v) => v,
    ),
  ),
  route('company.settings.update', async (ctx) => {
    const input = body(ctx, SETTINGS_KEYS, ['name', 'mfa', 'sessionIdleHours']);
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'company.settings.update',
      await ctx.platform.updateSettings(ctx.token as string, ctx.correlationId, {
        name: input['name'],
        mfa: input['mfa'],
        sessionIdleHours: input['sessionIdleHours'],
        ...(Object.hasOwn(input, 'reason') ? { reason: input['reason'] } : {}),
      }),
      (v) => v,
    );
  }),
  route('users.list', async (ctx) => {
    const result = await ctx.platform.listMembers(ctx.token as string, ctx.correlationId);
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const page = listUsers(ctx, result.value.members, result.value.tenantId);
    return page ? success(ctx, 'users.list', page) : bad(ctx);
  }),
  route('users.invite', async (ctx) => {
    const input = body(ctx, ['roleId']);
    if (!input) return bad(ctx);
    const roleId = input['roleId'];
    if (typeof roleId !== 'string') return bad(ctx);
    const invited = await ctx.platform.inviteUser(
      ctx.token as string,
      ctx.correlationId,
      roleId as RoleName,
    );
    return reply(ctx, 'users.invite', invited, (value) => ({
      user: { id: value.identityId, roleId, status: 'invited' as const },
      // Delivery by email is not built yet: the administrator who issues the invitation receives it.
      invitationToken: value.invitationToken,
      expiresAt: iso(value.expiresAt),
    }));
  }),
  route(
    'users.deactivate',
    async (ctx) => {
      const input = body(ctx, ['reason']);
      if (!input) return bad(ctx);
      try {
        text(input['reason'], 500);
      } catch {
        return bad(ctx);
      }
      const id = ctx.params['id'] as string;
      const removed = await ctx.platform.removeMember(ctx.token as string, ctx.correlationId, id);
      return reply(ctx, 'users.deactivate', removed, () => ({ id, status: 'inactive' as const }));
    },
    { id: ID },
  ),
  route('roles.list', async (ctx) =>
    reply(
      ctx,
      'roles.list',
      await ctx.platform.listRoles(ctx.token as string, ctx.correlationId),
      (items) => ({
        items,
      }),
    ),
  ),
  route(
    'roles.copy',
    async (ctx) => {
      const input = body(ctx, ['name']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'roles.copy',
        await ctx.platform.copyRole(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['name'],
        ),
        (v) => v,
      );
    },
    { id: ID },
  ),
  route(
    'drafts.load',
    async (ctx) =>
      reply(
        ctx,
        'drafts.load',
        await ctx.platform.loadDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
        ),
        (draft) => ({ draft: draft && { ...draft, savedAt: iso(draft.savedAt) } }),
      ),
    { scope: SCOPE },
  ),
  route(
    'drafts.save',
    async (ctx) => {
      const input = body(ctx, ['values']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'drafts.save',
        await ctx.platform.saveDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
          input['values'],
        ),
        (draft) => ({ ...draft, savedAt: iso(draft.savedAt) }),
      );
    },
    { scope: SCOPE },
  ),
  route(
    'drafts.discard',
    async (ctx) =>
      reply(
        ctx,
        'drafts.discard',
        await ctx.platform.discardDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
        ),
        () => undefined,
      ),
    { scope: SCOPE },
  ),
  route('vehicles.list', async (ctx) => {
    const parsed = vehicleQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.vehicles.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffVehicle> = {
      items: items.map(vehicleBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'economicNumber', direction: 'asc' },
    };
    return success(ctx, 'vehicles.list', page);
  }),
  route('vehicles.create', async (ctx) => {
    const input = body(ctx, VEHICLE_CREATE_KEYS, VEHICLE_CREATE_REQUIRED);
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'vehicles.create',
      await ctx.platform.vehicles.create(ctx.token as string, ctx.correlationId, input),
      vehicleBody,
    );
  }),
  route(
    'vehicles.get',
    async (ctx) =>
      reply(
        ctx,
        'vehicles.get',
        await ctx.platform.vehicles.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        vehicleBody,
      ),
    { id: ID },
  ),
  route(
    'vehicles.update',
    async (ctx) => {
      const input = body(ctx, ['version', ...VEHICLE_PATCH_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'vehicles.update',
        await ctx.platform.vehicles.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.status',
    async (ctx) => {
      const input = body(ctx, ['version', 'status', 'reason']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'vehicles.status',
        await ctx.platform.vehicles.changeStatus(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
          input['status'],
          input['reason'],
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.odometer',
    async (ctx) => {
      const input = body(ctx, ['version', 'odometerKm']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'vehicles.odometer',
        await ctx.platform.vehicles.recordOdometer(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
          input['odometerKm'],
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'vehicles.archive',
        await ctx.platform.vehicles.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.history',
    async (ctx) =>
      reply(
        ctx,
        'vehicles.history',
        await ctx.platform.vehicles.history(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        (items) => ({ items }),
      ),
    { id: ID },
  ),
  route('employees.list', async (ctx) => {
    const parsed = employeeQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.employees.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffEmployee> = {
      items: items.map(employeeBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'lastName', direction: 'asc' },
    };
    return success(ctx, 'employees.list', page);
  }),
  route('employees.create', async (ctx) => {
    const input = body(
      ctx,
      ['kind', ...EMPLOYEE_KEYS],
      ['kind', 'firstName', 'lastName', 'areaId'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'employees.create',
      await ctx.platform.employees.create(ctx.token as string, ctx.correlationId, input),
      employeeBody,
    );
  }),
  route(
    'employees.get',
    async (ctx) =>
      reply(
        ctx,
        'employees.get',
        await ctx.platform.employees.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        employeeDetailBody,
      ),
    { id: ID },
  ),
  route(
    'employees.update',
    async (ctx) => {
      const input = body(ctx, ['version', ...EMPLOYEE_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'employees.update',
        await ctx.platform.employees.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        employeeBody,
      );
    },
    { id: ID },
  ),
  route(
    'employees.status',
    async (ctx) => {
      const input = body(ctx, ['version', 'status', 'reason']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'employees.status',
        await ctx.platform.employees.changeStatus(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
          input['status'],
          input['reason'],
        ),
        employeeBody,
      );
    },
    { id: ID },
  ),
  route(
    'employees.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'employees.archive',
        await ctx.platform.employees.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        employeeBody,
      );
    },
    { id: ID },
  ),
  route(
    'employees.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = employeeHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.employees.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffEmployeeHistoryEntry> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'version', direction: 'desc' },
      };
      return success(ctx, 'employees.history', page);
    },
    { id: ID },
  ),
  route('documents.list', async (ctx) => {
    const parsed = documentQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.documents.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffDocument> = {
      items: items.map(documentBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'expiresOn', direction: 'asc' },
    };
    return success(ctx, 'documents.list', page);
  }),
  route('documents.create', async (ctx) => {
    const input = body(
      ctx,
      ['ownerType', 'ownerId', 'typeCode', 'title', 'notes', ...DOCUMENT_VALIDITY_KEYS],
      ['ownerType', 'ownerId', 'typeCode', 'title'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'documents.create',
      await ctx.platform.documents.create(ctx.token as string, ctx.correlationId, input),
      documentBody,
    );
  }),
  route(
    'documents.get',
    async (ctx) =>
      reply(
        ctx,
        'documents.get',
        await ctx.platform.documents.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        documentBody,
      ),
    { id: ID },
  ),
  route(
    'documents.update',
    async (ctx) => {
      const input = body(ctx, ['version', 'title', 'notes'], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'documents.update',
        await ctx.platform.documents.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        documentBody,
      );
    },
    { id: ID },
  ),
  route(
    'documents.renew',
    async (ctx) => {
      const input = body(ctx, ['version', ...DOCUMENT_VALIDITY_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...renewal } = input;
      return reply(
        ctx,
        'documents.renew',
        await ctx.platform.documents.renew(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          renewal,
        ),
        documentBody,
      );
    },
    { id: ID },
  ),
  route(
    'documents.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'documents.archive',
        await ctx.platform.documents.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        documentBody,
      );
    },
    { id: ID },
  ),
  route(
    'documents.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = documentHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.documents.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffDocumentRevision> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'revision', direction: 'desc' },
      };
      return success(ctx, 'documents.history', page);
    },
    { id: ID },
  ),
  route('insurance.list', async (ctx) => {
    const parsed = policyQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.insurance.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffInsurancePolicy> = {
      items: items.map(policyBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'endsOn', direction: 'asc' },
    };
    return success(ctx, 'insurance.list', page);
  }),
  route('insurance.create', async (ctx) => {
    const input = body(
      ctx,
      [
        'vehicleId',
        'insurer',
        'coverageNotes',
        'policyNumber',
        'coverageType',
        'startsOn',
        'endsOn',
        'deductible',
      ],
      ['vehicleId', 'insurer', 'policyNumber', 'coverageType', 'startsOn', 'endsOn'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'insurance.create',
      await ctx.platform.insurance.create(ctx.token as string, ctx.correlationId, input),
      policyBody,
    );
  }),
  route(
    'insurance.get',
    async (ctx) =>
      reply(
        ctx,
        'insurance.get',
        await ctx.platform.insurance.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        policyBody,
      ),
    { id: ID },
  ),
  route(
    'insurance.update',
    async (ctx) => {
      const input = body(ctx, ['version', 'insurer', 'coverageNotes'], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'insurance.update',
        await ctx.platform.insurance.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        policyBody,
      );
    },
    { id: ID },
  ),
  route(
    'insurance.renew',
    async (ctx) => {
      const input = body(ctx, POLICY_RENEWAL_KEYS, ['version', 'startsOn', 'endsOn']);
      if (!input) return bad(ctx);
      const { version, ...renewal } = input;
      return reply(
        ctx,
        'insurance.renew',
        await ctx.platform.insurance.renew(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          renewal,
        ),
        policyBody,
      );
    },
    { id: ID },
  ),
  route(
    'insurance.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'insurance.archive',
        await ctx.platform.insurance.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        policyBody,
      );
    },
    { id: ID },
  ),
  route(
    'insurance.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = policyHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.insurance.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffInsurancePolicyRevision> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'revision', direction: 'desc' },
      };
      return success(ctx, 'insurance.history', page);
    },
    { id: ID },
  ),
  route('assignments.list', async (ctx) => {
    const parsed = assignmentQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.assignments.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffVehicleAssignment> = {
      items: items.map(assignmentBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'startedAt', direction: 'desc' },
    };
    return success(ctx, 'assignments.list', page);
  }),
  route('assignments.create', async (ctx) => {
    const input = body(
      ctx,
      ['vehicleId', 'employeeId', 'type', 'reason', 'replace'],
      ['vehicleId', 'employeeId', 'type', 'reason'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'assignments.create',
      await ctx.platform.assignments.create(ctx.token as string, ctx.correlationId, input),
      (view) => ({
        assignment: assignmentBody(view.assignment),
        replaced: view.replaced === null ? null : assignmentBody(view.replaced),
      }),
    );
  }),
  route(
    'assignments.get',
    async (ctx) =>
      reply(
        ctx,
        'assignments.get',
        await ctx.platform.assignments.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        assignmentBody,
      ),
    { id: ID },
  ),
  route(
    'assignments.end',
    async (ctx) => {
      const input = body(ctx, ['version', 'reason']);
      if (!input) return bad(ctx);
      const { version, ...ending } = input;
      return reply(
        ctx,
        'assignments.end',
        await ctx.platform.assignments.end(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          ending,
        ),
        assignmentBody,
      );
    },
    { id: ID },
  ),
  route(
    'assignments.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = assignmentHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.assignments.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffVehicleAssignmentEvent> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'seq', direction: 'desc' },
      };
      return success(ctx, 'assignments.history', page);
    },
    { id: ID },
  ),
  route('imports.list', async (ctx) => {
    const parsed = importQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.imports.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffImportJob> = {
      items: items.map(importBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'createdAt', direction: 'desc' },
    };
    return success(ctx, 'imports.list', page);
  }),
  route('imports.create', async (ctx) => {
    const input = body(
      ctx,
      ['entity', 'mode', 'idempotencyKey', 'dryRunJobId', 'rows', 'csv'],
      ['entity', 'mode'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'imports.create',
      await ctx.platform.imports.submit(ctx.token as string, ctx.correlationId, input),
      (view) => ({ job: importBody(view.job), replayed: view.replayed }),
    );
  }),
  route(
    'imports.get',
    async (ctx) =>
      reply(
        ctx,
        'imports.get',
        await ctx.platform.imports.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        importBody,
      ),
    { id: ID },
  ),
  route(
    'imports.rows',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = importRowsQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.imports.rows(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffImportRow> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'rowNumber', direction: 'asc' },
      };
      return success(ctx, 'imports.rows', page);
    },
    { id: ID },
  ),
  route(
    'imports.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = importHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.imports.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffImportEvent> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'seq', direction: 'desc' },
      };
      return success(ctx, 'imports.history', page);
    },
    { id: ID },
  ),
  route('areas.list', async (ctx) => {
    const parsed = areaQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.areas.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffArea> = {
      items: items.map(areaBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'name', direction: 'asc' },
    };
    return success(ctx, 'areas.list', page);
  }),
  route('areas.create', async (ctx) => {
    const input = body(ctx, AREA_KEYS, ['name']);
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'areas.create',
      await ctx.platform.areas.create(ctx.token as string, ctx.correlationId, input),
      areaBody,
    );
  }),
  route(
    'areas.get',
    async (ctx) =>
      reply(
        ctx,
        'areas.get',
        await ctx.platform.areas.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        areaDetailBody,
      ),
    { id: ID },
  ),
  route(
    'areas.update',
    async (ctx) => {
      const input = body(ctx, ['version', ...AREA_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'areas.update',
        await ctx.platform.areas.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        areaBody,
      );
    },
    { id: ID },
  ),
  route(
    'areas.deactivate',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'areas.deactivate',
        await ctx.platform.areas.deactivate(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        areaBody,
      );
    },
    { id: ID },
  ),
  route(
    'areas.activate',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'areas.activate',
        await ctx.platform.areas.activate(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        areaBody,
      );
    },
    { id: ID },
  ),
  route(
    'areas.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = areaHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.areas.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffAreaHistoryEntry> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'version', direction: 'desc' },
      };
      return success(ctx, 'areas.history', page);
    },
    { id: ID },
  ),
];
