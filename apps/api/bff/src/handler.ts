import { randomUUID } from 'node:crypto';
import type { Platform } from '../../composition/src/index.js';
import { BodyTooLarge, declaredLength, isJsonContentType, readBody } from './body.js';
import {
  clearSessionCookie,
  parseCookies,
  PRE_CSRF_COOKIE,
  readCookie,
  SESSION_COOKIE,
} from './cookies.js';
import { BffCrypto, originAllowed, parseAllowedOrigins } from './csrf.js';
import {
  errorResponse,
  normalizeHeaders,
  singleHeader,
  type BffHandler,
  type BffRequest,
  type BffResponse,
} from './http.js';
import { ROUTES, type Route, type RouteContext } from './routes.js';

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 2048;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface BffOptions {
  readonly platform: Platform;
  /** Server secret (at least 32 characters) for CSRF tokens and signed cursors. Never logged. */
  readonly secret: string;
  /** Exact origins (https, or http on loopback) allowed to call state-changing routes. */
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
  /**
   * Receives only a correlation id, a static route id and the error class name of unexpected
   * failures; never a message, a stack, a request value or a token.
   */
  readonly onError?: (event: {
    readonly correlationId: string;
    readonly route: string;
    readonly errorClass: string;
  }) => void;
}

interface Match {
  readonly route: Route;
  readonly params: Record<string, string>;
}

/** Splits a request target into path and query without ever treating `//host` as an authority. */
function splitTarget(url: string): { path: string; query: string } | null {
  if (url.length > MAX_URL_LENGTH || !url.startsWith('/') || url.startsWith('//')) return null;
  if (/[\u0000- \u007f#\\]/.test(url)) return null;
  const mark = url.indexOf('?');
  return mark < 0
    ? { path: url, query: '' }
    : { path: url.slice(0, mark), query: url.slice(mark + 1) };
}

function matchRoutes(
  method: string,
  path: string,
): { match: Match } | { allowed: readonly string[] } | null {
  const segments = path.split('/').slice(1);
  const allowed: string[] = [];
  for (const route of ROUTES) {
    if (route.path.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let fits = true;
    for (const [index, expected] of route.path.entries()) {
      const actual = segments[index] as string;
      if (expected.startsWith(':')) {
        const name = expected.slice(1);
        let decoded: string;
        try {
          decoded = decodeURIComponent(actual);
        } catch {
          fits = false;
          break;
        }
        if (!route.params?.[name]?.test(decoded)) {
          fits = false;
          break;
        }
        params[name] = decoded;
      } else if (expected !== actual) {
        fits = false;
        break;
      }
    }
    if (!fits) continue;
    if (route.method === method) return { match: { route, params } };
    allowed.push(route.method);
  }
  return allowed.length > 0 ? { allowed } : null;
}

function withCookies(response: BffResponse, cookies: readonly string[]): BffResponse {
  if (cookies.length === 0) return response;
  return { ...response, headers: { ...response.headers, 'set-cookie': cookies } };
}

/**
 * Builds the BFF request handler over a `Platform`. The handler is a pure function of the request
 * and the platform state, so it is testable without sockets. Order of checks for every request:
 * route (404/405) -> declared size (413) -> content type (415) -> body read (413) -> same-origin
 * (403) -> session (401) -> CSRF (403) -> body validation (400) -> permission (403, checked by the
 * composition inside the operation) -> operation.
 */
export function createBffHandler(options: BffOptions): BffHandler {
  const crypto = new BffCrypto(options.secret);
  const origins = parseAllowedOrigins(options.allowedOrigins);
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? (() => new Date());

  return async (request: BffRequest): Promise<BffResponse> => {
    const correlationId = randomUUID();
    let routeId = 'unmatched';
    try {
      const target = splitTarget(request.url);
      if (!target) return errorResponse('bad_request', correlationId);
      const method = request.method.toUpperCase();
      const found = matchRoutes(method, target.path);
      if (!found) return errorResponse('not_found', correlationId);
      if ('allowed' in found)
        return errorResponse('method_not_allowed', correlationId, {
          allow: [...new Set(found.allowed)].join(', '),
        });
      const { route, params } = found.match;
      routeId = route.id;
      const headers = normalizeHeaders(request.headers);
      // Bulk import is the only route that takes more than the default (it carries up to 500 rows).
      const bodyLimit = route.maxBodyBytes ?? maxBody;

      // Body limits come before anything that depends on identity.
      let body = new Uint8Array(0);
      if (BODY_METHODS.has(method)) {
        const length = declaredLength(headers);
        if (length === 'invalid') return errorResponse('bad_request', correlationId);
        if (length !== null && length > bodyLimit)
          return errorResponse('payload_too_large', correlationId, { connection: 'close' });
        const contentType = singleHeader(headers, 'content-type');
        if (headers['content-type'] !== undefined && !isJsonContentType(contentType))
          return errorResponse('unsupported_media_type', correlationId);
        try {
          body = await readBody(request, bodyLimit);
        } catch (error) {
          if (error instanceof BodyTooLarge)
            return errorResponse('payload_too_large', correlationId, { connection: 'close' });
          throw error;
        }
        if (body.byteLength > 0 && !isJsonContentType(contentType))
          return errorResponse('unsupported_media_type', correlationId);
      }

      const stateChanging = route.method !== 'GET';
      const cookies = parseCookies(singleHeader(headers, 'cookie'));
      const cookiePresent = cookies.has(SESSION_COOKIE);
      const clear = cookiePresent ? [clearSessionCookie()] : [];
      const context: RouteContext = {
        platform: options.platform,
        crypto,
        now,
        correlationId,
        params,
        query: new URLSearchParams(target.query),
        headers,
        body,
        token: null,
        session: null,
        cookies: [],
      };

      if (stateChanging && route.kind !== 'public' && !originAllowed(headers, origins))
        return errorResponse('csrf_failed', correlationId);

      if (route.kind === 'pre-session') {
        const nonce = readCookie(cookies, PRE_CSRF_COOKIE);
        if (!crypto.verifyPre(nonce, headers)) return errorResponse('csrf_failed', correlationId);
        return withCookies(await route.handle(context), context.cookies);
      }

      if (route.kind === 'session' || route.kind === 'session-csrf') {
        const token = readCookie(cookies, SESSION_COOKIE);
        if (token === null) return errorResponse('unauthorized', correlationId, setCookie(clear));
        const details = await options.platform.sessionDetails(token, correlationId);
        if (!details.ok || !details.value) {
          const status =
            details.error?.code === 'internal_error' ? 'internal_error' : 'unauthorized';
          return errorResponse(
            status,
            correlationId,
            status === 'unauthorized' ? setCookie(clear) : {},
          );
        }
        if (route.kind === 'session-csrf' && !crypto.verifySession(token, headers))
          return errorResponse('csrf_failed', correlationId);
        const authenticated: RouteContext = { ...context, token, session: details.value };
        const response = await route.handle(authenticated);
        return withCookies(
          response,
          response.status === 401 ? [clearSessionCookie()] : authenticated.cookies,
        );
      }

      return withCookies(await route.handle(context), context.cookies);
    } catch (error) {
      options.onError?.({
        correlationId,
        route: routeId,
        errorClass:
          error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.constructor.name)
            ? error.constructor.name
            : 'Error',
      });
      return errorResponse('internal_error', correlationId);
    }
  };
}

const setCookie = (cookies: readonly string[]): Record<string, readonly string[]> =>
  cookies.length > 0 ? { 'set-cookie': cookies } : {};
