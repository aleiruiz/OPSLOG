import { afterEach, describe, expect, it } from 'vitest';
import {
  BFF_ERRORS,
  BFF_ROUTES,
  bffRouteIds,
  createBffClient,
  type BffClient,
  type BffRouteId,
  type FetchLike,
} from '../../../packages/contracts/src/index.js';
import { ERRORS } from '../../../apps/api/bff/src/index.js';
import { ROUTES } from '../../../apps/api/bff/src/routes.js';
import {
  HOST,
  ORIGIN,
  createBffWorld,
  type BffWorld,
} from '../../../apps/api/bff/src/test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

/**
 * `fetch` as a same-origin browser would run it against the in-process BFF: one cookie jar,
 * `Origin` and `Sec-Fetch-Site` on state changes, `Set-Cookie` honoured. The cookie is invisible
 * to the client code, exactly as an httpOnly cookie is invisible to the page.
 */
function browserFetch(handler: BffWorld['handler']): FetchLike {
  const jar = new Map<string, string>();
  return async (url, init) => {
    const headers: Record<string, string> = { ...init.headers, host: HOST };
    if (init.method !== 'GET') {
      headers['origin'] = ORIGIN;
      headers['sec-fetch-site'] = 'same-origin';
    }
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers['cookie'] = cookie;
    const body = init.body;
    const response = await handler({
      method: init.method,
      url,
      headers,
      body:
        body === undefined
          ? null
          : (async function* () {
              yield Buffer.from(body);
            })(),
    });
    for (const line of ([] as string[]).concat(response.headers['set-cookie'] ?? [])) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (attributes.includes('Max-Age=0') || value === '') jar.delete(name);
      else jar.set(name, value);
    }
    const correlation = response.headers['x-correlation-id'];
    return {
      status: response.status,
      headers: {
        get: (name: string) => (name === 'x-correlation-id' ? String(correlation ?? '') : null),
      },
      text: async () => response.body,
    };
  };
}

/** A client that records which routes were exercised. */
function trackedClient(handler: BffWorld['handler']) {
  const inner = createBffClient({ fetch: browserFetch(handler) });
  const used = new Set<BffRouteId>();
  const client: BffClient = {
    call: (id, ...args) => {
      used.add(id);
      return inner.call(id, ...args);
    },
  };
  return { client, used };
}

describe('contract drift: BFF routing table against the contract module', () => {
  it('implements exactly the routes the contract declares, with the same method, path and protection', () => {
    expect(ROUTES.map((route) => route.id).sort()).toEqual([...bffRouteIds].sort());
    for (const route of ROUTES) {
      const declared = BFF_ROUTES[route.id];
      expect({ method: route.method, path: route.path, kind: route.kind }).toEqual({
        method: declared.method,
        path: declared.path,
        kind: declared.kind,
      });
      const names = declared.path.filter((s) => s.startsWith(':')).map((s) => s.slice(1));
      expect(Object.keys(route.params ?? {}).sort()).toEqual(names.sort());
    }
  });

  it('serves the same error catalogue', () => {
    expect(ERRORS).toEqual(BFF_ERRORS);
  });
});

describe('typed client against the real BFF', () => {
  it('walks every contract route end to end with the CSRF handshake and cookie session', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin');
    const editor = await world.member('subject-admin', 'editor', 'subject-editor');
    const { client, used } = trackedClient(world.handler);

    // Pre-login: token, then OIDC sign-in. The page only ever sees the CSRF token, not the cookie.
    const login = await client.call('auth.login', { body: world.credentials('subject-admin') });
    expect(login).toMatchObject({
      ok: true,
      value: { company: { name: 'Empresa Alfa' }, roleId: 'admin', roleLabel: 'Administrador' },
    });
    if (!login.ok) throw new Error('login failed');
    expect(Object.keys(login.value.user)).toEqual(['id']);
    expect(login.value.permissions).toContain('manage_users');

    const session = await client.call('auth.session');
    expect(session).toMatchObject({ ok: true, value: { user: login.value.user } });

    const settings = await client.call('company.settings.get');
    expect(settings).toMatchObject({ ok: true, value: { name: 'Empresa Alfa', status: 'active' } });
    const updated = await client.call('company.settings.update', {
      body: { name: 'Empresa Alfa SA', mfa: 'required', sessionIdleHours: 4, reason: 'Política' },
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { name: 'Empresa Alfa SA', mfa: 'required', sessionIdleHours: 4 },
    });
    expect(
      await client.call('company.settings.update', {
        body: { name: 'Sin motivo', mfa: 'optional', sessionIdleHours: 4 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request', status: 400 } });

    // Roles
    const roles = await client.call('roles.list');
    expect(roles.ok && roles.value.items.map((role) => role.id)).toContain('viewer');
    const copy = await client.call('roles.copy', {
      params: { id: 'viewer' },
      body: { name: 'Consulta ampliada' },
    });
    expect(copy).toMatchObject({ ok: true, value: { kind: 'custom', name: 'Consulta ampliada' } });
    expect(
      await client.call('roles.copy', {
        params: { id: 'viewer' },
        body: { name: 'Consulta ampliada' },
      }),
    ).toMatchObject({ ok: false, error: { status: 409 } });

    // Users: invitation, signed cursors, deactivation.
    const issued: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const invited = await client.call('users.invite', { body: { roleId: 'viewer' } });
      if (!invited.ok) throw new Error('invite failed');
      expect(invited.value.user.status).toBe('invited');
      issued.push(invited.value.invitationToken);
    }
    const first = await client.call('users.list', { query: { limit: 25, sort: 'id' } });
    if (!first.ok) throw new Error('list failed');
    expect(first.value.total).toBe(5);
    expect(Object.keys(first.value.items[0] ?? {}).sort()).toEqual([
      'id',
      'roleId',
      'roleLabel',
      'status',
    ]);
    const forged = await client.call('users.list', { query: { cursor: 'forjado.forjado' } });
    expect(forged).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    const pending = await client.call('users.list', { query: { search: 'invited', limit: 25 } });
    expect(pending.ok && pending.value.total).toBe(3);
    // A pending invitation is not a member: only active members can be deactivated.
    const target = editor.identityId;
    expect(
      await client.call('users.deactivate', { params: { id: target }, body: { reason: 'Baja' } }),
    ).toEqual({ ok: true, value: { id: target, status: 'inactive' } });

    // Drafts
    expect(await client.call('drafts.load', { params: { scope: 'form:a' } })).toEqual({
      ok: true,
      value: { draft: null },
    });
    const saved = await client.call('drafts.save', {
      params: { scope: 'form:a' },
      body: { values: { nota: 'texto' } },
    });
    expect(saved).toMatchObject({
      ok: true,
      value: { scope: 'form:a', values: { nota: 'texto' } },
    });
    expect(await client.call('drafts.load', { params: { scope: 'form:a' } })).toMatchObject({
      ok: true,
      value: { draft: { values: { nota: 'texto' } } },
    });
    expect(await client.call('drafts.discard', { params: { scope: 'form:a' } })).toEqual({
      ok: true,
      value: undefined,
    });

    // Invitation flow from another browser (pre-session CSRF), then sign out.
    const guest = trackedClient(world.handler);
    const token = issued[2] as string;
    expect(await guest.client.call('auth.invitation.inspect', { body: { token } })).toEqual({
      ok: true,
      value: { companyName: 'Empresa Alfa SA', roleLabel: 'Consulta' },
    });
    const accepted = await guest.client.call('auth.invitation.accept', {
      body: { token, ...world.credentials('subject-invitee') },
    });
    expect(accepted).toMatchObject({ ok: true, value: { roleId: 'viewer' } });
    expect(await guest.client.call('company.settings.get')).toMatchObject({
      ok: false,
      error: { code: 'forbidden', status: 403 },
    });
    expect(await guest.client.call('auth.logout')).toEqual({ ok: true, value: undefined });
    expect(await guest.client.call('auth.session')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', status: 401 },
    });
    expect(await client.call('auth.logout')).toEqual({ ok: true, value: undefined });
    expect(await client.call('users.list')).toMatchObject({ ok: false, error: { status: 401 } });

    // The CSRF endpoint is exercised by the handshake itself.
    for (const id of guest.used) used.add(id);
    used.add('auth.csrf');
    expect([...used].sort()).toEqual([...bffRouteIds].sort());
  });

  it('refreshes its session token after a reload and keeps working', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin');
    const fetch = browserFetch(world.handler);
    const before = createBffClient({ fetch });
    await before.call('auth.login', { body: world.credentials('subject-admin') });
    // A new page load: same cookie jar, a client with no memory of the CSRF token.
    const after = createBffClient({ fetch });
    expect(await after.call('users.invite', { body: { roleId: 'editor' } })).toMatchObject({
      ok: true,
      value: { user: { roleId: 'editor' } },
    });
  });

  it('maps every uniform BFF failure to the shared error shape', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin');
    await world.member('subject-admin', 'viewer', 'subject-viewer');
    const { client } = trackedClient(world.handler);
    const bad = await client.call('auth.login', { body: { code: 'desconocido', nonce: 'n' } });
    expect(bad).toMatchObject({ ok: false, error: { code: 'unauthorized', status: 401 } });
    await client.call('auth.login', { body: world.credentials('subject-viewer') });
    const denied = await client.call('users.list');
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
    if (denied.ok) throw new Error('expected failure');
    expect(Object.keys(denied.error).sort()).toEqual([
      'code',
      'correlationId',
      'message',
      'status',
    ]);
    expect(denied.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await client.call('users.deactivate', { params: { id: 'x' }, body: { reason: 'r' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });
});
