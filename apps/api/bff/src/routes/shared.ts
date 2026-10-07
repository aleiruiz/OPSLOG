import {
  BFF_ROUTES,
  type BffRouteDefinition,
  type BffResponseOf,
  type BffRouteId,
  type BffRouteKind,
} from '../../../../../packages/contracts/src/index.js';
import type { Platform, PlatformResponse, SessionDetails } from '../../../composition/src/index.js';
import { parseObject } from '../body.js';
import type { BffCrypto } from '../csrf.js';
import { errorResponse, respond, type BffResponse, type ErrorCode } from '../http.js';

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

export function route(
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

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/** Maps a composition failure to a uniform error. Unknown codes are internal errors, never echoed. */
export function failure(
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
export function success<K extends BffRouteId>(
  ctx: RouteContext,
  id: K,
  body: BffResponseOf<K>,
): BffResponse {
  return respond(BFF_ROUTES[id].status, body, ctx.correlationId);
}

export function reply<K extends BffRouteId, T>(
  ctx: RouteContext,
  id: K,
  result: PlatformResponse<T>,
  shape: (value: T) => BffResponseOf<K>,
): BffResponse {
  if (!result.ok || result.value === undefined) return failure(ctx, result.error);
  return success(ctx, id, shape(result.value));
}

export const iso = (date: Date): string => date.toISOString();

/** Parses a strict body; any malformed or unexpected property is a uniform 400. */
export function body(
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

export const bad = (ctx: RouteContext): BffResponse =>
  errorResponse('bad_request', ctx.correlationId);

export const LIMITS = [25, 50, 100] as const;

/** Position of a signed list cursor: tenant, offset and the filter it was issued for. */
export interface OffsetCursor {
  readonly t: string;
  readonly o: number;
  readonly q: string;
}

export function isOffsetCursor(value: unknown): value is OffsetCursor {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<OffsetCursor>;
  return (
    typeof c.t === 'string' &&
    Number.isSafeInteger(c.o) &&
    (c.o as number) >= 0 &&
    typeof c.q === 'string'
  );
}
