import {
  BFF_ERRORS,
  BFF_ROUTES,
  CSRF_HEADER,
  bffPath,
  isBffErrorBody,
  type BffCallArgs,
  type BffResponseOf,
  type BffRouteId,
  type BffSession,
} from './bff.js';
import type { ApiError } from './index.js';

/** Outcome of a call: failures are values (uniform `ApiError`), never exceptions. */
export type BffResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/** The slice of `fetch` the client needs, so tests can run it against an in-process BFF. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    credentials: 'same-origin';
    cache: 'no-store';
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface BffClientOptions {
  /** Origin prefix of the BFF; empty (default) means same-origin relative URLs. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}

export interface BffClient {
  call<K extends BffRouteId>(id: K, ...args: BffCallArgs<K>): Promise<BffResult<BffResponseOf<K>>>;
}

const TOKEN_ROUTES: ReadonlySet<BffRouteId> = new Set([
  'auth.csrf',
  'auth.session',
  'auth.login',
  'auth.invitation.accept',
]);

const KNOWN_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 422, 429, 500];

function failure(
  status: number,
  code: string,
  message: string,
  correlationId: string,
): BffResult<never> {
  // The shared ApiError type has no 405/413/415: those are caller bugs and read as a bad request.
  const normalized = KNOWN_STATUSES.includes(status) ? status : status >= 500 ? 500 : 400;
  const error: ApiError = {
    code,
    status: normalized as ApiError['status'],
    message,
    correlationId,
  };
  return { ok: false, error };
}

/**
 * Typed client for the BFF. Every call is derived from the contract module (`BFF_ROUTES`,
 * `BffRouteTypes`): method, path and protection are never written down here. It owns the CSRF
 * handshake: a pre-login token for sign-in and invitations, the session token (returned by the BFF
 * with the session, kept in memory only) for state changes. The session credential itself is an
 * httpOnly cookie that this code never sees.
 */
export function createBffClient(options: BffClientOptions = {}): BffClient {
  const baseUrl = options.baseUrl ?? '';
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let preToken: string | null = null;
  let sessionToken: string | null = null;

  async function exchange<K extends BffRouteId>(
    id: K,
    input: Record<string, unknown>,
    csrf: string | null,
  ): Promise<BffResult<BffResponseOf<K>>> {
    const definition = BFF_ROUTES[id];
    const path = bffPath(
      id,
      (input['params'] ?? {}) as Record<string, string>,
      (input['query'] ?? {}) as Record<string, string | number | undefined>,
    );
    const headers: Record<string, string> = { accept: 'application/json' };
    if (csrf !== null) headers[CSRF_HEADER] = csrf;
    const hasBody = input['body'] !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: definition.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(input['body']) } : {}),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return failure(500, 'network_error', 'No pudimos contactar al servidor.', 'client');
    }
    const correlationId = response.headers.get('x-correlation-id') ?? 'client';
    let raw = '';
    try {
      raw = await response.text();
    } catch {
      return failure(500, 'invalid_response', 'Respuesta ilegible.', correlationId);
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      return failure(500, 'invalid_response', 'Respuesta ilegible.', correlationId);
    }
    if (response.status !== definition.status) {
      if (isBffErrorBody(parsed))
        return failure(parsed.status, parsed.code, parsed.message, parsed.correlationId);
      return failure(
        response.status,
        'invalid_response',
        'Respuesta inesperada del servidor.',
        correlationId,
      );
    }
    // Token-bearing responses must really carry the token: never trust a malformed 2xx body.
    if (
      TOKEN_ROUTES.has(id) &&
      (typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { csrfToken?: unknown }).csrfToken !== 'string')
    )
      return failure(500, 'invalid_response', 'Respuesta inesperada del servidor.', correlationId);
    return { ok: true, value: parsed as BffResponseOf<K> };
  }

  // Concurrent callers share one in-flight `auth.csrf` exchange.
  let pendingPre: Promise<BffResult<string>> | null = null;
  function ensurePre(): Promise<BffResult<string>> {
    if (preToken !== null) return Promise.resolve({ ok: true, value: preToken });
    if (pendingPre) return pendingPre;
    const pending = (async (): Promise<BffResult<string>> => {
      try {
        const fetched = await exchange('auth.csrf', {}, null);
        if (!fetched.ok) return fetched;
        preToken = fetched.value.csrfToken;
        return { ok: true, value: preToken };
      } finally {
        pendingPre = null;
      }
    })();
    pendingPre = pending;
    return pending;
  }

  // Who the page believes is signed in ("user|company"). A silent token refresh must never switch it:
  // another tab sharing the cookie jar may have signed in as someone else, and a replayed write
  // would then land in that other person's company.
  let identity: string | null = null;
  const identityOf = (session: BffSession): string => `${session.user.id}|${session.company.id}`;

  async function ensureSession(): Promise<BffResult<string>> {
    if (sessionToken !== null) return { ok: true, value: sessionToken };
    const fetched = await exchange('auth.session', {}, null);
    if (!fetched.ok) return fetched;
    if (identity !== null && identityOf(fetched.value) !== identity)
      return failure(401, 'unauthorized', BFF_ERRORS.unauthorized.message, 'client');
    identity = identityOf(fetched.value);
    sessionToken = fetched.value.csrfToken;
    return { ok: true, value: sessionToken };
  }

  async function call<K extends BffRouteId>(
    id: K,
    ...args: BffCallArgs<K>
  ): Promise<BffResult<BffResponseOf<K>>> {
    const input = (args[0] ?? {}) as Record<string, unknown>;
    const kind = BFF_ROUTES[id].kind;
    const needsPre = kind === 'pre-session';
    const needsSession = kind === 'session-csrf';
    const tokenFor = (): Promise<BffResult<string>> | null =>
      needsPre ? ensurePre() : needsSession ? ensureSession() : null;

    let csrf: string | null = null;
    const first = tokenFor();
    if (first) {
      const token = await first;
      if (!token.ok) return token;
      csrf = token.value;
    }
    let result = await exchange(id, input, csrf);
    if (!result.ok && result.error.code === 'csrf_failed' && first) {
      // The pre-login cookie or the session moved on: refresh the token once and retry.
      if (needsPre) preToken = null;
      else sessionToken = null;
      const again = await (tokenFor() as Promise<BffResult<string>>);
      if (!again.ok) return again;
      result = await exchange(id, input, again.value);
    }
    if (result.ok) {
      if (id === 'auth.csrf') preToken = (result.value as BffResponseOf<'auth.csrf'>).csrfToken;
      if (id === 'auth.session' || id === 'auth.login' || id === 'auth.invitation.accept') {
        sessionToken = (result.value as BffSession).csrfToken;
        identity = identityOf(result.value as BffSession);
        preToken = null;
      }
      if (id === 'auth.logout') {
        sessionToken = null;
        identity = null;
        preToken = null;
      }
    } else if (result.error.status === 401 && (kind === 'session' || kind === 'session-csrf')) {
      sessionToken = null;
    }
    return result;
  }

  return { call };
}
