import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBffClient, CSRF_HEADER, type FetchLike } from './index.js';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = { status: number; body?: unknown; raw?: string; correlation?: string | null };

/** Scripted transport: replies come from `handler`, requests are recorded. */
function transport(handler: (seen: Seen, count: number) => Reply | Error) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const entry: Seen = { method: init.method, url, headers: init.headers, body: init.body };
    seen.push(entry);
    const reply = handler(entry, seen.length);
    if (reply instanceof Error) throw reply;
    const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    const correlation = reply.correlation === undefined ? 'corr-1' : reply.correlation;
    return {
      status: reply.status,
      headers: { get: (name: string) => (name === 'x-correlation-id' ? correlation : null) },
      text: async () => text,
    };
  };
  return { fetch, seen };
}

const session = (csrfToken: string) => ({
  company: { id: 'c', name: 'Empresa' },
  user: { id: 'u' },
  roleId: 'admin',
  roleLabel: 'Administrador',
  permissions: ['view'],
  expiresAt: '2026-10-06T20:00:00.000Z',
  csrfToken,
});
const errorBody = (code: string, status: number) => ({
  code,
  status,
  message: 'x',
  correlationId: 'corr-server',
});

afterEach(() => vi.unstubAllGlobals());

describe('BFF client: CSRF handshake', () => {
  it('fetches the pre-login token once, sends it on pre-session calls and swaps it for the session token', async () => {
    const { fetch, seen } = transport(({ url }) => {
      if (url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'pre-1' } };
      if (url === '/api/auth/login') return { status: 200, body: session('session-1') };
      if (url === '/api/users/invitations')
        return { status: 201, body: { user: {}, invitationToken: 't', expiresAt: 'x' } };
      return { status: 500 };
    });
    const client = createBffClient({ fetch });
    const login = await client.call('auth.login', { body: { code: 'c', nonce: 'n' } });
    expect(login.ok).toBe(true);
    await client.call('users.invite', { body: { roleId: 'viewer' } });
    expect(seen.map((entry) => entry.url)).toEqual([
      '/api/auth/csrf',
      '/api/auth/login',
      '/api/users/invitations',
    ]);
    expect(seen[1]?.headers[CSRF_HEADER]).toBe('pre-1');
    expect(seen[1]?.headers['content-type']).toBe('application/json');
    expect(seen[1]?.body).toBe(JSON.stringify({ code: 'c', nonce: 'n' }));
    expect(seen[2]?.headers[CSRF_HEADER]).toBe('session-1');
  });

  it('learns the session token from the session when the page was reloaded', async () => {
    const { fetch, seen } = transport(({ url }) =>
      url === '/api/auth/session' ? { status: 200, body: session('session-2') } : { status: 204 },
    );
    const client = createBffClient({ fetch });
    expect((await client.call('drafts.discard', { params: { scope: 'a b' } })).ok).toBe(true);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/auth/session',
      'DELETE /api/drafts/a%20b',
    ]);
    expect(seen[1]?.headers[CSRF_HEADER]).toBe('session-2');
    expect(seen[0]?.headers[CSRF_HEADER]).toBeUndefined();
    expect(seen[0]?.body).toBeUndefined();
  });

  it('returns the session failure when the token cannot be learned', async () => {
    const { fetch, seen } = transport(() => ({
      status: 401,
      body: errorBody('unauthorized', 401),
    }));
    const client = createBffClient({ fetch });
    expect(await client.call('auth.logout')).toMatchObject({ ok: false, error: { status: 401 } });
    expect(seen).toHaveLength(1);
  });

  it('returns the failure when the pre-login token cannot be fetched', async () => {
    const { fetch } = transport(() => ({ status: 500, body: errorBody('internal_error', 500) }));
    const client = createBffClient({ fetch });
    expect(await client.call('auth.login', { body: { code: 'c', nonce: 'n' } })).toMatchObject({
      ok: false,
      error: { code: 'internal_error', status: 500 },
    });
  });

  it('refreshes a rejected pre-login token once and retries', async () => {
    let tokens = 0;
    const { fetch, seen } = transport(({ url, headers }) => {
      if (url === '/api/auth/csrf') return { status: 200, body: { csrfToken: `pre-${++tokens}` } };
      return headers[CSRF_HEADER] === 'pre-2'
        ? { status: 200, body: session('s') }
        : { status: 403, body: errorBody('csrf_failed', 403) };
    });
    const client = createBffClient({ fetch });
    expect((await client.call('auth.login', { body: { code: 'c', nonce: 'n' } })).ok).toBe(true);
    expect(seen.map((entry) => entry.url)).toEqual([
      '/api/auth/csrf',
      '/api/auth/login',
      '/api/auth/csrf',
      '/api/auth/login',
    ]);
  });

  it('refreshes a rejected session token once, then gives up on a second rejection', async () => {
    let sessions = 0;
    const { fetch, seen } = transport(({ url }) =>
      url === '/api/auth/session'
        ? { status: 200, body: session(`s-${++sessions}`) }
        : { status: 403, body: errorBody('csrf_failed', 403) },
    );
    const client = createBffClient({ fetch });
    expect(
      await client.call('company.settings.update', {
        body: { name: 'n', mfa: 'optional', sessionIdleHours: 8 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'csrf_failed', status: 403 } });
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/auth/session',
      'PUT /api/company/settings',
      'GET /api/auth/session',
      'PUT /api/company/settings',
    ]);
  });

  it('stops retrying when the refresh itself fails', async () => {
    let first = true;
    const { fetch } = transport(({ url }) => {
      if (url === '/api/auth/session') {
        const reply = first
          ? { status: 200, body: session('s') }
          : { status: 401, body: errorBody('unauthorized', 401) };
        first = false;
        return reply;
      }
      return { status: 403, body: errorBody('csrf_failed', 403) };
    });
    const client = createBffClient({ fetch });
    expect(await client.call('auth.logout')).toMatchObject({ ok: false, error: { status: 401 } });
  });

  it('forgets the session token after a 401 and after logout', async () => {
    let step = 0;
    const { fetch, seen } = transport(({ url }) => {
      if (url === '/api/auth/session') return { status: 200, body: session(`s-${++step}`) };
      if (url === '/api/users') return { status: 401, body: errorBody('unauthorized', 401) };
      return { status: 204 };
    });
    const client = createBffClient({ fetch });
    await client.call('auth.session');
    expect((await client.call('users.list')).ok).toBe(false);
    await client.call('auth.logout');
    // The token was dropped by the 401, so logout learned a fresh one, then dropped it again.
    await client.call('auth.logout');
    expect(seen.filter((entry) => entry.url === '/api/auth/session')).toHaveLength(3);
  });
});

describe('BFF client: requests and responses', () => {
  it('builds query strings, honours the base URL and sends same-origin credentials', async () => {
    const calls: unknown[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([url, init.credentials, init.cache, init.headers['accept']]);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            items: [],
            nextCursor: null,
            total: 0,
            sort: { field: 'id', direction: 'asc' },
          }),
      };
    };
    const client = createBffClient({ baseUrl: 'https://app.example', fetch });
    await client.call('users.list', { query: { limit: 25, search: 'a b', sort: 'status' } });
    await client.call('users.list');
    expect(calls).toEqual([
      [
        'https://app.example/api/users?limit=25&search=a+b&sort=status',
        'same-origin',
        'no-store',
        'application/json',
      ],
      ['https://app.example/api/users', 'same-origin', 'no-store', 'application/json'],
    ]);
  });

  it('uses the global fetch by default', async () => {
    const stub = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ csrfToken: 'x' }),
    }));
    vi.stubGlobal('fetch', stub);
    const result = await createBffClient().call('auth.csrf');
    expect(result).toEqual({ ok: true, value: { csrfToken: 'x' } });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('maps uniform error bodies to ApiError and keeps the server correlation id', async () => {
    const { fetch } = transport(() => ({ status: 409, body: errorBody('last_admin', 409) }));
    const result = await createBffClient({ fetch }).call('roles.list');
    expect(result).toEqual({
      ok: false,
      error: { code: 'last_admin', status: 409, message: 'x', correlationId: 'corr-server' },
    });
  });

  it.each([
    [405, 'method_not_allowed', 400],
    [413, 'payload_too_large', 400],
    [415, 'unsupported_media_type', 400],
  ] as const)(
    'reads status %i as a bad request for the shared ApiError type',
    async (status, code, expected) => {
      const { fetch } = transport(() => ({ status, body: errorBody(code, status) }));
      expect(await createBffClient({ fetch }).call('roles.list')).toMatchObject({
        ok: false,
        error: { code, status: expected },
      });
    },
  );

  it.each([
    [502, 500],
    [418, 400],
  ] as const)(
    'treats an unexpected status %i without an error body as invalid_response',
    async (status, expected) => {
      const { fetch } = transport(() => ({ status, correlation: null }));
      expect(await createBffClient({ fetch }).call('roles.list')).toMatchObject({
        ok: false,
        error: { code: 'invalid_response', status: expected, correlationId: 'client' },
      });
    },
  );

  it('treats a body that is not JSON as an invalid response', async () => {
    const { fetch } = transport(() => ({ status: 200, raw: 'oops' }));
    expect(await createBffClient({ fetch }).call('roles.list')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response', status: 500 },
    });
  });

  it('rejects a success status the contract does not declare', async () => {
    const { fetch } = transport(() => ({ status: 201, body: { items: [] } }));
    expect(await createBffClient({ fetch }).call('roles.list')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });

  it('reports network failures and unreadable bodies as failures, never exceptions', async () => {
    const offline = transport(() => new Error('offline'));
    expect(await createBffClient({ fetch: offline.fetch }).call('roles.list')).toMatchObject({
      ok: false,
      error: { code: 'network_error', status: 500 },
    });
    const broken: FetchLike = async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => {
        throw new Error('stream');
      },
    });
    expect(await createBffClient({ fetch: broken }).call('roles.list')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });
});
