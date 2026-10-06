import { AUTH_COOKIE, authCookie } from '../../../../packages/platform/auth/src/index.js';

export const SESSION_COOKIE = AUTH_COOKIE;
/** Anti-CSRF nonce for the pre-login routes (login, invitation). Never carries identity. */
export const PRE_CSRF_COOKIE = 'opslog_csrf';

/** Opaque tokens are base64url; anything else in a cookie is rejected before any lookup. */
export const COOKIE_VALUE = /^[A-Za-z0-9_-]{16,128}$/;

/** Parses a Cookie header into name -> every value sent (a repeated name is a cookie-tossing signal). */
export function parseCookies(header: string | undefined): ReadonlyMap<string, readonly string[]> {
  const cookies = new Map<string, string[]>();
  if (!header || header.length > 4096) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(name, [...(cookies.get(name) ?? []), value]);
  }
  return cookies;
}

/** The single, well-formed value of a cookie, or null when absent, repeated or malformed. */
export function readCookie(
  cookies: ReadonlyMap<string, readonly string[]>,
  name: string,
): string | null {
  const values = cookies.get(name);
  if (values?.length !== 1) return null;
  const value = values[0] as string;
  return COOKIE_VALUE.test(value) ? value : null;
}

interface CookieSpec {
  readonly name: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict';
  readonly path: string;
}

function serialize(spec: CookieSpec, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${spec.name}=${value}`,
    `Path=${spec.path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    spec.sameSite === 'lax' ? 'SameSite=Lax' : 'SameSite=Strict',
  ];
  if (spec.httpOnly) parts.push('HttpOnly');
  if (spec.secure) parts.push('Secure');
  return parts.join('; ');
}

const sessionSpec = (): CookieSpec => authCookie(true);
const preSpec = (): CookieSpec => ({
  ...authCookie(true),
  name: PRE_CSRF_COOKIE,
  sameSite: 'strict',
});

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  if (!COOKIE_VALUE.test(token)) throw new Error('invalid cookie value');
  return serialize(sessionSpec(), token, Math.max(1, maxAgeSeconds));
}
export const clearSessionCookie = (): string => serialize(sessionSpec(), '', 0);

export function preCsrfCookie(nonce: string, maxAgeSeconds: number): string {
  if (!COOKIE_VALUE.test(nonce)) throw new Error('invalid cookie value');
  return serialize(preSpec(), nonce, Math.max(1, maxAgeSeconds));
}
export const clearPreCsrfCookie = (): string => serialize(preSpec(), '', 0);
