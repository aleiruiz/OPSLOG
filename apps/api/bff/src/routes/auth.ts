import {
  type BffCsrfResponse,
  type BffSession,
} from '../../../../../packages/contracts/src/index.js';
import type { SessionDetails } from '../../../composition/src/index.js';
import { text } from '../body.js';
import {
  clearPreCsrfCookie,
  clearSessionCookie,
  preCsrfCookie,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
  parseCookies,
} from '../cookies.js';
import { errorResponse, singleHeader, type BffResponse } from '../http.js';
import {
  route,
  failure,
  success,
  reply,
  iso,
  body,
  bad,
  type Route,
  type RouteContext,
} from './shared.js';

const PRE_CSRF_MAX_AGE = 3600;

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

export const AUTH_ROUTES: readonly Route[] = [
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
];
