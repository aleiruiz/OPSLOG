import { createHash } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBffServer } from '../../../apps/api/bff/src/index.js';
import { BFF_ROUTES } from '../../../packages/contracts/src/index.js';
import {
  HOST,
  ORIGIN,
  createBffWorld,
  type BffWorld,
  type Browser,
  type Reply,
} from '../../../apps/api/bff/src/test-support.js';

let world: BffWorld;
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  world?.dispose();
});

const HOUR = 3_600_000;
const VEHICLE_NEW = {
  economicNumber: 'U-002',
  plate: 'XYZ987',
  vin: null,
  make: 'Nissan',
  model: 'NP300',
  year: 2021,
  areaId: 'area-1',
  odometerKm: 10,
};
const SETTINGS = { name: 'Nombre nuevo', mfa: 'disabled', sessionIdleHours: 8 };

interface Fixture {
  readonly a: Awaited<ReturnType<BffWorld['tenant']>>;
  readonly b: Awaited<ReturnType<BffWorld['tenant']>>;
  readonly adminA: Browser;
  readonly adminB: Browser;
  readonly viewerA: Browser;
  readonly viewerAId: string;
  readonly memberB: { identityId: string };
  readonly vehicleId: string;
}

async function fixture(options: Parameters<typeof createBffWorld>[0] = {}): Promise<Fixture> {
  world = createBffWorld(options);
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  const viewer = await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const memberB = await world.member('subject-admin-b', 'editor', 'subject-editor-b');
  const adminA = await world.loginAs('subject-admin-a');
  const vehicle = await adminA.post('/api/vehicles', {
    json: {
      economicNumber: 'U-001',
      plate: 'ABC123',
      vin: null,
      make: 'Toyota',
      model: 'Hilux',
      year: 2022,
      areaId: 'area-1',
      odometerKm: 1000,
    },
  });
  if (vehicle.status !== 201) throw new Error('vehicle fixture failed');
  return {
    a,
    b,
    adminA,
    adminB: await world.loginAs('subject-admin-b'),
    vehicleId: vehicle.json.id as string,
    viewerA: await world.loginAs('subject-viewer-a'),
    viewerAId: viewer.identityId,
    memberB,
  };
}

const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

/** Every state-changing route with a body that would be valid for the signed-in administrator. */
function writes(f: Fixture): [string, string, unknown?][] {
  return [
    ['POST', '/api/auth/logout'],
    ['PUT', '/api/company/settings', SETTINGS],
    ['POST', '/api/users/invitations', { roleId: 'viewer' }],
    ['POST', `/api/users/${f.viewerAId}/deactivate`, { reason: 'Baja' }],
    ['POST', '/api/roles/viewer/copy', { name: 'Copia' }],
    ['PUT', '/api/drafts/form', { values: { a: 'b' } }],
    ['DELETE', '/api/drafts/form'],
    ['POST', '/api/vehicles', VEHICLE_NEW],
    ['PUT', `/api/vehicles/${f.vehicleId}`, { version: 1, make: 'Ford' }],
    [
      'POST',
      `/api/vehicles/${f.vehicleId}/status`,
      { version: 1, status: 'inactive', reason: 'x' },
    ],
    ['POST', `/api/vehicles/${f.vehicleId}/odometer`, { version: 1, odometerKm: 2000 }],
    ['POST', `/api/vehicles/${f.vehicleId}/archive`, { version: 1 }],
  ];
}

async function snapshot(f: Fixture) {
  const get = async (browser: Browser, path: string) => (await browser.get(path)).json;
  return {
    settings: await get(f.adminA, '/api/company/settings'),
    users: (await get(f.adminA, '/api/users?limit=100')).items,
    roles: (await get(f.adminA, '/api/roles')).items,
    draft: await get(f.adminA, '/api/drafts/form'),
    vehicles: await get(f.adminA, '/api/vehicles?includeArchived=true&limit=100'),
    vehiclesB: await get(f.adminB, '/api/vehicles?includeArchived=true&limit=100'),
    settingsB: await get(f.adminB, '/api/company/settings'),
    usersB: (await get(f.adminB, '/api/users?limit=100')).items,
  };
}

describe('A/B isolation through HTTP', () => {
  it('serves each browser only its own tenant, whatever it sends', async () => {
    const f = await fixture();
    expect((await f.adminA.get('/api/auth/session')).json.company.id).toBe(f.a.tenantId);
    expect((await f.adminB.get('/api/auth/session')).json.company.id).toBe(f.b.tenantId);
    const idsA = (await f.adminA.get('/api/users?limit=100')).json.items.map(
      (user: { id: string }) => user.id,
    );
    const idsB = (await f.adminB.get('/api/users?limit=100')).json.items.map(
      (user: { id: string }) => user.id,
    );
    expect(idsA).toContain(f.a.adminId);
    expect(idsA).toContain(f.viewerAId);
    expect(idsA).not.toContain(f.b.adminId);
    expect(idsB.sort()).toEqual([f.b.adminId, f.memberB.identityId].sort());
    // Hints about another tenant in headers, query string or body change nothing or are refused.
    for (const headers of [
      { 'x-tenant-id': f.b.tenantId },
      { 'x-forwarded-host': 'beta.test', host: HOST },
      { 'x-opslog-tenant': f.b.tenantId, forwarded: `host=${HOST}` },
    ])
      expect((await f.adminA.get('/api/company/settings', { headers })).json.name).toBe(
        'Empresa Alfa',
      );
    expect((await f.adminA.get(`/api/users?tenant=${f.b.tenantId}`)).status).toBe(400);
    expect(
      (
        await f.adminA.post('/api/users/invitations', {
          json: { roleId: 'viewer', tenantId: f.b.tenantId },
        })
      ).status,
    ).toBe(400);
  });

  it('answers 404 for identifiers of another tenant, exactly as for unknown ones, and changes nothing', async () => {
    const f = await fixture();
    const copyB = await f.adminB.post('/api/roles/editor/copy', { json: { name: 'Solo beta' } });
    await f.adminB.put('/api/drafts/form', { json: { values: { campo: 'beta' } } });
    const before = await snapshot(f);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const pairs: [Reply, Reply][] = [
      [
        await f.adminA.post(`/api/users/${f.b.adminId}/deactivate`, { json: { reason: 'x' } }),
        await f.adminA.post(`/api/users/${unknown}/deactivate`, { json: { reason: 'x' } }),
      ],
      [
        await f.adminA.post(`/api/users/${f.memberB.identityId}/deactivate`, {
          json: { reason: 'x' },
        }),
        await f.adminA.post(`/api/users/${unknown}/deactivate`, { json: { reason: 'x' } }),
      ],
      [
        await f.adminA.post(`/api/roles/${copyB.json.id}/copy`, { json: { name: 'Robada' } }),
        await f.adminA.post('/api/roles/custom-unknown/copy', { json: { name: 'Robada' } }),
      ],
    ];
    for (const [foreign, missing] of pairs) {
      expect(foreign.status).toBe(404);
      expect(withoutId(foreign)).toEqual(withoutId(missing));
    }
    // Drafts of B are not visible from A even with the same scope name.
    expect((await f.adminA.get('/api/drafts/form')).json).toEqual({ draft: null });
    expect(await snapshot(f)).toEqual(before);
    // B can still sign in and use everything.
    expect((await f.adminB.get('/api/users')).status).toBe(200);
    expect(
      world.platform.audit
        .list(f.b.tenantId)
        .some((event) => event.action === 'membership.revoked'),
    ).toBe(false);
  });

  it('keeps audit trails per tenant for actions taken over HTTP', async () => {
    const f = await fixture();
    await f.adminA.put('/api/company/settings', { json: { ...SETTINGS, name: 'Alfa' } });
    await f.adminB.post('/api/roles/viewer/copy', { json: { name: 'Beta' } });
    const actions = (tenantId: string) =>
      world.platform.audit.list(tenantId).map((event) => event.action);
    expect(actions(f.a.tenantId)).toContain('tenant.settings_updated');
    expect(actions(f.a.tenantId)).not.toContain('role.copied');
    expect(actions(f.b.tenantId)).toContain('role.copied');
    expect(actions(f.b.tenantId)).not.toContain('tenant.settings_updated');
  });

  it('refuses a cursor minted for one tenant when presented by the other', async () => {
    const f = await fixture();
    for (let index = 0; index < 30; index += 1)
      world.platform.access.grant(
        f.a.tenantId,
        `synthetic-${String(index).padStart(2, '0')}`,
        'viewer',
      );
    const page = await f.adminA.get('/api/users?limit=25');
    expect(page.json.nextCursor).toBeTruthy();
    const stolen = await f.adminB.get(
      `/api/users?limit=25&cursor=${encodeURIComponent(page.json.nextCursor)}`,
    );
    expect(stolen.status).toBe(400);
    expect(stolen.text).not.toContain(f.a.tenantId);
  });
});

describe('CSRF through HTTP', () => {
  it('rejects every state-changing route without, with a wrong or with a foreign token, and changes nothing', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    const tokens: (string | null)[] = [null, '', 'wrong', f.adminB.csrf, f.viewerA.csrf];
    for (const [method, path, json] of writes(f))
      for (const csrf of tokens) {
        const reply = await f.adminA.send(method, path, { json, csrf });
        expect(reply.status, `${method} ${path} with ${csrf}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect(await snapshot(f)).toEqual(before);
    // The administrator is still signed in: a rejected CSRF check does not end the session.
    expect((await f.adminA.get('/api/auth/session')).status).toBe(200);
  });

  it('rejects cross-site and mismatched origins on every state-changing route', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    const attacks = [
      { origin: 'https://evil.test' },
      { origin: null },
      { origin: 'null' },
      { host: 'evil.test' },
      { headers: { 'sec-fetch-site': 'cross-site' } },
    ];
    for (const [method, path, json] of writes(f))
      for (const attack of attacks)
        expect((await f.adminA.send(method, path, { json, ...attack })).status).toBe(403);
    expect(await snapshot(f)).toEqual(before);
  });

  it('rejects cross-site and mismatched origins on login and invitation routes, even with a valid pre-login token', async () => {
    const f = await fixture();
    const token = (await f.adminA.post('/api/users/invitations', { json: { roleId: 'editor' } }))
      .json.invitationToken as string;
    const attacks = [
      { origin: 'https://evil.test' },
      { origin: null },
      { origin: 'null' },
      { host: 'evil.test' },
      { headers: { 'sec-fetch-site': 'cross-site' } },
    ];
    const preLogin = (): [string, unknown][] => [
      ['/api/auth/login', world.credentials('subject-admin-a')],
      ['/api/auth/invitations/inspect', { token }],
      ['/api/auth/invitations/accept', { token, ...world.credentials('subject-invitee') }],
    ];
    const visitor = world.browser();
    await world.prepare(visitor);
    for (const [path, json] of preLogin())
      for (const attack of attacks) {
        const reply = await visitor.post(path, { json, ...attack });
        expect(reply.status, `${path} ${JSON.stringify(attack)}`).toBe(403);
        expect(reply.json.code).toBe('csrf_failed');
      }
    expect(visitor.jar.has('opslog_session')).toBe(false);
    // Control: the same requests from the allowed origin work, so the origin was the only cause.
    for (const [path, json] of preLogin()) {
      const fresh = world.browser();
      await world.prepare(fresh);
      expect([200, 201], path).toContain((await fresh.post(path, { json })).status);
    }
  });

  it('covers every state-changing route of the contract in the origin matrices', async () => {
    const f = await fixture();
    // Only `public` routes are exempt from the origin check, and none of them changes state.
    const stateChanging = Object.values(BFF_ROUTES).filter(
      (definition) => definition.method !== 'GET',
    );
    expect(stateChanging.map((definition) => definition.kind)).not.toContain('public');
    // Session routes: `writes`; pre-login routes: login, inspect and accept above.
    expect(writes(f).length + 3).toBe(stateChanging.length);
    expect(stateChanging.filter((definition) => definition.kind === 'pre-session')).toHaveLength(3);
  });

  it('protects login and invitation acceptance against forged requests', async () => {
    const f = await fixture();
    const attacker = world.browser();
    const reply = await attacker.post('/api/auth/login', {
      json: world.credentials('subject-admin-a'),
    });
    expect(reply.status).toBe(403);
    expect(attacker.jar.has('opslog_session')).toBe(false);
    const invited = await f.adminA.post('/api/users/invitations', { json: { roleId: 'editor' } });
    const token = invited.json.invitationToken as string;
    const accept = await attacker.post('/api/auth/invitations/accept', {
      json: { token, ...world.credentials('subject-attacker') },
    });
    expect(accept.status).toBe(403);
    // The invitation survived the forged attempt and still works for its real recipient.
    const real = world.browser();
    await world.prepare(real);
    expect(
      (
        await real.post('/api/auth/invitations/accept', {
          json: { token, ...world.credentials('subject-real-recipient') },
        })
      ).status,
    ).toBe(201);
  });
});

describe('session lifecycle through HTTP', () => {
  it('denies a revoked session on every route', async () => {
    const f = await fixture();
    const stale = [...f.viewerA.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const csrf = f.viewerA.csrf;
    expect((await f.viewerA.post('/api/auth/logout')).status).toBe(204);
    const replay = world.browser();
    replay.csrf = csrf;
    for (const path of ['/api/auth/session', '/api/drafts/form'])
      expect((await replay.get(path, { cookieHeader: stale })).status).toBe(401);
    expect(
      (await replay.put('/api/drafts/form', { json: { values: {} }, cookieHeader: stale })).status,
    ).toBe(401);
    expect((await replay.post('/api/auth/logout', { cookieHeader: stale })).status).toBe(401);
  });

  it('denies sessions of a member whose membership was removed, with the correct token and cookie', async () => {
    const f = await fixture();
    expect(
      (
        await f.adminA.post(`/api/users/${f.viewerAId}/deactivate`, {
          json: { reason: 'Fin de contrato' },
        })
      ).status,
    ).toBe(200);
    for (const reply of [
      await f.viewerA.get('/api/auth/session'),
      await f.viewerA.put('/api/drafts/form', { json: { values: {} } }),
    ])
      expect(reply.status).toBe(401);
    // The member cannot sign in again either.
    const again = world.browser();
    await world.prepare(again);
    expect(
      (await again.post('/api/auth/login', { json: world.credentials('subject-viewer-a') })).status,
    ).toBe(401);
  });

  it('expires sessions after eight hours on reads and writes', async () => {
    const f = await fixture();
    world.advance(8 * HOUR - 1000);
    expect((await f.adminA.get('/api/auth/session')).status).toBe(200);
    world.advance(2000);
    for (const reply of [
      await f.adminA.get('/api/auth/session'),
      await f.adminA.get('/api/users'),
      await f.adminA.put('/api/company/settings', { json: SETTINGS }),
      await f.adminA.post('/api/auth/logout'),
    ]) {
      expect(reply.status).toBe(401);
      expect(reply.json.code).toBe('unauthorized');
    }
    // Signing in again works; the new session has its own CSRF token.
    const fresh = await world.loginAs('subject-admin-a');
    expect(fresh.csrf).not.toBe(f.adminA.csrf);
    expect((await fresh.get('/api/auth/session')).status).toBe(200);
  });

  it('ends sessions when the role changes or the tenant is suspended', async () => {
    const f = await fixture();
    const demoted = await world.platform.changeRole(
      (await signInToken('subject-admin-a')).token,
      'c',
      f.viewerAId,
      'editor',
    );
    expect(demoted.ok).toBe(true);
    expect((await f.viewerA.get('/api/auth/session')).status).toBe(401);
    const reloaded = await world.loginAs('subject-viewer-a');
    expect((await reloaded.get('/api/auth/session')).json.permissions).toEqual([
      'view',
      'create',
      'edit',
    ]);
    await world.platform.suspendTenant(f.a.tenantId);
    expect((await f.adminA.get('/api/users')).status).toBe(401);
    expect((await reloaded.get('/api/auth/session')).status).toBe(401);
    expect((await f.adminB.get('/api/users')).status).toBe(200);
  });

  async function signInToken(subject: string) {
    const login = await world.platform.signIn(await world.principal(subject));
    return login.value!;
  }

  it('rejects forged, truncated, hashed and swapped session cookies', async () => {
    const f = await fixture();
    const realA = f.adminA.jar.get('opslog_session')!;
    const realB = f.adminB.jar.get('opslog_session')!;
    const stranger = world.browser();
    const forged = [
      'A'.repeat(43),
      realA.slice(0, 20),
      `${realA}A`,
      realA.toUpperCase() === realA ? realA.toLowerCase() : realA.toUpperCase(),
      // What the control plane stores as the session id is not a credential.
      createHash('sha256').update(realA, 'utf8').digest('hex'),
      Buffer.from(realA).toString('base64url'),
      `${realA.slice(0, -1)}${realA.endsWith('A') ? 'B' : 'A'}`,
      'null',
      'undefined',
      "'; DROP TABLE sessions; --",
    ];
    for (const value of forged)
      for (const reply of [
        await stranger.get('/api/auth/session', { cookieHeader: `opslog_session=${value}` }),
        await stranger.get('/api/users', { cookieHeader: `opslog_session=${value}` }),
        await stranger.put('/api/company/settings', {
          json: SETTINGS,
          cookieHeader: `opslog_session=${value}`,
          csrf: f.adminA.csrf,
        }),
      ]) {
        expect(reply.status, value).toBe(401);
        expect(reply.json.code).toBe('unauthorized');
      }
    // A's CSRF token with B's cookie is not valid either, and B stays in B.
    const crossed = await stranger.put('/api/company/settings', {
      json: SETTINGS,
      cookieHeader: `opslog_session=${realB}`,
      csrf: f.adminA.csrf,
    });
    expect(crossed.status).toBe(403);
    expect((await f.adminB.get('/api/company/settings')).json.name).toBe('Empresa Beta');
  });

  it('does not let a visitor fix a session cookie of their choosing', async () => {
    await fixture();
    const attacker = world.browser();
    await world.prepare(attacker);
    const chosen = 'F'.repeat(43);
    attacker.jar.set('opslog_session', chosen);
    const login = await attacker.post('/api/auth/login', {
      json: world.credentials('subject-admin-a'),
    });
    expect(login.status).toBe(200);
    expect(attacker.jar.get('opslog_session')).not.toBe(chosen);
    expect(
      (await world.browser().get('/api/auth/session', { cookieHeader: `opslog_session=${chosen}` }))
        .status,
    ).toBe(401);
  });
});

describe('invitation lifecycle through HTTP', () => {
  const accept = async (token: string, subject: string) => {
    const visitor = world.browser();
    await world.prepare(visitor);
    const reply = await visitor.post('/api/auth/invitations/accept', {
      json: { token, ...world.credentials(subject) },
    });
    return { reply, visitor };
  };
  const inspect = async (token: string) => {
    const visitor = world.browser();
    await world.prepare(visitor);
    return visitor.post('/api/auth/invitations/inspect', { json: { token } });
  };

  it('revokes a pending administrator invitation when the pending member is deactivated', async () => {
    const f = await fixture();
    const invited = await f.adminA.post('/api/users/invitations', { json: { roleId: 'admin' } });
    const token = invited.json.invitationToken as string;
    const id = invited.json.user.id as string;
    const listed = (await f.adminA.get('/api/users?limit=100')).json.items as { id: string }[];
    expect(listed.find((user) => user.id === id)).toMatchObject({ status: 'invited' });

    const revoked = await f.adminA.post(`/api/users/${id}/deactivate`, {
      json: { reason: 'Error' },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json).toEqual({ id, status: 'inactive' });

    // Same answer as for any invalid token: the invitation is gone for inspect and for accept.
    expect((await inspect(token)).status).toBe(404);
    const { reply, visitor } = await accept(token, 'subject-stray');
    expect(reply.status).toBe(404);
    expect(reply.json.code).toBe('not_found');
    expect(visitor.jar.has('opslog_session')).toBe(false);
    const stray = world.browser();
    await world.prepare(stray);
    expect(
      (await stray.post('/api/auth/login', { json: world.credentials('subject-stray') })).status,
    ).toBe(401);
    // The original administrator is untouched and cannot be displaced by the revoked invitation.
    expect((await f.adminA.get('/api/auth/session')).status).toBe(200);
    // Revoking twice, or an unknown id, is a plain 404.
    expect(
      (await f.adminA.post(`/api/users/${id}/deactivate`, { json: { reason: 'Otra vez' } })).status,
    ).toBe(404);
  });

  it('refuses redemption in a suspended tenant with the uniform 404, consumes nothing and works after reactivation', async () => {
    const f = await fixture();
    const token = (await f.adminA.post('/api/users/invitations', { json: { roleId: 'viewer' } }))
      .json.invitationToken as string;
    const joined = () =>
      world.platform.audit.list(f.a.tenantId).filter((event) => event.action === 'user.joined')
        .length;
    const before = joined();
    await world.platform.suspendTenant(f.a.tenantId);

    const refused = await accept(token, 'subject-late');
    expect(refused.reply.status).toBe(404);
    expect(refused.reply.json.code).toBe('not_found');
    expect(refused.visitor.jar.has('opslog_session')).toBe(false);
    expect((await inspect(token)).status).toBe(404);
    expect(joined()).toBe(before);

    await world.platform.reactivateTenant(f.a.tenantId);
    expect((await inspect(token)).status).toBe(200);
    const redeemed = await accept(token, 'subject-late');
    expect(redeemed.reply.status).toBe(201);
    expect(joined()).toBe(before + 1);
    // Single use still holds after the suspension cycle.
    expect((await accept(token, 'subject-other')).reply.status).toBe(404);
  });
});

describe('request limits through HTTP', () => {
  it('refuses oversized bodies on every route that takes one, before and after authentication', async () => {
    const f = await fixture({ bff: { maxBodyBytes: 512 } });
    const before = await snapshot(f);
    const big = 'x'.repeat(4096);
    const targets: [string, string][] = [
      ['PUT', '/api/company/settings'],
      ['POST', '/api/users/invitations'],
      ['POST', `/api/users/${f.viewerAId}/deactivate`],
      ['POST', '/api/roles/viewer/copy'],
      ['PUT', '/api/drafts/form'],
      ['POST', '/api/vehicles'],
      ['PUT', `/api/vehicles/${f.vehicleId}`],
      ['POST', `/api/vehicles/${f.vehicleId}/status`],
      ['POST', `/api/vehicles/${f.vehicleId}/odometer`],
      ['POST', `/api/vehicles/${f.vehicleId}/archive`],
    ];
    for (const [method, path] of targets) {
      const reply = await f.adminA.send(method, path, { json: { big } });
      expect(reply.status, path).toBe(413);
      expect(reply.json.code).toBe('payload_too_large');
    }
    // Unauthenticated callers get the same limit, not an identity oracle.
    const anonymous = world.browser();
    await world.prepare(anonymous);
    for (const path of ['/api/auth/login', '/api/auth/invitations/accept'])
      expect((await anonymous.post(path, { json: { big } })).status).toBe(413);
    expect(await snapshot(f)).toEqual(before);
  });

  it('refuses a wrong content type on every route that takes a body, and changes nothing', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    const wrong = [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/xml',
    ];
    for (const [method, path, json] of writes(f).filter(([, , body]) => body !== undefined))
      for (const contentType of wrong) {
        const reply = await f.adminA.send(method, path, {
          raw: JSON.stringify(json),
          contentType,
        });
        expect(reply.status, `${path} ${contentType}`).toBe(415);
      }
    // The classic cross-site form post fails twice over: content type and origin.
    const form = await f.adminA.send('POST', '/api/users/invitations', {
      raw: 'roleId=admin',
      contentType: 'application/x-www-form-urlencoded',
      origin: 'https://evil.test',
      csrf: null,
    });
    expect([403, 415]).toContain(form.status);
    expect(await snapshot(f)).toEqual(before);
  });

  it('serializes concurrent removal of the two administrators: exactly one succeeds and one remains', async () => {
    for (let round = 0; round < 5; round += 1) {
      world?.dispose();
      const f = await fixture();
      const second = await world.member('subject-admin-a', 'admin', 'subject-admin-a2');
      const adminA2 = await world.loginAs('subject-admin-a2');
      const [one, two] = await Promise.all([
        f.adminA.post(`/api/users/${second.identityId}/deactivate`, { json: { reason: 'r1' } }),
        adminA2.post(`/api/users/${f.a.adminId}/deactivate`, { json: { reason: 'r2' } }),
      ]);
      // Whoever runs second acts with a session that the first removal already ended.
      expect([one.status, two.status].sort(), `round ${round}`).toEqual([200, 401]);
      expect(world.platform.access.activeAdmins(f.a.tenantId)).toHaveLength(1);
      const survivor = one.status === 200 ? f.adminA : adminA2;
      expect((await survivor.get('/api/auth/session')).status).toBe(200);
    }
  });
});

describe('over a real loopback socket', () => {
  interface Raw {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    json: any;
  }
  const call = (
    port: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ) =>
    new Promise<Raw>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: text ? JSON.parse(text) : null,
          });
        });
      });
      req.on('error', reject);
      req.end(body);
    });

  it('runs login, A/B isolation, CSRF and size limits over HTTP', async () => {
    const f = await fixture({ bff: { maxBodyBytes: 1024 } });
    server = createBffServer(world.handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const jsonHeaders = (cookie: string, csrf: string) => ({
      host: HOST,
      origin: ORIGIN,
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    });

    const pre = await call(port, 'GET', '/api/auth/csrf', { host: HOST });
    const nonceCookie = (pre.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
    const login = await call(
      port,
      'POST',
      '/api/auth/login',
      jsonHeaders(nonceCookie, pre.json.csrfToken),
      JSON.stringify(world.credentials('subject-admin-a')),
    );
    expect(login.status).toBe(200);
    const sessionLine = (login.headers['set-cookie'] as string[])[0]!;
    expect(sessionLine).toMatch(/HttpOnly/);
    expect(sessionLine).toMatch(/Secure/);
    expect(sessionLine).toMatch(/SameSite=Lax/);
    const cookie = sessionLine.split(';')[0]!;
    const headers = jsonHeaders(cookie, login.json.csrfToken);

    const foreign = await call(
      port,
      'POST',
      `/api/users/${f.b.adminId}/deactivate`,
      headers,
      JSON.stringify({ reason: 'x' }),
    );
    expect(foreign.status).toBe(404);
    const noCsrf = await call(
      port,
      'PUT',
      '/api/company/settings',
      { ...headers, 'x-csrf-token': 'wrong' },
      JSON.stringify(SETTINGS),
    );
    expect(noCsrf.status).toBe(403);
    const wrongType = await call(
      port,
      'PUT',
      '/api/company/settings',
      { ...headers, 'content-type': 'text/plain' },
      JSON.stringify(SETTINGS),
    );
    expect(wrongType.status).toBe(415);
    const tooBig = await call(
      port,
      'PUT',
      '/api/company/settings',
      headers,
      JSON.stringify({ ...SETTINGS, name: 'x'.repeat(5000) }),
    );
    expect(tooBig.status).toBe(413);
    const forged = await call(port, 'GET', '/api/auth/session', {
      host: HOST,
      cookie: `opslog_session=${'A'.repeat(43)}`,
    });
    expect(forged.status).toBe(401);
    const ok = await call(port, 'PUT', '/api/company/settings', headers, JSON.stringify(SETTINGS));
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const logout = await call(port, 'POST', '/api/auth/logout', {
      ...headers,
      'content-length': '0',
    });
    expect(logout.status).toBe(204);
    expect((await call(port, 'GET', '/api/auth/session', { host: HOST, cookie })).status).toBe(401);
  });
});
