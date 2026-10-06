import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAreasClient,
  createBffClient,
  createDocumentsClient,
  createAssignmentsClient,
  createImportsClient,
  createInsuranceClient,
  createEmployeesClient,
  createVehiclesClient,
  CSRF_HEADER,
  type FetchLike,
} from './index.js';

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

describe('BFF client: token bodies and concurrency', () => {
  it.each(['auth.csrf', 'auth.session'] as const)(
    'fails with invalid_response for an empty 200 body on %s',
    async (id) => {
      const { fetch } = transport(() => ({ status: 200 }));
      expect(await createBffClient({ fetch }).call(id)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' },
      });
    },
  );

  it('fails when a token-bearing body has no string csrfToken, also inside ensurePre', async () => {
    const bad = transport(() => ({ status: 200, body: { csrfToken: 5 } }));
    expect(
      await createBffClient({ fetch: bad.fetch }).call('auth.login', {
        body: { code: 'c', nonce: 'n' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    const nullBody = transport(() => ({ status: 200, raw: 'null' }));
    expect(await createBffClient({ fetch: nullBody.fetch }).call('auth.csrf')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });

  it('shares one in-flight auth.csrf exchange between concurrent callers', async () => {
    const { fetch, seen } = transport(({ url }) =>
      url === '/api/auth/csrf'
        ? { status: 200, body: { csrfToken: 'pre' } }
        : { status: 200, body: { companyName: 'x', roleLabel: 'y' } },
    );
    const client = createBffClient({ fetch });
    const results = await Promise.all([
      client.call('auth.invitation.inspect', { body: { token: 'a' } }),
      client.call('auth.invitation.inspect', { body: { token: 'b' } }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(seen.filter((entry) => entry.url === '/api/auth/csrf')).toHaveLength(1);
  });

  it('clears the in-flight exchange after a failure so the next call retries', async () => {
    let calls = 0;
    const { fetch } = transport(({ url }) => {
      if (url !== '/api/auth/csrf')
        return { status: 200, body: { companyName: 'x', roleLabel: 'y' } };
      calls += 1;
      return calls === 1
        ? { status: 500, body: errorBody('internal_error', 500) }
        : { status: 200, body: { csrfToken: 'pre' } };
    });
    const client = createBffClient({ fetch });
    expect((await client.call('auth.invitation.inspect', { body: { token: 'a' } })).ok).toBe(false);
    expect((await client.call('auth.invitation.inspect', { body: { token: 'a' } })).ok).toBe(true);
  });
});

describe('BFF client: another tab changed the signed-in person', () => {
  const as = (user: string, company: string, token: string) => ({
    status: 200,
    body: { ...session(token), user: { id: user }, company: { id: company, name: company } },
  });

  it('does not replay a write after a refresh that shows a different person or company', async () => {
    let current = as('admin-a', 'alfa', 'token-a');
    const { fetch, seen } = transport(({ url, headers }) => {
      if (url === '/api/auth/login') return current;
      if (url === '/api/auth/session') return current;
      // Writes carry the stale token: the BFF rejects it with csrf_failed.
      return headers[CSRF_HEADER] === 'token-b'
        ? { status: 200, body: {} }
        : { status: 403, body: errorBody('csrf_failed', 403) };
    });
    const client = createBffClient({ fetch });
    await client.call('auth.session');
    current = as('admin-b', 'beta', 'token-b');
    const result = await client.call('drafts.save', {
      params: { scope: 's' },
      body: { values: { a: 'b' } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized', status: 401 } });
    expect(seen.filter((entry) => entry.method === 'PUT')).toHaveLength(1);
  });

  it('adopts the new person only through an explicit session read, and replays for the same person', async () => {
    let current = as('admin-a', 'alfa', 'token-a');
    let rotated = false;
    const { fetch } = transport(({ url, headers }) => {
      if (url === '/api/auth/session') return current;
      return rotated && headers[CSRF_HEADER] === 'token-a2'
        ? { status: 200, body: { scope: 's', values: {}, savedAt: 'x' } }
        : { status: 403, body: errorBody('csrf_failed', 403) };
    });
    const client = createBffClient({ fetch });
    await client.call('auth.session');
    rotated = true;
    current = as('admin-a', 'alfa', 'token-a2');
    expect(
      (await client.call('drafts.save', { params: { scope: 's' }, body: { values: {} } })).ok,
    ).toBe(true);
    current = as('admin-b', 'beta', 'token-b');
    expect((await client.call('auth.session')).ok).toBe(true);
    rotated = false;
    expect(
      (await client.call('drafts.save', { params: { scope: 's' }, body: { values: {} } })).ok,
    ).toBe(false);
  });
});

describe('vehicles client', () => {
  it('maps each method to its route, method and path, and exposes the colliding field', async () => {
    const { fetch, seen } = transport((request) => {
      if (request.url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'tok' } };
      if (request.url === '/api/auth/session') return { status: 200, body: session('tok') };
      if (request.method === 'POST' && request.url === '/api/vehicles/v1/odometer')
        return { status: 409, body: { ...errorBody('duplicate', 409), field: 'plate' } };
      return { status: 200, body: { items: [], total: 0 } };
    });
    const vehicles = createVehiclesClient(createBffClient({ fetch }));
    await vehicles.list();
    await vehicles.list({ status: 'inactive' });
    await vehicles.get('v1');
    await vehicles.history('v1');
    await vehicles.create({
      economicNumber: 'U-1',
      plate: 'A1',
      vin: null,
      make: 'm',
      model: 'm',
      year: 2020,
      areaId: 'a',
      odometerKm: 0,
    });
    await vehicles.update('v1', { version: 1, make: 'x' });
    await vehicles.changeStatus('v1', { version: 1, status: 'inactive', reason: 'x' });
    await vehicles.archive('v1', 1);
    const clash = await vehicles.recordOdometer('v1', { version: 1, odometerKm: 5 });
    expect(clash).toMatchObject({
      ok: false,
      error: { code: 'duplicate', fieldErrors: [{ field: 'plate' }] },
    });
    const calls = seen.filter((entry) => !entry.url.startsWith('/api/auth/'));
    expect(calls.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/vehicles',
      'GET /api/vehicles?status=inactive',
      'GET /api/vehicles/v1',
      'GET /api/vehicles/v1/history',
      'POST /api/vehicles',
      'PUT /api/vehicles/v1',
      'POST /api/vehicles/v1/status',
      'POST /api/vehicles/v1/archive',
      'POST /api/vehicles/v1/odometer',
    ]);
  });
});

describe('areas client', () => {
  it('maps each method to its route, method and path', async () => {
    const { fetch, seen } = transport((request) => {
      if (request.url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'tok' } };
      if (request.url === '/api/auth/session') return { status: 200, body: session('tok') };
      return { status: 200, body: { items: [], total: 0 } };
    });
    const areas = createAreasClient(createBffClient({ fetch }));
    await areas.list();
    await areas.list({ includeInactive: 'true' });
    await areas.get('a1');
    await areas.history('a1');
    await areas.history('a1', { limit: 25 });
    await areas.create({ name: 'Norte', code: null, parentId: null, responsibleIds: [] });
    await areas.update('a1', { version: 1, name: 'Sur' });
    await areas.deactivate('a1', 2);
    await areas.activate('a1', 3);
    const calls = seen.filter((entry) => !entry.url.startsWith('/api/auth/'));
    expect(calls.map((entry) => `${entry.method} ${entry.url.split('?')[0]}`)).toEqual([
      'GET /api/areas',
      'GET /api/areas',
      'GET /api/areas/a1',
      'GET /api/areas/a1/history',
      'GET /api/areas/a1/history',
      'POST /api/areas',
      'PUT /api/areas/a1',
      'POST /api/areas/a1/deactivate',
      'POST /api/areas/a1/activate',
    ]);
  });
});

describe('employees client', () => {
  it('maps each method to its route, method and path, and exposes the colliding field', async () => {
    const { fetch, seen } = transport((request) => {
      if (request.url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'tok' } };
      if (request.url === '/api/auth/session') return { status: 200, body: session('tok') };
      if (request.method === 'POST' && request.url === '/api/employees/e1/archive')
        return { status: 409, body: { ...errorBody('duplicate', 409), field: 'national_id' } };
      return { status: 200, body: { items: [], total: 0 } };
    });
    const employees = createEmployeesClient(createBffClient({ fetch }));
    await employees.list();
    await employees.list({ status: 'inactive' });
    await employees.get('e1');
    await employees.history('e1');
    await employees.history('e1', { limit: 25 });
    await employees.create({ kind: 'other', firstName: 'A', lastName: 'B', areaId: 'a' });
    await employees.update('e1', { version: 1, position: 'x' });
    await employees.changeStatus('e1', { version: 1, status: 'inactive', reason: 'x' });
    const clash = await employees.archive('e1', 1);
    expect(clash).toMatchObject({
      ok: false,
      error: { code: 'duplicate', fieldErrors: [{ field: 'national_id' }] },
    });
    const calls = seen.filter((entry) => !entry.url.startsWith('/api/auth/'));
    expect(calls.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/employees',
      'GET /api/employees?status=inactive',
      'GET /api/employees/e1',
      'GET /api/employees/e1/history',
      'GET /api/employees/e1/history?limit=25',
      'POST /api/employees',
      'PUT /api/employees/e1',
      'POST /api/employees/e1/status',
      'POST /api/employees/e1/archive',
    ]);
  });
});

describe('documents client', () => {
  it('maps each method to its route, method and path, and exposes the invalid owner field', async () => {
    const { fetch, seen } = transport((request) => {
      if (request.url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'tok' } };
      if (request.url === '/api/auth/session') return { status: 200, body: session('tok') };
      if (request.method === 'POST' && request.url === '/api/documents')
        return { status: 422, body: { ...errorBody('invalid_owner', 422), field: 'owner_id' } };
      return { status: 200, body: { items: [], total: 0 } };
    });
    const documents = createDocumentsClient(createBffClient({ fetch }));
    await documents.list();
    await documents.list({ status: 'expiring', ownerType: 'vehicle' });
    await documents.get('d1');
    await documents.history('d1');
    await documents.history('d1', { limit: 25 });
    const refused = await documents.create({
      ownerType: 'vehicle',
      ownerId: 'v1',
      typeCode: 'registration_card',
      title: 'Tarjeta',
      expiresOn: '2027-01-01',
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'invalid_owner', fieldErrors: [{ field: 'owner_id' }] },
    });
    await documents.update('d1', { version: 1, title: 'x' });
    await documents.renew('d1', { version: 1, expiresOn: '2028-01-01' });
    await documents.archive('d1', 1);
    const calls = seen.filter((entry) => !entry.url.startsWith('/api/auth/'));
    expect(calls.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/documents',
      'GET /api/documents?status=expiring&ownerType=vehicle',
      'GET /api/documents/d1',
      'GET /api/documents/d1/history',
      'GET /api/documents/d1/history?limit=25',
      'POST /api/documents',
      'PUT /api/documents/d1',
      'POST /api/documents/d1/renew',
      'POST /api/documents/d1/archive',
    ]);
  });
});

describe('insurance client', () => {
  it('maps each method to its route, method and path, and exposes the invalid vehicle field', async () => {
    const { fetch, seen } = transport((request) => {
      if (request.url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'tok' } };
      if (request.url === '/api/auth/session') return { status: 200, body: session('tok') };
      if (request.method === 'POST' && request.url === '/api/insurance-policies')
        return { status: 422, body: { ...errorBody('invalid_vehicle', 422), field: 'vehicle_id' } };
      return { status: 200, body: { items: [], total: 0 } };
    });
    const insurance = createInsuranceClient(createBffClient({ fetch }));
    await insurance.list();
    await insurance.list({ status: 'expiring', coversOn: '2026-10-06' });
    await insurance.get('p1');
    await insurance.history('p1');
    await insurance.history('p1', { limit: 25 });
    const refused = await insurance.create({
      vehicleId: 'v1',
      insurer: 'Aseguradora Ficticia',
      policyNumber: 'POL-1',
      coverageType: 'comprehensive',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
      deductible: { kind: 'percent', basisPoints: 1000 },
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'invalid_vehicle', fieldErrors: [{ field: 'vehicle_id' }] },
    });
    await insurance.update('p1', { version: 1, insurer: 'Otra Ficticia' });
    await insurance.renew('p1', { version: 1, startsOn: '2027-01-01', endsOn: '2027-12-31' });
    await insurance.archive('p1', 1);
    const calls = seen.filter((entry) => !entry.url.startsWith('/api/auth/'));
    expect(calls.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/insurance-policies',
      'GET /api/insurance-policies?status=expiring&coversOn=2026-10-06',
      'GET /api/insurance-policies/p1',
      'GET /api/insurance-policies/p1/history',
      'GET /api/insurance-policies/p1/history?limit=25',
      'POST /api/insurance-policies',
      'PUT /api/insurance-policies/p1',
      'POST /api/insurance-policies/p1/renew',
      'POST /api/insurance-policies/p1/archive',
    ]);
  });
});

describe('assignments client', () => {
  it('maps each method to its route, method and path, and exposes the conflict fields', async () => {
    const { fetch, seen } = transport((request) => {
      if (request.url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'tok' } };
      if (request.url === '/api/auth/session') return { status: 200, body: session('tok') };
      if (request.method === 'POST' && request.url === '/api/vehicle-assignments')
        return { status: 409, body: { ...errorBody('principal_taken', 409), field: 'vehicle_id' } };
      return { status: 200, body: { items: [], total: 0 } };
    });
    const assignments = createAssignmentsClient(createBffClient({ fetch }));
    await assignments.list();
    await assignments.list({ vehicleId: 'v1', status: 'current' });
    await assignments.get('a1');
    await assignments.history('a1');
    await assignments.history('a1', { limit: 25 });
    const refused = await assignments.assign({
      vehicleId: 'v1',
      employeeId: 'e1',
      type: 'principal',
      reason: 'Alta de unidad',
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'principal_taken', fieldErrors: [{ field: 'vehicle_id' }] },
    });
    await assignments.end('a1', { version: 1, reason: 'Fin de turno' });
    const calls = seen.filter((entry) => !entry.url.startsWith('/api/auth/'));
    expect(calls.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/vehicle-assignments',
      'GET /api/vehicle-assignments?vehicleId=v1&status=current',
      'GET /api/vehicle-assignments/a1',
      'GET /api/vehicle-assignments/a1/history',
      'GET /api/vehicle-assignments/a1/history?limit=25',
      'POST /api/vehicle-assignments',
      'POST /api/vehicle-assignments/a1/end',
    ]);
  });
});

describe('imports client', () => {
  it('maps each method to its route, method and path, and returns the conflict as a value', async () => {
    const { fetch, seen } = transport((request) => {
      if (request.url === '/api/auth/csrf') return { status: 200, body: { csrfToken: 'tok' } };
      if (request.url === '/api/auth/session') return { status: 200, body: session('tok') };
      if (request.method === 'POST' && request.url === '/api/imports')
        return { status: 409, body: errorBody('conflict', 409) };
      return { status: 200, body: { items: [], total: 0 } };
    });
    const imports = createImportsClient(createBffClient({ fetch }));
    await imports.list();
    await imports.list({ entity: 'vehicle', status: 'validated' });
    await imports.get('j1');
    await imports.rows('j1');
    await imports.rows('j1', { outcome: 'invalid', limit: 50 });
    await imports.history('j1');
    await imports.history('j1', { limit: 25 });
    const refused = await imports.submit({
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'key-12345678',
      csv: 'plate\nABC1',
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const calls = seen.filter((entry) => !entry.url.startsWith('/api/auth/'));
    expect(calls.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET /api/imports',
      'GET /api/imports?entity=vehicle&status=validated',
      'GET /api/imports/j1',
      'GET /api/imports/j1/rows',
      'GET /api/imports/j1/rows?outcome=invalid&limit=50',
      'GET /api/imports/j1/history',
      'GET /api/imports/j1/history?limit=25',
      'POST /api/imports',
    ]);
  });
});
