import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeOidcVerifier,
  InMemoryTenantStore,
  createPlatform,
  type Platform,
} from '../../../apps/api/composition/src/index.js';
import { withLatency } from './latency.js';
import { raceAcceptAndRevoke, type Order } from './invitation-race.js';
import {
  TypeOrmIdentityStore,
  createIdentityDataSource,
  createIdentityMigrationDataSource,
  runIdentityMigrations,
} from '../../../packages/persistence/identity/src/index.js';

/**
 * The platform on a real MySQL identity store (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL;
 * locally skipped when unset, a hard failure in CI). A second store on its own pool stands in
 * for another process. Only synthetic data; the database and the account are dropped afterwards.
 */
const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrlValue && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; MySQL integration must not be skipped',
  );
const suite = adminUrlValue ? describe : describe.skip;

const identifier = (value: string): string => {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('test generated an invalid identifier');
  return `\`${value}\``;
};

suite('platform on a real MySQL identity store', () => {
  const suffix = `${Date.now()}_${process.pid}`;
  const databaseName = `opslog_plat_${suffix}`;
  const runtimeUser = `opslog_identity_${createHash('sha256').update(suffix).digest('hex').slice(0, 16)}`;
  const runtimePassword = randomBytes(24).toString('base64url');
  const verifier = new FakeOidcVerifier();
  let nonces = 0;
  let admin: mysql.Connection;
  let config: { host: string; port: number; user: string; password: string };
  const sources: ReturnType<typeof createIdentityDataSource>[] = [];
  let storeA: TypeOrmIdentityStore;
  let storeB: TypeOrmIdentityStore;
  let platform: Platform;

  const principal = async (subject: string) => {
    const nonce = `nonce-${(nonces += 1)}`;
    const result = await platform.verifyPrincipal(verifier.issueCode(subject, nonce), nonce);
    if (!result.value) throw new Error('principal fixture failed');
    return result.value;
  };
  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, params))[0] as T[];
  /** Tenant with its first administrator signed in. */
  const tenant = async (tag: string) => {
    const created = await platform.bootstrapTenant({
      name: `Empresa ${tag}`,
      adminPrincipal: await principal(`admin-${tag}`),
    });
    if (!created.value) throw new Error('tenant fixture failed');
    const login = await platform.signIn(await principal(`admin-${tag}`));
    if (!login.value) throw new Error('login fixture failed');
    return {
      tenantId: created.value.tenantId,
      adminId: created.value.adminIdentityId,
      token: login.value.token,
    };
  };

  beforeAll(async () => {
    const url = new URL(adminUrlValue as string);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
      throw new Error('synthetic MySQL admin URL must use a loopback host');
    config = {
      host,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username) || 'root',
      password: decodeURIComponent(url.password),
    };
    admin = await mysql.createConnection({ ...config, database: 'mysql' });
    await admin.query(`CREATE DATABASE ${identifier(databaseName)} CHARACTER SET utf8mb4`);
    await admin.query(`CREATE USER '${runtimeUser}'@'%' IDENTIFIED BY ?`, [runtimePassword]);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${identifier(databaseName)}.* TO '${runtimeUser}'@'%'`,
    );
    const migrations = createIdentityMigrationDataSource({
      host: config.host,
      port: config.port,
      database: databaseName,
      username: config.user,
      password: config.password,
    });
    await migrations.initialize();
    try {
      await runIdentityMigrations(migrations);
    } finally {
      await migrations.destroy();
    }
    await admin.changeUser({ database: databaseName });
    const open = async () => {
      const source = createIdentityDataSource({
        host: config.host,
        port: config.port,
        database: databaseName,
        username: runtimeUser,
        password: runtimePassword,
        connectionLimit: 6,
      });
      await source.initialize();
      sources.push(source);
      return new TypeOrmIdentityStore(source);
    };
    storeA = await open();
    storeB = await open();
    platform = createPlatform({
      verifier,
      issuer: verifier.issuer,
      grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
      adapters: { identityStore: storeA, tenants: new InMemoryTenantStore() },
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(sources.map((source) => source.destroy()));
    if (admin) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)}`);
      await admin.query(`DROP USER IF EXISTS '${runtimeUser}'@'%'`);
      await admin.end();
    }
  }, 60_000);

  it('revokes a pending administrator invitation and the token can no longer be accepted', async () => {
    const a = await tenant('revoke');
    const invited = (await platform.inviteUser(a.token, 'corr-1', 'admin')).value!;
    expect((await platform.removeMember(a.token, 'corr-2', invited.identityId)).ok).toBe(true);
    const stored = await rows<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM opslog_identity_invitations WHERE identity_id = ?',
      [invited.identityId],
    );
    expect(stored[0]?.consumed_at).toBeInstanceOf(Date);
    const accepted = await platform.acceptInvitation(
      invited.invitationToken,
      await principal('stray-revoke'),
    );
    expect(accepted.error?.code).toBe('unauthorized');
    expect((await platform.signIn(await principal('stray-revoke'))).ok).toBe(false);
    const admins = await rows<{ c: number | string }>(
      "SELECT COUNT(*) c FROM opslog_identity_memberships WHERE tenant_id = ? AND role = 'admin' AND status = 'active'",
      [a.tenantId],
    );
    expect(Number(admins[0]?.c)).toBe(1);
  });

  it('refuses a redemption in a suspended tenant without touching the database', async () => {
    const a = await tenant('suspend');
    const invited = (await platform.inviteUser(a.token, 'corr-3', 'editor')).value!;
    const snapshot = async () =>
      JSON.stringify([
        await rows('SELECT * FROM opslog_identity_invitations WHERE tenant_id = ?', [a.tenantId]),
        await rows('SELECT * FROM opslog_identity_memberships WHERE tenant_id = ?', [a.tenantId]),
        await rows('SELECT * FROM opslog_identity_identities WHERE id = ?', [invited.identityId]),
      ]);
    const before = await snapshot();
    await platform.suspendTenant(a.tenantId);
    const refused = await platform.acceptInvitation(
      invited.invitationToken,
      await principal('late-suspend'),
    );
    expect(refused.error?.code).toBe('unauthorized');
    expect(await snapshot()).toBe(before);
    await platform.reactivateTenant(a.tenantId);
    expect(
      (await platform.acceptInvitation(invited.invitationToken, await principal('late-suspend')))
        .ok,
    ).toBe(true);
    expect(await storeA.findRole(a.tenantId, invited.identityId)).toBe('editor');
  });

  it('does not let a stale directory role outlive a demotion made by another process', async () => {
    const a = await tenant('drift');
    const invited = (await platform.inviteUser(a.token, 'corr-4', 'admin')).value!;
    const accepted = await platform.acceptInvitation(
      invited.invitationToken,
      await principal('second-drift'),
    );
    const second = accepted.value!.identityId;
    const secondLogin = (await platform.signIn(await principal('second-drift'))).value!;
    expect((await platform.listMembers(secondLogin.token, 'corr-5')).ok).toBe(true);
    // Another process demotes the second administrator: their session ends and a new sign-in is
    // refused, instead of granting manage_users from the stale in-memory directory.
    expect(await storeB.setRole(a.tenantId, second, 'viewer')).toBe(true);
    expect((await platform.session(secondLogin.token, 'corr-6')).error?.code).toBe('unauthorized');
    expect((await platform.signIn(await principal('second-drift'))).ok).toBe(false);
    expect((await platform.listMembers(a.token, 'corr-7')).ok).toBe(true);
  });
  it.each<Order>(['accept-first', 'revoke-first'])(
    'keeps directory, MySQL rows, audit and last administrator consistent when accept races revoke (%s)',
    async (order) => {
      for (let round = 0; round < 3; round += 1) {
        const latency = withLatency(storeA, { activateInvitation: 1, revokeMembership: 10 });
        const racing = createPlatform({
          verifier,
          issuer: verifier.issuer,
          grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
          adapters: { identityStore: latency.store as never, tenants: new InMemoryTenantStore() },
        });
        const principalFor = async (subject: string) => {
          const nonce = `nonce-${(nonces += 1)}`;
          return (await racing.verifyPrincipal(verifier.issueCode(subject, nonce), nonce)).value;
        };
        await raceAcceptAndRevoke(
          {
            platform: racing,
            principal: principalFor,
            findMembership: (tenantId, identityId) => storeB.findMembership(tenantId, identityId),
            started: latency.started,
          },
          `${order}-${round}-${suffix}`,
          order,
        );
      }
    },
  );

  it('never leaves a phantom administrator when accept and revoke start together', async () => {
    for (let round = 0; round < 8; round += 1) {
      const a = await tenant(`together-${round}`);
      const invited = (await platform.inviteUser(a.token, `c-${round}`, 'admin')).value!;
      const invitee = await principal(`invitee-together-${round}`);
      const [accepted, removed] = await Promise.all([
        platform.acceptInvitation(invited.invitationToken, invitee),
        platform.removeMember(a.token, `r-${round}`, invited.identityId),
      ]);
      const stored = await storeB.findMembership(a.tenantId, invited.identityId);
      const role = platform.access.roleOf(a.tenantId, invited.identityId);
      // Either order is legal, but the directory and the database must tell the same story.
      expect(removed.ok).toBe(true);
      expect(role === null, `accepted=${accepted.ok}`).toBe(stored?.status !== 'active');
      expect(stored?.status).toBe('revoked');
      expect(platform.access.activeAdmins(a.tenantId)).toEqual([a.adminId]);
      expect(
        Number(
          (
            await rows<{ c: number | string }>(
              "SELECT COUNT(*) c FROM opslog_identity_memberships WHERE tenant_id = ? AND role = 'admin' AND status = 'active'",
              [a.tenantId],
            )
          )[0]?.c,
        ),
      ).toBe(1);
    }
  });
});
