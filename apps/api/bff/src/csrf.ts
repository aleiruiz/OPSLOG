import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { singleHeader, type HeaderValue } from './http.js';

export const CSRF_HEADER = 'x-csrf-token';
export const MIN_SECRET_LENGTH = 32;

const subkey = (secret: string, label: string): Buffer =>
  createHmac('sha256', secret).update(`opslog-bff:${label}`).digest();
const mac = (key: Buffer, value: string): string =>
  createHmac('sha256', key).update(value, 'utf8').digest('base64url');

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * CSRF tokens and signed cursors, all derived from one server secret with separate sub-keys.
 * Session routes use a synchronizer token bound to the session (HMAC of the opaque session token);
 * pre-login routes use a signed double-submit cookie. Neither reveals the session token.
 */
export class BffCrypto {
  private readonly sessionKey: Buffer;
  private readonly preKey: Buffer;
  private readonly cursorKey: Buffer;
  public constructor(secret: string) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)
      throw new Error(`BFF secret must have at least ${MIN_SECRET_LENGTH} characters`);
    this.sessionKey = subkey(secret, 'csrf-session');
    this.preKey = subkey(secret, 'csrf-pre');
    this.cursorKey = subkey(secret, 'cursor');
  }
  public sessionToken(sessionToken: string): string {
    return mac(this.sessionKey, sessionToken);
  }
  public newNonce(): string {
    return randomBytes(32).toString('base64url');
  }
  public preToken(nonce: string): string {
    return mac(this.preKey, nonce);
  }
  public verifySession(
    sessionToken: string,
    headers: Readonly<Record<string, HeaderValue>>,
  ): boolean {
    const supplied = singleHeader(headers, CSRF_HEADER);
    return supplied !== undefined && safeEqual(this.sessionToken(sessionToken), supplied);
  }
  public verifyPre(nonce: string | null, headers: Readonly<Record<string, HeaderValue>>): boolean {
    const supplied = singleHeader(headers, CSRF_HEADER);
    return nonce !== null && supplied !== undefined && safeEqual(this.preToken(nonce), supplied);
  }
  public signCursor(payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${mac(this.cursorKey, body)}`;
  }
  /** Returns the payload of an authentic cursor, or null for any malformed or forged value. */
  public openCursor(cursor: string): unknown {
    const dot = cursor.indexOf('.');
    if (dot < 1 || cursor.length > 512) return null;
    const body = cursor.slice(0, dot);
    if (!safeEqual(mac(this.cursorKey, body), cursor.slice(dot + 1))) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * Same-origin guard for state-changing requests: `Origin` must be present and exactly one of the
 * configured origins, its host must equal the `Host` the request was sent to, and a browser that
 * reports `Sec-Fetch-Site` must report `same-origin`.
 */
export function originAllowed(
  headers: Readonly<Record<string, HeaderValue>>,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = singleHeader(headers, 'origin');
  if (origin === undefined || !allowedOrigins.has(origin)) return false;
  const host = singleHeader(headers, 'host');
  if (host === undefined || new URL(origin).host !== host) return false;
  const site = singleHeader(headers, 'sec-fetch-site');
  if (headers['sec-fetch-site'] !== undefined && site !== 'same-origin') return false;
  return true;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Normalizes the configured origins: https, or http only for loopback development. */
export function parseAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0) throw new Error('at least one allowed origin is required');
  const result = new Set<string>();
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('invalid allowed origin');
    }
    const secure =
      url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
    if (!secure || url.origin !== origin) throw new Error('invalid allowed origin');
    result.add(origin);
  }
  return result;
}
