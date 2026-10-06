import type { Page } from '../../../../packages/contracts/src/index.js';
import type {
  MemberView,
  Platform,
  PlatformResponse,
  RoleName,
  SessionDetails,
} from '../../composition/src/index.js';
import { parseObject, text } from './body.js';
import {
  clearPreCsrfCookie,
  clearSessionCookie,
  preCsrfCookie,
  readCookie,
  sessionCookie,
  PRE_CSRF_COOKIE,
  SESSION_COOKIE,
  parseCookies,
} from './cookies.js';
import type { BffCrypto } from './csrf.js';
import { errorResponse, respond, type BffResponse, type ErrorCode } from './http.js';

/** How a route is protected. `session-csrf` also requires the session-bound token on state changes. */
export type RouteKind = 'public' | 'pre-session' | 'session' | 'session-csrf';

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

export interface Route {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path segments; `:name` captures a segment validated by `params[name]`. */
  readonly path: readonly string[];
  readonly kind: RouteKind;
  readonly params?: Readonly<Record<string, RegExp>>;
  readonly handle: (ctx: RouteContext) => Promise<BffResponse>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const PRE_CSRF_MAX_AGE = 3600;

/** Maps a composition failure to a uniform error. Unknown codes are internal errors, never echoed. */
function failure(ctx: RouteContext, error: { code: string } | undefined): BffResponse {
  const map: Readonly<Record<string, ErrorCode>> = {
    invalid_input: 'bad_request',
    unauthorized: 'unauthorized',
    forbidden: 'forbidden',
    not_found: 'not_found',
    conflict: 'conflict',
    last_admin: 'last_admin',
  };
  return errorResponse(map[error?.code ?? ''] ?? 'internal_error', ctx.correlationId);
}

function reply<T>(
  ctx: RouteContext,
  result: PlatformResponse<T>,
  status: number,
  shape: (value: T) => unknown,
): BffResponse {
  if (!result.ok || result.value === undefined) return failure(ctx, result.error);
  const body = shape(result.value);
  return respond(status, body, ctx.correlationId);
}

const iso = (date: Date): string => date.toISOString();

function sessionBody(ctx: RouteContext, details: SessionDetails, token: string) {
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
  status: number,
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
  return respond(status, sessionBody(ctx, details.value, token), ctx.correlationId);
}

function cookieHeader(ctx: RouteContext): string | undefined {
  const value = ctx.headers['cookie'];
  return typeof value === 'string' ? value : undefined;
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
  const page: Page<MemberView> = {
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

export const ROUTES: readonly Route[] = [
  {
    id: 'auth.csrf',
    method: 'GET',
    path: ['api', 'auth', 'csrf'],
    kind: 'public',
    handle: async (ctx) => {
      const nonce =
        readCookie(parseCookies(cookieHeader(ctx)), PRE_CSRF_COOKIE) ?? ctx.crypto.newNonce();
      ctx.cookies.push(preCsrfCookie(nonce, PRE_CSRF_MAX_AGE));
      return respond(200, { csrfToken: ctx.crypto.preToken(nonce) }, ctx.correlationId);
    },
  },
  {
    id: 'auth.login',
    method: 'POST',
    path: ['api', 'auth', 'login'],
    kind: 'pre-session',
    handle: async (ctx) => {
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
      return openSession(ctx, principal.value, 200);
    },
  },
  {
    id: 'auth.session',
    method: 'GET',
    path: ['api', 'auth', 'session'],
    kind: 'session',
    handle: async (ctx) =>
      respond(
        200,
        sessionBody(ctx, ctx.session as SessionDetails, ctx.token as string),
        ctx.correlationId,
      ),
  },
  {
    id: 'auth.logout',
    method: 'POST',
    path: ['api', 'auth', 'logout'],
    kind: 'session-csrf',
    handle: async (ctx) => {
      const result = await ctx.platform.signOut(ctx.token as string);
      if (!result.ok) return failure(ctx, result.error);
      ctx.cookies.push(clearSessionCookie());
      return respond(204, undefined, ctx.correlationId);
    },
  },
  {
    id: 'auth.invitation.inspect',
    method: 'POST',
    path: ['api', 'auth', 'invitations', 'inspect'],
    kind: 'pre-session',
    handle: async (ctx) => {
      const input = body(ctx, ['token']);
      if (!input) return bad(ctx);
      let token: string;
      try {
        token = text(input['token'], 512);
      } catch {
        return bad(ctx);
      }
      return reply(ctx, await ctx.platform.inspectInvitation(token), 200, (value) => value);
    },
  },
  {
    id: 'auth.invitation.accept',
    method: 'POST',
    path: ['api', 'auth', 'invitations', 'accept'],
    kind: 'pre-session',
    handle: async (ctx) => {
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
      return openSession(ctx, principal.value, 201);
    },
  },
  {
    id: 'company.settings.get',
    method: 'GET',
    path: ['api', 'company', 'settings'],
    kind: 'session',
    handle: async (ctx) =>
      reply(
        ctx,
        await ctx.platform.getSettings(ctx.token as string, ctx.correlationId),
        200,
        (v) => v,
      ),
  },
  {
    id: 'company.settings.update',
    method: 'PUT',
    path: ['api', 'company', 'settings'],
    kind: 'session-csrf',
    handle: async (ctx) => {
      const input = body(ctx, SETTINGS_KEYS, ['name', 'mfa', 'sessionIdleHours']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        await ctx.platform.updateSettings(ctx.token as string, ctx.correlationId, {
          name: input['name'],
          mfa: input['mfa'],
          sessionIdleHours: input['sessionIdleHours'],
          ...(Object.hasOwn(input, 'reason') ? { reason: input['reason'] } : {}),
        }),
        200,
        (v) => v,
      );
    },
  },
  {
    id: 'users.list',
    method: 'GET',
    path: ['api', 'users'],
    kind: 'session',
    handle: async (ctx) => {
      const result = await ctx.platform.listMembers(ctx.token as string, ctx.correlationId);
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const page = listUsers(ctx, result.value.members, result.value.tenantId);
      return page ? respond(200, page, ctx.correlationId) : bad(ctx);
    },
  },
  {
    id: 'users.invite',
    method: 'POST',
    path: ['api', 'users', 'invitations'],
    kind: 'session-csrf',
    handle: async (ctx) => {
      const input = body(ctx, ['roleId']);
      if (!input) return bad(ctx);
      const roleId = input['roleId'];
      if (typeof roleId !== 'string') return bad(ctx);
      const invited = await ctx.platform.inviteUser(
        ctx.token as string,
        ctx.correlationId,
        roleId as RoleName,
      );
      return reply(ctx, invited, 201, (value) => ({
        user: { id: value.identityId, roleId, status: 'invited' },
        // Delivery by email is not built yet: the administrator who issues the invitation receives it.
        invitationToken: value.invitationToken,
        expiresAt: iso(value.expiresAt),
      }));
    },
  },
  {
    id: 'users.deactivate',
    method: 'POST',
    path: ['api', 'users', ':id', 'deactivate'],
    params: { id: ID },
    kind: 'session-csrf',
    handle: async (ctx) => {
      const input = body(ctx, ['reason']);
      if (!input) return bad(ctx);
      try {
        text(input['reason'], 500);
      } catch {
        return bad(ctx);
      }
      const id = ctx.params['id'] as string;
      const removed = await ctx.platform.removeMember(ctx.token as string, ctx.correlationId, id);
      return reply(ctx, removed, 200, () => ({ id, status: 'inactive' }));
    },
  },
  {
    id: 'roles.list',
    method: 'GET',
    path: ['api', 'roles'],
    kind: 'session',
    handle: async (ctx) =>
      reply(
        ctx,
        await ctx.platform.listRoles(ctx.token as string, ctx.correlationId),
        200,
        (items) => ({
          items,
        }),
      ),
  },
  {
    id: 'roles.copy',
    method: 'POST',
    path: ['api', 'roles', ':id', 'copy'],
    params: { id: ID },
    kind: 'session-csrf',
    handle: async (ctx) => {
      const input = body(ctx, ['name']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        await ctx.platform.copyRole(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['name'],
        ),
        201,
        (v) => v,
      );
    },
  },
  {
    id: 'drafts.load',
    method: 'GET',
    path: ['api', 'drafts', ':scope'],
    params: { scope: SCOPE },
    kind: 'session',
    handle: async (ctx) =>
      reply(
        ctx,
        await ctx.platform.loadDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
        ),
        200,
        (draft) => ({ draft: draft && { ...draft, savedAt: iso(draft.savedAt) } }),
      ),
  },
  {
    id: 'drafts.save',
    method: 'PUT',
    path: ['api', 'drafts', ':scope'],
    params: { scope: SCOPE },
    kind: 'session-csrf',
    handle: async (ctx) => {
      const input = body(ctx, ['values']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        await ctx.platform.saveDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
          input['values'],
        ),
        200,
        (draft) => ({ ...draft, savedAt: iso(draft.savedAt) }),
      );
    },
  },
  {
    id: 'drafts.discard',
    method: 'DELETE',
    path: ['api', 'drafts', ':scope'],
    params: { scope: SCOPE },
    kind: 'session-csrf',
    handle: async (ctx) =>
      reply(
        ctx,
        await ctx.platform.discardDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
        ),
        204,
        () => undefined,
      ),
  },
];
