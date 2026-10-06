import { describe, expect, it, vi } from 'vitest';
import {
  BodyTooLarge,
  declaredLength,
  isJsonContentType,
  parseObject,
  readBody,
  text,
} from './body.js';
import {
  clearPreCsrfCookie,
  clearSessionCookie,
  parseCookies,
  preCsrfCookie,
  readCookie,
  sessionCookie,
} from './cookies.js';
import { BffCrypto, originAllowed, parseAllowedOrigins, safeEqual } from './csrf.js';
import { errorResponse, normalizeHeaders, respond, singleHeader } from './http.js';

const TOKEN = 'A'.repeat(43);

describe('cookies', () => {
  it('serializes the session cookie with every protective attribute', () => {
    expect(sessionCookie(TOKEN, 28800)).toBe(
      `opslog_session=${TOKEN}; Path=/api; Max-Age=28800; SameSite=Lax; HttpOnly; Secure`,
    );
    expect(sessionCookie(TOKEN, 0.2)).toContain('Max-Age=1');
    expect(sessionCookie(TOKEN, -5)).toContain('Max-Age=1');
    expect(clearSessionCookie()).toBe(
      'opslog_session=; Path=/api; Max-Age=0; SameSite=Lax; HttpOnly; Secure',
    );
  });

  it('serializes the pre-login cookie as SameSite=Strict', () => {
    expect(preCsrfCookie(TOKEN, 3600)).toBe(
      `opslog_csrf=${TOKEN}; Path=/api; Max-Age=3600; SameSite=Strict; HttpOnly; Secure`,
    );
    expect(clearPreCsrfCookie()).toContain('Max-Age=0');
  });

  it('refuses to serialize values that could inject attributes or headers', () => {
    for (const value of [
      '',
      'short',
      `${TOKEN}; Domain=evil.test`,
      `${TOKEN}\r\nSet-Cookie: x=y`,
      'é'.repeat(20),
    ]) {
      expect(() => sessionCookie(value, 10)).toThrow();
      expect(() => preCsrfCookie(value, 10)).toThrow();
    }
  });

  it('parses cookie headers defensively', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies('').size).toBe(0);
    expect(parseCookies('a'.repeat(5000)).size).toBe(0);
    const parsed = parseCookies(` a=1; b=2 ;c; =x; a=3; d=e=f`);
    expect(parsed.get('a')).toEqual(['1', '3']);
    expect(parsed.get('b')).toEqual(['2']);
    expect(parsed.get('d')).toEqual(['e=f']);
    expect(parsed.has('c')).toBe(false);
  });

  it('reads a cookie only when it is present once and well formed', () => {
    expect(readCookie(parseCookies(`s=${TOKEN}`), 's')).toBe(TOKEN);
    expect(readCookie(parseCookies(`s=${TOKEN}; s=${TOKEN}`), 's')).toBeNull();
    expect(readCookie(parseCookies('s=bad value'), 's')).toBeNull();
    expect(readCookie(parseCookies('s=abc'), 's')).toBeNull();
    expect(readCookie(parseCookies(`s=${'A'.repeat(129)}`), 's')).toBeNull();
    expect(readCookie(parseCookies('t=1'), 's')).toBeNull();
  });
});

describe('BffCrypto', () => {
  const crypto = new BffCrypto('synthetic-secret-with-at-least-32-chars!!');

  it('requires a long secret', () => {
    expect(() => new BffCrypto('short')).toThrow(/secret/);
    expect(() => new BffCrypto(undefined as unknown as string)).toThrow(/secret/);
  });

  it('derives stable session-bound CSRF tokens that differ per session and per secret', () => {
    const token = crypto.sessionToken(TOKEN);
    expect(token).toBe(crypto.sessionToken(TOKEN));
    expect(token).not.toBe(crypto.sessionToken('B'.repeat(43)));
    expect(token).not.toContain(TOKEN);
    expect(new BffCrypto('another-secret-with-at-least-32-chars!').sessionToken(TOKEN)).not.toBe(
      token,
    );
    // Session and pre-login tokens use separate keys: one cannot stand in for the other.
    expect(crypto.preToken(TOKEN)).not.toBe(token);
    expect(crypto.verifySession(TOKEN, { 'x-csrf-token': token })).toBe(true);
    expect(crypto.verifySession(TOKEN, { 'x-csrf-token': crypto.preToken(TOKEN) })).toBe(false);
    expect(crypto.verifySession(TOKEN, {})).toBe(false);
    expect(crypto.verifySession(TOKEN, { 'x-csrf-token': [token, token] })).toBe(false);
    expect(crypto.verifySession(TOKEN, { 'x-csrf-token': token.slice(1) })).toBe(false);
  });

  it('verifies pre-login tokens against the nonce cookie', () => {
    const nonce = crypto.newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).not.toBe(crypto.newNonce());
    const token = crypto.preToken(nonce);
    expect(crypto.verifyPre(nonce, { 'x-csrf-token': token })).toBe(true);
    expect(crypto.verifyPre(null, { 'x-csrf-token': token })).toBe(false);
    expect(crypto.verifyPre(nonce, {})).toBe(false);
    expect(crypto.verifyPre(crypto.newNonce(), { 'x-csrf-token': token })).toBe(false);
  });

  it('signs cursors and rejects any tampering', () => {
    const cursor = crypto.signCursor({ t: 'tenant', o: 25 });
    expect(crypto.openCursor(cursor)).toEqual({ t: 'tenant', o: 25 });
    expect(crypto.openCursor(`${cursor}x`)).toBeNull();
    expect(
      crypto.openCursor(`${cursor.slice(0, 3)}${cursor[3] === 'A' ? 'B' : 'A'}${cursor.slice(4)}`),
    ).toBeNull();
    expect(crypto.openCursor('nodot')).toBeNull();
    expect(crypto.openCursor('.abc')).toBeNull();
    expect(crypto.openCursor('x'.repeat(513))).toBeNull();
    expect(new BffCrypto('another-secret-with-at-least-32-chars!').openCursor(cursor)).toBeNull();
  });

  it('compares in constant time over equal lengths only', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('opening an authentic cursor whose body cannot be parsed', () => {
  it('returns null', () => {
    const crypto = new BffCrypto('synthetic-secret-with-at-least-32-chars!!');
    const cursor = crypto.signCursor({ a: 1 });
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('boom');
    });
    expect(crypto.openCursor(cursor)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('origin policy', () => {
  const allowed = parseAllowedOrigins(['https://app.example.test', 'http://localhost:3000']);
  const base = { origin: 'https://app.example.test', host: 'app.example.test' };

  it('accepts exactly the configured origins sent to their own host', () => {
    expect(originAllowed(base, allowed)).toBe(true);
    expect(
      originAllowed({ origin: 'http://localhost:3000', host: 'localhost:3000' }, allowed),
    ).toBe(true);
    expect(originAllowed({ ...base, 'sec-fetch-site': 'same-origin' }, allowed)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const headers of [
      {},
      { host: base.host },
      { origin: base.origin },
      { ...base, origin: 'https://evil.test' },
      { ...base, origin: 'null' },
      { ...base, host: 'evil.test' },
      { ...base, 'sec-fetch-site': 'cross-site' },
      { ...base, 'sec-fetch-site': 'none' },
      { ...base, 'sec-fetch-site': ['same-origin', 'same-origin'] },
      { ...base, origin: [base.origin, base.origin] },
    ])
      expect(originAllowed(headers, allowed)).toBe(false);
  });

  it('validates the configuration', () => {
    expect(() => parseAllowedOrigins([])).toThrow();
    expect(() => parseAllowedOrigins(['ftp://x.test'])).toThrow();
    expect(() => parseAllowedOrigins(['https://x.test/'])).toThrow();
    expect(() => parseAllowedOrigins(['http://x.test'])).toThrow();
    expect(() => parseAllowedOrigins(['://'])).toThrow();
    expect(parseAllowedOrigins(['http://127.0.0.1:8080']).size).toBe(1);
  });
});

describe('body helpers', () => {
  async function* parts(...chunks: number[]) {
    for (const size of chunks) yield new Uint8Array(size);
  }

  it('reads declared lengths strictly', () => {
    expect(declaredLength({})).toBeNull();
    expect(declaredLength({ 'content-length': '12' })).toBe(12);
    expect(declaredLength({ 'content-length': '0' })).toBe(0);
    for (const value of ['abc', '-1', '1.5', '', '1234567890123', ['1', '2']])
      expect(declaredLength({ 'content-length': value })).toBe('invalid');
  });

  it('accepts only JSON content types', () => {
    for (const ok of [
      'application/json',
      'APPLICATION/JSON',
      'application/json; charset=utf-8',
      'application/json;charset="UTF-8"',
    ])
      expect(isJsonContentType(ok)).toBe(true);
    for (const bad of [
      undefined,
      '',
      'text/json',
      'application/json; charset=utf-16',
      'application/json; x=y',
      'multipart/form-data',
    ])
      expect(isJsonContentType(bad)).toBe(false);
  });

  it('buffers up to the limit and stops reading beyond it', async () => {
    expect((await readBody({ method: 'POST', url: '/', headers: {} }, 10)).byteLength).toBe(0);
    expect(
      (await readBody({ method: 'POST', url: '/', headers: {}, body: parts(4, 6) }, 10)).byteLength,
    ).toBe(10);
    let pulled = 0;
    const endless = (async function* () {
      for (;;) {
        pulled += 1;
        yield new Uint8Array(8);
      }
    })();
    await expect(
      readBody({ method: 'POST', url: '/', headers: {}, body: endless }, 10),
    ).rejects.toBeInstanceOf(BodyTooLarge);
    expect(pulled).toBe(2);
  });

  it('parses strict objects', () => {
    const bytes = (value: string) => Buffer.from(value);
    expect(parseObject(bytes('{"a":"1"}'), ['a'])).toEqual({ a: '1' });
    expect(parseObject(bytes('{}'), ['a'], [])).toEqual({});
    for (const bad of ['', 'x', 'null', '[]', '1', '{"b":1}', '{"a":1,"b":2}', '{}'])
      expect(() => parseObject(bytes(bad), ['a'])).toThrow();
    expect(() => parseObject(Uint8Array.from([0xff]), ['a'])).toThrow();
  });

  it('accepts only non-blank bounded strings', () => {
    expect(text('ok', 5)).toBe('ok');
    for (const bad of ['', '   ', 'toolong', 5, null, undefined])
      expect(() => text(bad, 5)).toThrow();
  });
});

describe('http helpers', () => {
  it('normalizes and reads headers', () => {
    expect(normalizeHeaders({ Host: 'a', 'X-A': ['1'], x_b: undefined })).toEqual({
      host: 'a',
      'x-a': ['1'],
      x_b: undefined,
    });
    expect(normalizeHeaders({ A: '1', a: '2' })).toEqual({ a: ['1', '2'] });
    expect(normalizeHeaders({ A: ['1'], a: ['2'] })).toEqual({ a: ['1', '2'] });
    expect(normalizeHeaders({ A: '1', a: undefined })).toEqual({ a: ['1'] });
  });

  it('keeps a header named __proto__ as a plain entry without touching any prototype', () => {
    const incoming = JSON.parse('{"__proto__": ["polluted"], "X-A": "1"}') as Record<
      string,
      string | string[]
    >;
    const result = normalizeHeaders(incoming);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.keys(result).sort()).toEqual(['__proto__', 'x-a']);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual(['polluted']);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(singleHeader(result, 'x-a')).toBe('1');
    expect(normalizeHeaders(JSON.parse('{"__PROTO__": "a", "__proto__": "b"}'))).toEqual(
      JSON.parse('{"__proto__": ["a", "b"]}'),
    );
    expect(singleHeader({ a: 'x' }, 'a')).toBe('x');
    expect(singleHeader({ a: ['x'] }, 'a')).toBe('x');
    expect(singleHeader({ a: ['x', 'y'] }, 'a')).toBeUndefined();
    expect(singleHeader({}, 'a')).toBeUndefined();
  });

  it('builds responses with security headers and optional bodies', () => {
    const empty = respond(204, undefined, 'c1');
    expect(empty.body).toBe('');
    expect(empty.headers['content-type']).toBeUndefined();
    expect(empty.headers['x-correlation-id']).toBe('c1');
    const json = respond(200, { a: 1 }, 'c2', { 'set-cookie': ['a=b'] });
    expect(json.body).toBe('{"a":1}');
    expect(json.headers['set-cookie']).toEqual(['a=b']);
    expect(JSON.parse(errorResponse('not_found', 'c3').body)).toEqual({
      code: 'not_found',
      status: 404,
      message: 'Resource not found',
      correlationId: 'c3',
    });
  });
});
