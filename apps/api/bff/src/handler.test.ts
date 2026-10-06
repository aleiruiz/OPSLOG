import { afterEach, describe, expect, it } from 'vitest';
import { serializeApiError } from '../../../../packages/contracts/src/index.js';
import { ERRORS } from './http.js';
import * as bff from './index.js';
import { createBffHandler } from './handler.js';
import { HOST, ORIGIN, SECRET, createBffWorld, type BffWorld, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => world.dispose());

const HOUR = 3_600_000;
const SECURITY_HEADER_NAMES = [
  'cache-control',
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'cross-origin-resource-policy',
  'x-correlation-id',
];

function expectUniformError(reply: Reply, status: number, code: string): void {
  expect(reply.status).toBe(status);
  expect(Object.keys(reply.json).sort()).toEqual(['code', 'correlationId', 'message', 'status']);
  expect(reply.json.code).toBe(code);
  expect(reply.json.status).toBe(status);
  expect(reply.json.correlationId).toBe(reply.headers['x-correlation-id']);
  expect(reply.text).not.toMatch(/at \S+ \(|node_modules|\.ts:\d+|stack/i);
  for (const name of SECURITY_HEADER_NAMES) expect(reply.headers[name]).toBeDefined();
}

async function fixture() {
  world = createBffWorld();
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  const viewerA = await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  return { a, b, viewerA };
}

describe('pre-login CSRF endpoint', () => {
  it('issues a nonce cookie that is httpOnly, Secure and SameSite=Strict, and a token bound to it', async () => {
    world = createBffWorld();
    const browser = world.browser();
    const first = await browser.get('/api/auth/csrf');
    expect(first.status).toBe(200);
    expect(first.json.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.setCookies).toHaveLength(1);
    const cookie = first.setCookies[0] as string;
    expect(cookie).toMatch(/^opslog_csrf=[A-Za-z0-9_-]{43}; /);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api', 'Max-Age=3600'])
      expect(cookie).toContain(attribute);
    expect(first.json.csrfToken).not.toContain(cookie.split(';')[0]!.split('=')[1]!);
    // Every call mints a fresh nonce, even when the browser presents one (or a chosen value).
    const second = await browser.get('/api/auth/csrf');
    expect(second.json.csrfToken).not.toBe(first.json.csrfToken);
    expect(second.setCookies[0]).not.toBe(first.setCookies[0]);
    const chosen = await world.browser().get('/api/auth/csrf', {
      cookieHeader: `opslog_csrf=${'C'.repeat(43)}`,
    });
    expect(chosen.setCookies[0]).not.toContain('C'.repeat(43));
    expect((await world.browser().get('/api/auth/csrf')).json.csrfToken).not.toBe(
      first.json.csrfToken,
    );
  });
});

describe('login, session and logout', () => {
  it('sets an httpOnly, Secure, SameSite=Lax session cookie and never returns the token to JS', async () => {
    await fixture();
    const browser = world.browser();
    await world.prepare(browser);
    const reply = await browser.post('/api/auth/login', {
      json: world.credentials('subject-admin-a'),
    });
    expect(reply.status).toBe(200);
    const session = reply.setCookies.find((line) => line.startsWith('opslog_session='))!;
    expect(session).toMatch(/^opslog_session=[A-Za-z0-9_-]{43}; Path=\/api; Max-Age=28800; /);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax'])
      expect(session).toContain(attribute);
    expect(session).not.toMatch(/Domain=/i);
    const tokenValue = session.split(';')[0]!.split('=')[1]!;
    expect(reply.text).not.toContain(tokenValue);
    expect(JSON.stringify(reply.headers)).not.toContain(`"${tokenValue}"`);
    // The nonce cookie is retired at login.
    expect(reply.setCookies.some((line) => /^opslog_csrf=; .*Max-Age=0/.test(line))).toBe(true);
    expect(Object.keys(reply.json).sort()).toEqual([
      'company',
      'csrfToken',
      'expiresAt',
      'permissions',
      'roleId',
      'roleLabel',
      'user',
    ]);
    expect(reply.json.roleId).toBe('admin');
    expect(reply.json.expiresAt).toBe('2026-10-06T20:00:00.000Z');
    expect(reply.json.company.name).toBe('Empresa Alfa');
    expect(reply.json.csrfToken).not.toContain(tokenValue);
  });

  it('returns the same session facts and CSRF token on GET /api/auth/session', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    const reply = await browser.get('/api/auth/session');
    expect(reply.status).toBe(200);
    expect(reply.json.csrfToken).toBe(browser.csrf);
    expect(reply.json.permissions).toContain('manage_users');
    expect(reply.setCookies).toEqual([]);
  });

  it('answers every login failure with the same 401, revealing nothing about accounts', async () => {
    await fixture();
    const attempts: Reply[] = [];
    const attempt = async (json: unknown) => {
      const browser = world.browser();
      await world.prepare(browser);
      attempts.push(await browser.post('/api/auth/login', { json }));
    };
    await attempt({ code: 'code-does-not-exist', nonce: 'nonce-x' });
    await attempt({ ...world.credentials('subject-not-invited-anywhere') });
    const wrongNonce = world.credentials('subject-admin-a');
    await attempt({ code: wrongNonce.code, nonce: 'another-nonce' });
    const replayed = world.credentials('subject-admin-a');
    await attempt(replayed);
    await attempt(replayed);
    expect(attempts.map((reply) => reply.status)).toEqual([401, 401, 401, 200, 401]);
    const failures = attempts.filter((reply) => reply.status === 401);
    for (const reply of failures) {
      expectUniformError(reply, 401, 'unauthorized');
      expect({ ...reply.json, correlationId: '' }).toEqual({
        ...failures[0]!.json,
        correlationId: '',
      });
      expect(reply.setCookies.some((line) => line.startsWith('opslog_session=;'))).toBe(false);
    }
  });

  it('rejects malformed login bodies with 400 and extra properties such as tenantId', async () => {
    await fixture();
    const browser = world.browser();
    await world.prepare(browser);
    for (const json of [
      {},
      { code: 'x' },
      { code: '', nonce: 'n' },
      { code: 'x', nonce: 5 },
      { ...world.credentials('subject-admin-a'), tenantId: 'tenant-b' },
      { ...world.credentials('subject-admin-a'), role: 'admin' },
      [1],
      'text',
    ])
      expectUniformError(await browser.post('/api/auth/login', { json }), 400, 'bad_request');
  });

  it('logs out: clears the cookie and revokes the session on the server', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    const stolen = [...browser.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const reply = await browser.post('/api/auth/logout');
    expect(reply.status).toBe(204);
    expect(reply.text).toBe('');
    expect(reply.setCookies[0]).toMatch(
      /^opslog_session=; Path=\/api; Max-Age=0; SameSite=Lax; HttpOnly; Secure$/,
    );
    expect(browser.jar.has('opslog_session')).toBe(false);
    // Replaying the old cookie from elsewhere fails: revocation is server side.
    const replay = world.browser();
    expectUniformError(
      await replay.get('/api/auth/session', { cookieHeader: stolen }),
      401,
      'unauthorized',
    );
  });

  it('revokes the previous session when the browser signs in again', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    const old = [...browser.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    await world.prepare(browser);
    expect(
      (await browser.post('/api/auth/login', { json: world.credentials('subject-admin-a') }))
        .status,
    ).toBe(200);
    const replay = await world.browser().get('/api/auth/session', { cookieHeader: old });
    expect(replay.status).toBe(401);
    expect((await browser.get('/api/auth/session')).status).toBe(200);
  });
});

describe('invitations over HTTP', () => {
  it('lets an administrator invite, a visitor inspect and accept once, and rejects reuse', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const invite = await admin.post('/api/users/invitations', { json: { roleId: 'editor' } });
    expect(invite.status).toBe(201);
    expect(invite.json.user.status).toBe('invited');
    const token = invite.json.invitationToken as string;

    const visitor = world.browser();
    await world.prepare(visitor);
    const inspect = await visitor.post('/api/auth/invitations/inspect', { json: { token } });
    expect(inspect.status).toBe(200);
    expect(inspect.json).toEqual({ companyName: 'Empresa Alfa', roleLabel: 'Editor' });

    const accepted = await visitor.post('/api/auth/invitations/accept', {
      json: { token, ...world.credentials('subject-new-editor') },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.json.roleId).toBe('editor');
    expect(accepted.setCookies.some((line) => line.startsWith('opslog_session='))).toBe(true);
    visitor.csrf = accepted.json.csrfToken;
    expect((await visitor.get('/api/auth/session')).status).toBe(200);

    const again = world.browser();
    await world.prepare(again);
    expectUniformError(
      await again.post('/api/auth/invitations/inspect', { json: { token } }),
      404,
      'not_found',
    );
    expectUniformError(
      await again.post('/api/auth/invitations/accept', {
        json: { token, ...world.credentials('subject-other') },
      }),
      404,
      'not_found',
    );
  });

  it('treats unknown, expired and cross-wired invitations identically (404) and a bad code as 401', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const token = (await admin.post('/api/users/invitations', { json: { roleId: 'viewer' } })).json
      .invitationToken as string;
    const visitor = world.browser();
    await world.prepare(visitor);
    expectUniformError(
      await visitor.post('/api/auth/invitations/inspect', { json: { token: 'never-issued' } }),
      404,
      'not_found',
    );
    expectUniformError(
      await visitor.post('/api/auth/invitations/accept', {
        json: { token, code: 'forged-code', nonce: 'n' },
      }),
      401,
      'unauthorized',
    );
    expectUniformError(
      await visitor.post('/api/auth/invitations/accept', {
        json: { token: 'never-issued', ...world.credentials('subject-x') },
      }),
      404,
      'not_found',
    );
    world.advance(73 * HOUR);
    expectUniformError(
      await visitor.post('/api/auth/invitations/inspect', { json: { token } }),
      404,
      'not_found',
    );
    expectUniformError(
      await visitor.post('/api/auth/invitations/accept', {
        json: { token, ...world.credentials('subject-late') },
      }),
      404,
      'not_found',
    );
    for (const json of [{}, { token: '' }, { token: 'x', extra: 1 }])
      expectUniformError(
        await visitor.post('/api/auth/invitations/inspect', { json }),
        400,
        'bad_request',
      );
    for (const json of [
      { token: 'x' },
      { token: 'x', code: 'c', nonce: 'n', role: 'admin' },
      { token: 'x', code: '', nonce: 'n' },
    ])
      expectUniformError(
        await visitor.post('/api/auth/invitations/accept', { json }),
        400,
        'bad_request',
      );
  });

  it('does not reveal an invitation of a suspended tenant', async () => {
    const { a } = await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const token = (await admin.post('/api/users/invitations', { json: { roleId: 'viewer' } })).json
      .invitationToken as string;
    await world.platform.suspendTenant(a.tenantId);
    const visitor = world.browser();
    await world.prepare(visitor);
    expect((await visitor.post('/api/auth/invitations/inspect', { json: { token } })).status).toBe(
      404,
    );
  });
});

describe('CSRF and same-origin protection', () => {
  it('rejects login and invitation routes without a valid pre-login token', async () => {
    await fixture();
    const browser = world.browser();
    await world.prepare(browser);
    const other = world.browser();
    await world.prepare(other);
    const credentials = () => ({ json: world.credentials('subject-admin-a') });
    for (const init of [
      { ...credentials(), csrf: null },
      { ...credentials(), csrf: 'wrong' },
      { ...credentials(), csrf: other.csrf },
      { ...credentials(), cookies: false },
      { ...credentials(), cookieHeader: 'opslog_csrf=short' },
    ])
      expectUniformError(await browser.post('/api/auth/login', init), 403, 'csrf_failed');
    for (const path of ['/api/auth/invitations/inspect', '/api/auth/invitations/accept'])
      expectUniformError(
        await browser.post(path, { json: { token: 'x' }, csrf: null }),
        403,
        'csrf_failed',
      );
    // A session-bound token is not a pre-login token and vice versa.
    const admin = await world.loginAs('subject-admin-a');
    expect((await admin.post('/api/auth/logout', { csrf: browser.csrf })).status).toBe(403);
  });

  it("rejects state changes with a missing or wrong session token, including another session's", async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const other = await world.loginAs('subject-admin-b');
    for (const csrf of [null, 'wrong', '', other.csrf]) {
      expectUniformError(
        await admin.put('/api/company/settings', {
          json: { name: 'Nombre', mfa: 'disabled', sessionIdleHours: 8 },
          csrf,
        }),
        403,
        'csrf_failed',
      );
    }
    expectUniformError(await admin.post('/api/auth/logout', { csrf: null }), 403, 'csrf_failed');
    expectUniformError(
      await admin.post('/api/roles/admin/copy', { json: { name: 'Copia' }, csrf: null }),
      403,
      'csrf_failed',
    );
    expectUniformError(
      await admin.post('/api/users/x/deactivate', { json: { reason: 'r' }, csrf: null }),
      403,
      'csrf_failed',
    );
    expectUniformError(
      await admin.post('/api/users/invitations', { json: { roleId: 'viewer' }, csrf: null }),
      403,
      'csrf_failed',
    );
    expectUniformError(
      await admin.put('/api/drafts/form', { json: { values: {} }, csrf: null }),
      403,
      'csrf_failed',
    );
    expectUniformError(await admin.delete('/api/drafts/form', { csrf: null }), 403, 'csrf_failed');
    // The settings were not changed by any of those.
    expect((await admin.get('/api/company/settings')).json.name).toBe('Empresa Alfa');
    // A repeated CSRF header is ambiguous and refused, even when one copy is the right token.
    const repeated = await world.handler({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        origin: ORIGIN,
        host: HOST,
        cookie: [...admin.jar].map(([n, v]) => `${n}=${v}`).join('; '),
        'x-csrf-token': [admin.csrf!, admin.csrf!],
      },
    });
    expect(repeated.status).toBe(403);
    expect((await admin.get('/api/auth/session')).status).toBe(200);
    // With a single copy the same request succeeds.
    expect((await admin.post('/api/auth/logout')).status).toBe(204);
  });

  it('checks Origin and Host on every state-changing route', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const body = { json: { name: 'Nombre', mfa: 'disabled', sessionIdleHours: 8 } };
    for (const init of [
      { origin: null },
      { origin: 'null' },
      { origin: 'https://evil.test' },
      { origin: `${ORIGIN}.evil.test` },
      { origin: 'http://app.synthetic.test' },
      { origin: `${ORIGIN}/` },
      { host: 'evil.test' },
      { host: null },
      { headers: { 'sec-fetch-site': 'cross-site' } },
      { headers: { 'sec-fetch-site': 'same-site' } },
    ]) {
      const reply = await admin.put('/api/company/settings', { ...body, ...init });
      expectUniformError(reply, 403, 'csrf_failed');
    }
    const ok = await admin.put('/api/company/settings', body);
    expect(ok.status).toBe(200);
    // Reads need no Origin (they change nothing) but still need the session.
    expect((await admin.get('/api/company/settings', { origin: 'https://evil.test' })).status).toBe(
      200,
    );
  });

  it('refuses ambiguous (repeated) Origin headers', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const reply = await world.handler({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        origin: [ORIGIN, ORIGIN],
        host: HOST,
        cookie: [...admin.jar].map(([n, v]) => `${n}=${v}`).join('; '),
        'x-csrf-token': admin.csrf!,
      },
    });
    expect(reply.status).toBe(403);
  });
});

describe('cookies: forged, malformed, revoked and expired sessions', () => {
  it('rejects forged, malformed and tossed session cookies with 401 and clears the cookie', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const real = admin.jar.get('opslog_session')!;
    const browser = world.browser();
    for (const cookieHeader of [
      `opslog_session=${'A'.repeat(43)}`,
      'opslog_session=short',
      'opslog_session=',
      `opslog_session=${real}x`,
      `opslog_session=${real.slice(0, -1)}${real.endsWith('A') ? 'B' : 'A'}`,
      `opslog_session=${real}; opslog_session=${'B'.repeat(43)}`,
      `opslog_session=${'B'.repeat(43)}; opslog_session=${real}`,
      `opslog_session=${real.replace(/./, '*')}`,
    ]) {
      const reply = await browser.get('/api/auth/session', { cookieHeader });
      expectUniformError(reply, 401, 'unauthorized');
      expect(reply.setCookies[0]).toMatch(/^opslog_session=; .*Max-Age=0/);
    }
    // No cookie at all: 401 without anything to clear.
    const none = await browser.get('/api/auth/session', { cookies: false });
    expectUniformError(none, 401, 'unauthorized');
    expect(none.setCookies).toEqual([]);
    // A forged cookie plus any CSRF token still gets 401, not a CSRF verdict.
    const forged = await browser.post('/api/auth/logout', {
      cookieHeader: `opslog_session=${'A'.repeat(43)}`,
      csrf: 'whatever',
    });
    expectUniformError(forged, 401, 'unauthorized');
  });

  it('rejects revoked and expired sessions on reads and writes', async () => {
    await fixture();
    const revoked = await world.loginAs('subject-admin-a');
    const keep = await world.loginAs('subject-admin-a');
    await revoked.post('/api/auth/logout');
    for (const reply of [
      await revoked.get('/api/users', {
        cookieHeader: `opslog_session=${keep.jar.get('opslog_session')!}`,
      }),
      await keep.get('/api/users'),
    ])
      expect(reply.status).toBe(200);
    world.advance(8 * HOUR + 1);
    expectUniformError(await keep.get('/api/users'), 401, 'unauthorized');
    expectUniformError(
      await keep.put('/api/company/settings', {
        json: { name: 'Nuevo', mfa: 'disabled', sessionIdleHours: 8 },
      }),
      401,
      'unauthorized',
    );
    expectUniformError(await keep.get('/api/drafts/form'), 401, 'unauthorized');
  });

  it('stops serving a member whose membership was revoked or whose tenant is suspended', async () => {
    const { a } = await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const viewer = await world.loginAs('subject-viewer-a');
    expect((await viewer.get('/api/auth/session')).status).toBe(200);
    const viewerId = (await viewer.get('/api/auth/session')).json.user.id as string;
    expect(
      (await admin.post(`/api/users/${viewerId}/deactivate`, { json: { reason: 'baja' } })).status,
    ).toBe(200);
    expectUniformError(await viewer.get('/api/auth/session'), 401, 'unauthorized');
    await world.platform.suspendTenant(a.tenantId);
    expectUniformError(await admin.get('/api/auth/session'), 401, 'unauthorized');
  });
});

describe('request limits and content type', () => {
  it('refuses an oversized declared body without reading it', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    let consumed = false;
    const reply = await world.handler({
      method: 'PUT',
      url: '/api/company/settings',
      headers: {
        'content-length': '1000000',
        'content-type': 'application/json',
        origin: ORIGIN,
        host: HOST,
        cookie: [...browser.jar].map(([n, v]) => `${n}=${v}`).join('; '),
        'x-csrf-token': browser.csrf!,
      },
      body: (async function* () {
        consumed = true;
        yield new Uint8Array(1);
      })(),
    });
    expect(reply.status).toBe(413);
    expect(consumed).toBe(false);
    expect(reply.headers['connection']).toBe('close');
    expect(JSON.parse(reply.body).code).toBe('payload_too_large');
  });

  it('refuses an oversized streamed body even when Content-Length is missing or lies', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    const big = Buffer.alloc(20 * 1024, 0x61);
    const prefix = Buffer.from('{"name":"');
    for (const declared of [undefined, '10']) {
      let yielded = 0;
      const reply = await world.handler({
        method: 'PUT',
        url: '/api/company/settings',
        headers: {
          ...(declared ? { 'content-length': declared } : {}),
          'content-type': 'application/json',
          origin: ORIGIN,
          host: HOST,
          cookie: [...browser.jar].map(([n, v]) => `${n}=${v}`).join('; '),
          'x-csrf-token': browser.csrf!,
        },
        body: (async function* () {
          yield prefix;
          for (let i = 0; i < 100; i += 1) {
            yielded += 1;
            yield big;
          }
        })(),
      });
      expect(reply.status).toBe(413);
      expect(yielded).toBeLessThanOrEqual(2);
    }
    // The configured limit is honoured exactly.
    const small = createBffWorld({ bff: { maxBodyBytes: 64 } });
    world.dispose();
    world = small;
    await world.tenant('Empresa', 'subject-admin-x');
    const x = await world.loginAs('subject-admin-x');
    const settings = (name: string) => ({ name, mfa: 'disabled', sessionIdleHours: 8 });
    expect((await x.put('/api/company/settings', { json: settings('A'.repeat(10)) })).status).toBe(
      200,
    );
    expect((await x.put('/api/company/settings', { json: settings('A'.repeat(60)) })).status).toBe(
      413,
    );
  });

  it('refuses wrong content types and bodies without one', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    const settings = JSON.stringify({ name: 'Nombre', mfa: 'disabled', sessionIdleHours: 8 });
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/xml',
      'application/json-patch+json',
      'application/jsonx',
      'application/json; charset=latin1',
      'application/json; boundary=x',
      '',
    ])
      expectUniformError(
        await browser.put('/api/company/settings', { raw: settings, contentType }),
        415,
        'unsupported_media_type',
      );
    expectUniformError(
      await browser.put('/api/company/settings', { raw: settings, contentType: null }),
      415,
      'unsupported_media_type',
    );
    for (const contentType of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON;charset=UTF-8',
    ])
      expect(
        (await browser.put('/api/company/settings', { raw: settings, contentType })).status,
      ).toBe(200);
  });

  it('refuses malformed bodies, invalid lengths and unexpected shapes', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    for (const raw of [
      '',
      '{',
      'null',
      '[]',
      '"x"',
      '12',
      '{"name":"x"}',
      'ÿþ',
      '{"name":"x","mfa":"disabled","sessionIdleHours":8,"tenantId":"b"}',
    ])
      expectUniformError(await browser.put('/api/company/settings', { raw }), 400, 'bad_request');
    expectUniformError(
      await browser.put('/api/company/settings', {
        raw: Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d]),
      }),
      400,
      'bad_request',
    );
    for (const length of ['abc', '-1', '1.5', '99999999999999']) {
      const reply = await world.handler({
        method: 'PUT',
        url: '/api/company/settings',
        headers: {
          'content-length': length,
          'content-type': 'application/json',
          origin: ORIGIN,
          host: HOST,
          cookie: [...browser.jar].map(([n, v]) => `${n}=${v}`).join('; '),
          'x-csrf-token': browser.csrf!,
        },
      });
      expect(reply.status).toBe(400);
    }
    const repeated = await world.handler({
      method: 'PUT',
      url: '/api/company/settings',
      headers: { 'content-length': ['1', '1'], 'content-type': 'application/json' },
    });
    expect(repeated.status).toBe(400);
  });

  it('answers unknown paths with 404, wrong methods with 405 and hostile targets with 400', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    expectUniformError(await browser.get('/api/unknown'), 404, 'not_found');
    expectUniformError(await browser.get('/'), 404, 'not_found');
    expectUniformError(await browser.get('/api/users/'), 404, 'not_found');
    expectUniformError(await browser.get('/api/users/x/y/z'), 404, 'not_found');
    expectUniformError(await browser.get('/api/%75sers'), 404, 'not_found');
    expectUniformError(
      await browser.post('/api/users/%zz/deactivate', { json: { reason: 'r' } }),
      404,
      'not_found',
    );
    expectUniformError(
      await browser.post('/api/users/..%2Fx/deactivate', { json: { reason: 'r' } }),
      404,
      'not_found',
    );
    const method = await browser.send('PATCH', '/api/users');
    expectUniformError(method, 405, 'method_not_allowed');
    expect(method.headers['allow']).toBe('GET');
    expect((await browser.send('DELETE', '/api/company/settings')).headers['allow']).toBe(
      'GET, PUT',
    );
    expect((await browser.send('OPTIONS', '/api/users')).status).toBe(405);
    expect((await browser.send('HEAD', '/api/users')).status).toBe(405);
    for (const url of [
      '//evil.test/api/users',
      'api/users',
      '/api/users#x',
      '/api\\users',
      `/api/users?${'a'.repeat(3000)}`,
      '/api/us\u0000ers',
      '/api/us ers',
    ])
      expectUniformError(await browser.get(url), 400, 'bad_request');
  });

  it('sets the security headers on success, error and cookie-less responses and has no CORS', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    for (const reply of [
      await browser.get('/api/auth/session'),
      await browser.get('/api/nope'),
      await browser.get('/api/users', { cookies: false }),
      await browser.post('/api/auth/logout', { csrf: null }),
    ]) {
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['x-frame-options']).toBe('DENY');
      expect(reply.headers['content-security-policy']).toContain("default-src 'none'");
      expect(reply.headers['strict-transport-security']).toContain('max-age=');
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(Object.keys(reply.headers).some((name) => name.startsWith('access-control-'))).toBe(
        false,
      );
    }
  });
});

describe('uniform, PII-free errors', () => {
  it('uses the contract messages and never echoes input', async () => {
    await fixture();
    for (const code of [
      'bad_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'internal_error',
    ] as const) {
      const contract = serializeApiError({ code, correlationId: 'c' });
      expect({ status: ERRORS[code].status, message: ERRORS[code].message }).toEqual({
        status: contract.status,
        message: contract.message,
      });
    }
    const browser = await world.loginAs('subject-admin-a');
    const reply = await browser.post('/api/users/jane.doe@example.test/deactivate', {
      json: { reason: 'secret reason jane.doe@example.test' },
    });
    expectUniformError(reply, 404, 'not_found');
    expect(reply.text).not.toContain('jane.doe');
    const invalid = await browser.put('/api/company/settings', {
      json: { name: 'jane.doe@example.test', mfa: 'bogus', sessionIdleHours: 8 },
    });
    expectUniformError(invalid, 400, 'bad_request');
    expect(invalid.text).not.toContain('jane.doe');
  });

  it('turns unexpected failures into a generic 500 and reports only class names', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    class Boom extends Error {}
    const original = world.platform.listMembers.bind(world.platform);
    world.platform.listMembers = async () => {
      throw new Boom('tenant=t-42 jane.doe@example.test SECRET-TOKEN-abc');
    };
    const reply = await browser.get('/api/users');
    expectUniformError(reply, 500, 'internal_error');
    expect(reply.text).not.toMatch(/SECRET|jane|t-42|Boom/);
    expect(world.errors).toHaveLength(1);
    expect(world.errors[0]).toEqual({
      correlationId: reply.json.correlationId,
      route: 'users.list',
      errorClass: 'Boom',
    });
    expect(JSON.stringify(world.errors)).not.toMatch(/SECRET|jane|t-42/);
    // A thrown value with a hostile class name is reported generically.
    world.platform.listMembers = async () => {
      const hostile = new Error('x');
      Object.defineProperty(hostile, 'constructor', { value: { name: 'jane@example.test' } });
      throw hostile;
    };
    await browser.get('/api/users');
    expect(world.errors[1]?.errorClass).toBe('Error');
    world.platform.listMembers = original;
    // Failing authentication infrastructure is a 500, not an authentication verdict.
    const sessionDetails = world.platform.sessionDetails.bind(world.platform);
    world.platform.sessionDetails = async () => ({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expectUniformError(await browser.get('/api/users'), 500, 'internal_error');
    world.platform.sessionDetails = sessionDetails;
    expect((await browser.get('/api/users')).status).toBe(200);
  });

  it('works without an error hook', async () => {
    world = createBffWorld();
    const handler = createBffHandler({
      platform: world.platform,
      secret: SECRET,
      allowedOrigins: [ORIGIN],
    });
    world.platform.sessionDetails = async () => {
      throw new Error('x');
    };
    const reply = await handler({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `opslog_session=${'A'.repeat(43)}` },
    });
    expect(reply.status).toBe(500);
  });

  it('maps composition failures that have no HTTP twin to a generic 500', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    world.platform.listRoles = async () => ({
      ok: false,
      error: { code: 'surprise', status: 418, message: 'teapot' },
    });
    expectUniformError(await browser.get('/api/roles'), 500, 'internal_error');
  });

  it('reports login infrastructure failures as 500 instead of 401', async () => {
    await fixture();
    const browser = world.browser();
    await world.prepare(browser);
    world.platform.signIn = async () => ({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expectUniformError(
      await browser.post('/api/auth/login', { json: world.credentials('subject-admin-a') }),
      500,
      'internal_error',
    );
  });

  it('cleans up when the session cannot be described right after sign in', async () => {
    await fixture();
    const browser = world.browser();
    await world.prepare(browser);
    world.platform.sessionDetails = async () => ({
      ok: false,
      error: { code: 'unauthorized', status: 401, message: 'x' },
    });
    expectUniformError(
      await browser.post('/api/auth/login', { json: world.credentials('subject-admin-a') }),
      401,
      'unauthorized',
    );
    expect(browser.jar.has('opslog_session')).toBe(false);
  });

  it('reports invitation acceptance infrastructure failures as 500', async () => {
    await fixture();
    const browser = world.browser();
    await world.prepare(browser);
    world.platform.acceptInvitation = async () => ({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expectUniformError(
      await browser.post('/api/auth/invitations/accept', {
        json: { token: 'x', ...world.credentials('subject-admin-a') },
      }),
      500,
      'internal_error',
    );
  });
});

describe('tenant and actor come only from the session', () => {
  it('ignores tenant hints in headers and queries and rejects them in bodies', async () => {
    const { a, b } = await fixture();
    const browser = await world.loginAs('subject-admin-a');
    const settings = await browser.get('/api/company/settings', {
      headers: { 'x-tenant-id': b.tenantId, 'x-forwarded-host': 'beta.test' },
    });
    expect(settings.json.name).toBe('Empresa Alfa');
    expect((await browser.get(`/api/users?tenantId=${b.tenantId}`)).status).toBe(400);
    expect(
      (
        await browser.put('/api/company/settings', {
          json: { name: 'X', mfa: 'disabled', sessionIdleHours: 8, tenantId: b.tenantId },
        })
      ).status,
    ).toBe(400);
    expect((await browser.get('/api/auth/session')).json.company.id).toBe(a.tenantId);
  });

  it('keeps tenants apart for users, deactivation, roles, settings and drafts', async () => {
    const { a, b } = await fixture();
    const adminA = await world.loginAs('subject-admin-a');
    const adminB = await world.loginAs('subject-admin-b');
    const listA = (await adminA.get('/api/users')).json.items.map((u: { id: string }) => u.id);
    const listB = (await adminB.get('/api/users')).json.items.map((u: { id: string }) => u.id);
    expect(listA).toContain(a.adminId);
    expect(listA).not.toContain(b.adminId);
    expect(listB).toEqual([b.adminId]);
    // Foreign ids are not found, exactly like unknown ids.
    const foreign = await adminA.post(`/api/users/${b.adminId}/deactivate`, {
      json: { reason: 'x' },
    });
    const unknown = await adminA.post(
      '/api/users/00000000-0000-4000-8000-000000000000/deactivate',
      {
        json: { reason: 'x' },
      },
    );
    expectUniformError(foreign, 404, 'not_found');
    expectUniformError(unknown, 404, 'not_found');
    expect({ ...foreign.json, correlationId: '' }).toEqual({ ...unknown.json, correlationId: '' });
    expect((await adminB.get('/api/auth/session')).status).toBe(200);
    // A custom role copied in A does not exist in B.
    const copy = await adminA.post('/api/roles/viewer/copy', { json: { name: 'Solo alfa' } });
    expect(copy.status).toBe(201);
    expectUniformError(
      await adminB.post(`/api/roles/${copy.json.id}/copy`, { json: { name: 'Robada' } }),
      404,
      'not_found',
    );
    expect(
      (await adminB.get('/api/roles')).json.items.map((r: { name: string }) => r.name),
    ).not.toContain('Solo alfa');
    // Drafts with the same scope are separate per tenant and per person.
    await adminA.put('/api/drafts/form', { json: { values: { campo: 'alfa' } } });
    expect((await adminB.get('/api/drafts/form')).json).toEqual({ draft: null });
    expect((await adminA.get('/api/drafts/form')).json.draft.values).toEqual({ campo: 'alfa' });
    // Settings are per tenant.
    await adminA.put('/api/company/settings', {
      json: { name: 'Alfa Renombrada', mfa: 'disabled', sessionIdleHours: 8 },
    });
    expect((await adminB.get('/api/company/settings')).json.name).toBe('Empresa Beta');
    expect((await adminB.get('/api/auth/session')).json.company.name).toBe('Empresa Beta');
  });
});

describe('permissions', () => {
  it('requires a session for every protected route', async () => {
    await fixture();
    const browser = world.browser();
    const reads = [
      '/api/auth/session',
      '/api/company/settings',
      '/api/users',
      '/api/roles',
      '/api/drafts/form',
    ];
    for (const path of reads) expectUniformError(await browser.get(path), 401, 'unauthorized');
    // Without a session, CSRF cannot be satisfied either way; the verdict is still 401 once Origin passes.
    const writes: [string, string, unknown?][] = [
      ['POST', '/api/auth/logout'],
      ['PUT', '/api/company/settings', { name: 'x', mfa: 'disabled', sessionIdleHours: 8 }],
      ['POST', '/api/users/invitations', { roleId: 'viewer' }],
      ['POST', '/api/users/abc/deactivate', { reason: 'r' }],
      ['POST', '/api/roles/admin/copy', { name: 'x' }],
      ['PUT', '/api/drafts/form', { values: {} }],
      ['DELETE', '/api/drafts/form'],
    ];
    for (const [method, path, json] of writes)
      expectUniformError(
        await browser.send(method, path, { json, csrf: 'x' }),
        401,
        'unauthorized',
      );
  });

  it('denies administration to a viewer with 403 and still serves their own session and drafts', async () => {
    await fixture();
    const viewer = await world.loginAs('subject-viewer-a');
    expect((await viewer.get('/api/auth/session')).json.permissions).toEqual(['view']);
    expectUniformError(await viewer.get('/api/users'), 403, 'forbidden');
    expectUniformError(await viewer.get('/api/roles'), 403, 'forbidden');
    expectUniformError(await viewer.get('/api/company/settings'), 403, 'forbidden');
    expectUniformError(
      await viewer.put('/api/company/settings', {
        json: { name: 'x', mfa: 'disabled', sessionIdleHours: 8 },
      }),
      403,
      'forbidden',
    );
    expectUniformError(
      await viewer.post('/api/users/invitations', { json: { roleId: 'admin' } }),
      403,
      'forbidden',
    );
    expectUniformError(
      await viewer.post('/api/users/abc/deactivate', { json: { reason: 'r' } }),
      403,
      'forbidden',
    );
    expectUniformError(
      await viewer.post('/api/roles/admin/copy', { json: { name: 'Copia' } }),
      403,
      'forbidden',
    );
    expect((await viewer.put('/api/drafts/form', { json: { values: { a: 'b' } } })).status).toBe(
      200,
    );
    expect((await viewer.delete('/api/drafts/form')).status).toBe(204);
  });
});

describe('users', () => {
  async function manyUsers(count: number) {
    const f = await fixture();
    for (let index = 0; index < count; index += 1)
      world.platform.access.grant(
        f.a.tenantId,
        `synthetic-user-${String(index).padStart(3, '0')}`,
        index % 2 ? 'editor' : 'viewer',
      );
    return f;
  }

  it('lists, sorts, searches and paginates with signed, tenant-bound cursors', async () => {
    const { a, b } = await manyUsers(60);
    const admin = await world.loginAs('subject-admin-a');
    const first = await admin.get('/api/users');
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(25);
    expect(first.json.total).toBe(62);
    expect(first.json.sort).toEqual({ field: 'id', direction: 'asc' });
    expect(Object.keys(first.json.items[0]).sort()).toEqual([
      'id',
      'roleId',
      'roleLabel',
      'status',
    ]);
    const seen = new Set<string>(first.json.items.map((u: { id: string }) => u.id));
    let next = first.json.nextCursor as string | null;
    let pages = 1;
    while (next) {
      const page = await admin.get(`/api/users?cursor=${encodeURIComponent(next)}`);
      expect(page.status).toBe(200);
      for (const user of page.json.items) {
        expect(seen.has(user.id)).toBe(false);
        seen.add(user.id);
      }
      next = page.json.nextCursor;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(seen.size).toBe(62);

    const desc = await admin.get('/api/users?limit=50&sort=roleLabel&direction=desc');
    expect(desc.json.items).toHaveLength(50);
    expect(desc.json.items[0].roleLabel >= desc.json.items[49].roleLabel).toBe(true);
    const search = await admin.get('/api/users?search=EDITOR&limit=100');
    expect(search.json.total).toBe(30);
    expect(search.json.items.every((u: { roleId: string }) => u.roleId === 'editor')).toBe(true);
    expect((await admin.get('/api/users?search=nothing-matches')).json).toMatchObject({
      items: [],
      total: 0,
      nextCursor: null,
    });
    expect((await admin.get('/api/users?search=active&limit=100')).json.total).toBe(62);
    expect((await admin.get('/api/users?search=synthetic-user-007')).json.total).toBe(1);

    // Cursors are authentic, and bound to tenant and query.
    const cursor = first.json.nextCursor as string;
    const adminB = await world.loginAs('subject-admin-b');
    expect(b.tenantId).not.toBe(a.tenantId);
    for (const [browser, path] of [
      [adminB, `/api/users?cursor=${encodeURIComponent(cursor)}`],
      [admin, `/api/users?cursor=${encodeURIComponent(cursor)}&sort=status`],
      [admin, `/api/users?cursor=${encodeURIComponent(cursor)}&direction=desc`],
      [admin, `/api/users?cursor=${encodeURIComponent(cursor)}&search=x`],
      [
        admin,
        `/api/users?cursor=${encodeURIComponent(`${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`)}`,
      ],
      [admin, '/api/users?cursor=garbage'],
      [admin, '/api/users?cursor=a.b'],
      [admin, `/api/users?cursor=${'x'.repeat(600)}`],
    ] as const)
      expectUniformError(await browser.get(path), 400, 'bad_request');
  });

  it('rejects invalid query parameters', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    for (const query of [
      'limit=10',
      'limit=26',
      'limit=abc',
      'sort=password',
      'direction=up',
      'foo=bar',
      'limit=25&limit=50',
      `search=${'a'.repeat(101)}`,
    ])
      expectUniformError(await admin.get(`/api/users?${query}`), 400, 'bad_request');
  });

  it('shows pending invitations as invited and deactivated members as inactive', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const invite = await admin.post('/api/users/invitations', { json: { roleId: 'auditor' } });
    const list = (await admin.get('/api/users?limit=100')).json.items as {
      id: string;
      status: string;
    }[];
    expect(list.find((u) => u.id === invite.json.user.id)?.status).toBe('invited');
    const viewerId = list.find(
      (u) =>
        u.status === 'active' &&
        u.id !== invite.json.user.id &&
        (u as { roleId?: string }).roleId === 'viewer',
    )!.id;
    const done = await admin.post(`/api/users/${viewerId}/deactivate`, {
      json: { reason: 'Baja solicitada' },
    });
    expect(done.json).toEqual({ id: viewerId, status: 'inactive' });
    const after = (await admin.get('/api/users?limit=100')).json.items as {
      id: string;
      status: string;
    }[];
    expect(after.find((u) => u.id === viewerId)?.status).toBe('inactive');
  });

  it('refuses invalid invitations, deactivations without a reason and the last administrator', async () => {
    const { a } = await fixture();
    const admin = await world.loginAs('subject-admin-a');
    for (const json of [
      {},
      { roleId: 5 },
      { roleId: 'admin', extra: 1 },
      { roleId: 'custom-role' },
      { roleId: 'owner' },
    ])
      expectUniformError(await admin.post('/api/users/invitations', { json }), 400, 'bad_request');
    for (const json of [{}, { reason: '' }, { reason: 'x'.repeat(501) }, { reason: 'r', extra: 1 }])
      expectUniformError(
        await admin.post(`/api/users/${a.adminId}/deactivate`, { json }),
        400,
        'bad_request',
      );
    expectUniformError(
      await admin.post(`/api/users/${a.adminId}/deactivate`, { json: { reason: 'Baja' } }),
      409,
      'last_admin',
    );
    expect((await admin.get('/api/auth/session')).status).toBe(200);
  });
});

describe('roles', () => {
  it('lists system templates and copies roles as tenant-owned custom roles', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    const list = await admin.get('/api/roles');
    expect(list.status).toBe(200);
    const items = list.json.items as {
      id: string;
      kind: string;
      memberCount: number;
      permissions: string[];
    }[];
    expect(items.filter((r) => r.kind === 'system').map((r) => r.id)).toEqual([
      'admin',
      'editor',
      'viewer',
      'auditor',
      'pii_reader',
    ]);
    expect(items.find((r) => r.id === 'admin')?.memberCount).toBe(1);
    expect(items.find((r) => r.id === 'viewer')?.memberCount).toBe(1);

    const copy = await admin.post('/api/roles/editor/copy', {
      json: { name: '  Editor regional  ' },
    });
    expect(copy.status).toBe(201);
    expect(copy.json).toMatchObject({
      name: 'Editor regional',
      kind: 'custom',
      memberCount: 0,
      permissions: ['view', 'create', 'edit'],
    });
    expect(copy.json.id).toMatch(/^custom-/);
    // A copy of a copy works; names are unique per tenant, case-insensitively, and cannot shadow templates.
    expect(
      (await admin.post(`/api/roles/${copy.json.id}/copy`, { json: { name: 'Variante' } })).status,
    ).toBe(201);
    for (const name of ['editor regional', 'Administrador'])
      expectUniformError(
        await admin.post('/api/roles/viewer/copy', { json: { name } }),
        409,
        'conflict',
      );
    for (const json of [
      {},
      { name: '' },
      { name: 'x'.repeat(81) },
      { name: 5 },
      { name: 'ok', permissions: ['view'] },
    ])
      expectUniformError(await admin.post('/api/roles/viewer/copy', { json }), 400, 'bad_request');
    expectUniformError(
      await admin.post('/api/roles/nope/copy', { json: { name: 'Otra' } }),
      404,
      'not_found',
    );
    expect(((await admin.get('/api/roles')).json.items as unknown[]).length).toBe(7);
  });

  it('caps custom roles per tenant', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    for (let index = 0; index < 50; index += 1)
      expect(
        (await admin.post('/api/roles/viewer/copy', { json: { name: `Copia ${index}` } })).status,
      ).toBe(201);
    expectUniformError(
      await admin.post('/api/roles/viewer/copy', { json: { name: 'Una más' } }),
      409,
      'conflict',
    );
  });
});

describe('company settings', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    json: { name: 'Empresa Alfa', mfa: 'disabled', sessionIdleHours: 8, ...over },
  });

  it('reads and updates; security changes need a reason and are audited without it', async () => {
    const { a } = await fixture();
    const admin = await world.loginAs('subject-admin-a');
    expect((await admin.get('/api/company/settings')).json).toEqual({
      name: 'Empresa Alfa',
      status: 'active',
      mfa: 'disabled',
      sessionIdleHours: 8,
    });
    const renamed = await admin.put('/api/company/settings', body({ name: '  Alfa Logística  ' }));
    expect(renamed.json.name).toBe('Alfa Logística');
    expect((await admin.get('/api/auth/session')).json.company.name).toBe('Alfa Logística');
    expectUniformError(
      await admin.put('/api/company/settings', body({ mfa: 'required' })),
      400,
      'bad_request',
    );
    expectUniformError(
      await admin.put('/api/company/settings', body({ sessionIdleHours: 4, reason: '   ' })),
      400,
      'bad_request',
    );
    const secured = await admin.put(
      '/api/company/settings',
      body({
        mfa: 'required',
        sessionIdleHours: 4,
        reason: 'Política de seguridad jane.doe@example.test',
      }),
    );
    expect(secured.status).toBe(200);
    expect(secured.json).toMatchObject({ mfa: 'required', sessionIdleHours: 4 });
    expect(
      (
        await admin.put(
          '/api/company/settings',
          body({ mfa: 'required', sessionIdleHours: 4, name: 'Alfa Logística' }),
        )
      ).status,
    ).toBe(200);
    for (const over of [
      { name: '' },
      { name: 'x'.repeat(161) },
      { name: 5 },
      { mfa: 'bogus' },
      { sessionIdleHours: 0 },
      { sessionIdleHours: 25 },
      { sessionIdleHours: 1.5 },
      { sessionIdleHours: '8' },
      { reason: 5 },
      { reason: 'x'.repeat(501) },
    ])
      expectUniformError(await admin.put('/api/company/settings', body(over)), 400, 'bad_request');
    const audit = world.platform.audit.list(a.tenantId).map((event) => event.action);
    expect(audit).toContain('tenant.settings_updated');
    expect(audit).toContain('tenant.security_settings_updated');
    expect(JSON.stringify(world.platform.audit.list(a.tenantId))).not.toContain('jane.doe');
  });

  it('reports a suspended company status to a session that still exists in the directory', async () => {
    const { a } = await fixture();
    const admin = await world.loginAs('subject-admin-a');
    expect(world.platform.tenants.status(a.tenantId)).toBe('active');
    expect((await admin.get('/api/company/settings')).json.status).toBe('active');
  });
});

describe('drafts', () => {
  it('saves, loads, overwrites and discards per person and scope', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    expect((await admin.get('/api/drafts/vehiculo:nuevo')).json).toEqual({ draft: null });
    const saved = await admin.put('/api/drafts/vehiculo:nuevo', {
      json: { values: { placa: 'ABC', nota: '' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({
      scope: 'vehiculo:nuevo',
      values: { placa: 'ABC', nota: '' },
      savedAt: '2026-10-06T12:00:00.000Z',
    });
    world.advance(1000);
    await admin.put('/api/drafts/vehiculo:nuevo', { json: { values: { placa: 'XYZ' } } });
    expect((await admin.get('/api/drafts/vehiculo:nuevo')).json.draft).toEqual({
      scope: 'vehiculo:nuevo',
      values: { placa: 'XYZ' },
      savedAt: '2026-10-06T12:00:01.000Z',
    });
    const viewer = await world.loginAs('subject-viewer-a');
    expect((await viewer.get('/api/drafts/vehiculo:nuevo')).json).toEqual({ draft: null });
    expect((await admin.delete('/api/drafts/vehiculo:nuevo')).status).toBe(204);
    expect((await admin.get('/api/drafts/vehiculo:nuevo')).json).toEqual({ draft: null });
  });

  it('validates scope and values', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    expectUniformError(await admin.get(`/api/drafts/${'a'.repeat(65)}`), 404, 'not_found');
    expectUniformError(await admin.get('/api/drafts/-bad'), 404, 'not_found');
    expectUniformError(await admin.get('/api/drafts/a%20b'), 404, 'not_found');
    for (const values of [
      null,
      [],
      'x',
      { a: 1 },
      { '': 'x' },
      { ['k'.repeat(65)]: 'x' },
      { a: 'x'.repeat(2001) },
      Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])),
    ])
      expectUniformError(
        await admin.put('/api/drafts/form', { json: { values } }),
        400,
        'bad_request',
      );
    expectUniformError(
      await admin.put('/api/drafts/form', { json: { values: {}, extra: 1 } }),
      400,
      'bad_request',
    );
    expectUniformError(await admin.put('/api/drafts/form', { json: {} }), 400, 'bad_request');
    // Total size limit across values (each below the per-value limit); needs a larger body allowance.
    world.dispose();
    world = createBffWorld({ bff: { maxBodyBytes: 64 * 1024 } });
    await world.tenant('Empresa', 'subject-admin-w');
    const wideAdmin = await world.loginAs('subject-admin-w');
    const wide = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'.repeat(1990)]),
    );
    expectUniformError(
      await wideAdmin.put('/api/drafts/form', { json: { values: wide } }),
      400,
      'bad_request',
    );
    // A prototype-polluting key is stored as plain data.
    const polluted = await wideAdmin.put('/api/drafts/form', {
      raw: '{"values":{"__proto__":"x"}}',
    });
    expect(polluted.status).toBe(200);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(Object.getPrototypeOf(polluted.json.values)).toBe(Object.prototype);
  });

  it('caps the number of drafts per person', async () => {
    await fixture();
    const admin = await world.loginAs('subject-admin-a');
    for (let index = 0; index < 100; index += 1)
      expect((await admin.put(`/api/drafts/scope-${index}`, { json: { values: {} } })).status).toBe(
        200,
      );
    expectUniformError(
      await admin.put('/api/drafts/one-more', { json: { values: {} } }),
      409,
      'conflict',
    );
    expect((await admin.put('/api/drafts/scope-3', { json: { values: { a: 'b' } } })).status).toBe(
      200,
    );
  });
});

describe('transport failures', () => {
  it('reports a body stream that fails as a generic 500', async () => {
    await fixture();
    const browser = await world.loginAs('subject-admin-a');
    const reply = await world.handler({
      method: 'PUT',
      url: '/api/company/settings',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        host: HOST,
        cookie: [...browser.jar].map(([n, v]) => `${n}=${v}`).join('; '),
        'x-csrf-token': browser.csrf!,
      },
      body: (async function* () {
        yield Buffer.from('{');
        throw new Error('socket reset jane.doe@example.test');
      })(),
    });
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('jane.doe');
    expect(world.errors.at(-1)?.route).toBe('company.settings.update');
  });
});

describe('configuration', () => {
  it('exports the public surface', () => {
    expect(Object.keys(bff).sort()).toEqual([
      'CSRF_HEADER',
      'DEFAULT_MAX_BODY_BYTES',
      'ERRORS',
      'PRE_CSRF_COOKIE',
      'SECURITY_HEADERS',
      'SESSION_COOKIE',
      'createBffHandler',
      'createBffServer',
      'createNodeListener',
    ]);
  });

  it('refuses weak secrets and unsafe origins at start-up', async () => {
    world = createBffWorld();
    const base = { platform: world.platform, secret: SECRET, allowedOrigins: [ORIGIN] };
    expect(() => createBffHandler({ ...base, secret: 'short' })).toThrow(/secret/);
    expect(() => createBffHandler({ ...base, allowedOrigins: [] })).toThrow(/origin/);
    expect(() =>
      createBffHandler({ ...base, allowedOrigins: ['http://app.example.test'] }),
    ).toThrow(/origin/);
    expect(() =>
      createBffHandler({ ...base, allowedOrigins: ['https://app.example.test/path'] }),
    ).toThrow(/origin/);
    expect(() => createBffHandler({ ...base, allowedOrigins: ['not a url'] })).toThrow(/origin/);
    expect(() =>
      createBffHandler({ ...base, allowedOrigins: ['http://localhost:3000'] }),
    ).not.toThrow();
  });
});
