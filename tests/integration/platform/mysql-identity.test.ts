import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeOidcVerifier,
  InMemoryAuditStore,
  InMemoryTenantStore,
  createPlatform,
  type Platform,
} from '../../../apps/api/composition/src/index.js';
import { withLatency } from './latency.js';
import { raceAcceptAndRevoke, type Order } from './invitation-race.js';
import {
  IDENTITY_TABLES,
  TypeOrmIdentityStore,
  createIdentityDataSource,
  createIdentityMigrationDataSource,
  runIdentityMigrations,
} from '../../../packages/persistence/identity/src/index.js';
import {
  AUDIT_TABLES,
  appendLocalAuditAndDelivery,
  createMySqlAuditRuntime,
} from '../../../packages/persistence/audit/src/index.js';

/**
 * The platform on a real MySQL identity store (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL;
 * locally skipped when unset, a hard failure in CI). A second store on its own pool stands in
 * for another process. Only synthetic data; the database and the account are dropped afterwards.
 */
const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
const allowRemote = process.env.OPSLOG_TEST_MYSQL_ALLOW_REMOTE === '1';
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
  const databaseName = `opslog_t_synthetic_${suffix}`;
  const runtimeUser = `opslog_identity_${createHash('sha256').update(suffix).digest('hex').slice(0, 16)}`;
  const runtimePassword = randomBytes(24).toString('base64url');
  const verifier = new FakeOidcVerifier();
  let nonces = 0;
  let admin: mysql.Connection;
  let config: { host: string; port: number; user: string; password: string };
  let tenants: InMemoryTenantStore;
  const sources: ReturnType<typeof createIdentityDataSource>[] = [];
  let storeA: TypeOrmIdentityStore;
  let storeB: TypeOrmIdentityStore;
  let platform: Platform;
  let auditRuntime: ReturnType<typeof createMySqlAuditRuntime>;

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
    if (
      url.protocol !== 'mysql:' ||
      (!['localhost', '127.0.0.1', '::1'].includes(host) && !allowRemote)
    )
      throw new Error('synthetic MySQL admin URL must use a loopback host');
    config = {
      host,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username) || 'root',
      password: decodeURIComponent(url.password),
    };
    tenants = new InMemoryTenantStore();
    const auditSource = () => {
      const source = sources[0];
      if (!source) throw new Error('synthetic audit DataSource is unavailable');
      return source;
    };
    auditRuntime = createMySqlAuditRuntime({
      listTenantIds: () => tenants.all().map((tenant) => tenant.id),
      resolveRuntime: auditSource,
      resolveRelay: auditSource,
      resolveReader: auditSource,
    });
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
      ...auditRuntime.identitySchema,
    });
    await migrations.initialize();
    try {
      await runIdentityMigrations(migrations);
    } finally {
      await migrations.destroy();
    }
    await admin.query(
      `GRANT EXECUTE ON PROCEDURE ${identifier(databaseName)}.\`opslog_append_local_audit_and_delivery\` TO '${runtimeUser}'@'%'`,
    );
    await admin.changeUser({ database: databaseName });
    const open = async () => {
      const source = createIdentityDataSource({
        host: config.host,
        port: config.port,
        database: databaseName,
        username: runtimeUser,
        password: runtimePassword,
        connectionLimit: 6,
        ...auditRuntime.identitySchema,
      });
      await source.initialize();
      sources.push(source);
      return new TypeOrmIdentityStore(source, { appendAudit: auditRuntime.appendIdentityAudit });
    };
    storeA = await open();
    storeB = await open();
    platform = createPlatform({
      verifier,
      issuer: verifier.issuer,
      grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
      adapters: {
        identityStore: storeA,
        tenants,
        ...auditRuntime,
      },
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

  it('persists invitation and role audit in MySQL before the concrete tenant relay publishes them', async () => {
    const a = await tenant('audit-relay');
    const invited = await platform.inviteUser(a.token, 'audit-invite', 'editor');
    expect(invited.ok).toBe(true);
    const invitationEvents = await rows<{ event_id: string; entity_id: string }>(
      `SELECT event_id, entity_id FROM ${identifier(AUDIT_TABLES.local)} WHERE tenant_id = ? AND action = 'user.invited'`,
      [a.tenantId],
    );
    expect(invitationEvents).toMatchObject([{ entity_id: invited.value?.identityId }]);
    expect(
      await rows<{ status: string }>(
        `SELECT status FROM ${identifier(AUDIT_TABLES.delivery)} WHERE tenant_id = ? AND event_id = ?`,
        [a.tenantId, invitationEvents[0]?.event_id],
      ),
    ).toEqual([{ status: 'pending' }]);
    expect(await platform.listAudit(a.token, 'audit-list-before-relay')).toMatchObject({
      ok: true,
      value: [],
    });

    expect(await platform.runtime.runAuditRelay(20)).toBeGreaterThan(0);
    expect(await platform.listAudit(a.token, 'audit-list-after-relay')).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          action: 'user.invited',
          entityId: invited.value?.identityId,
        }),
      ]),
    });
  });

  it('fails closed after API restart without consuming or auditing a persisted invitation', async () => {
    const a = await tenant('restart-fail-closed');
    const invitation = (await platform.inviteUser(a.token, 'restart-invite', 'editor')).value!;
    const restartedPlatform = createPlatform({
      verifier,
      issuer: verifier.issuer,
      grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
      adapters: {
        identityStore: storeB,
        tenants,
        ...createMySqlAuditRuntime({
          listTenantIds: () => tenants.all().map((entry) => entry.id),
          resolveRuntime: () => sources[0]!,
          resolveRelay: () => sources[0]!,
          resolveReader: () => sources[0]!,
        }),
      },
    });
    const nonce = `restart-nonce-${(nonces += 1)}`;
    const verified = await restartedPlatform.verifyPrincipal(
      verifier.issueCode('restart-invitee', nonce),
      nonce,
    );
    expect(verified.value).toBeDefined();
    const refused = await restartedPlatform.acceptInvitation(
      invitation.invitationToken,
      verified.value,
    );
    expect(refused.error?.code).toBe('unauthorized');
    expect(
      await rows<{ status: string }>(
        'SELECT status FROM opslog_identity_memberships WHERE tenant_id = ? AND identity_id = ?',
        [a.tenantId, invitation.identityId],
      ),
    ).toEqual([{ status: 'pending' }]);
    expect(
      await rows(
        `SELECT event_id FROM ${identifier(AUDIT_TABLES.local)} WHERE action = 'user.joined' AND entity_id = ?`,
        [invitation.identityId],
      ),
    ).toHaveLength(0);
    const accepted = await platform.acceptInvitation(invitation.invitationToken, verified.value);
    expect(accepted).toMatchObject({
      ok: true,
      value: { identityId: invitation.identityId, tenantId: a.tenantId },
    });
    const audits = await rows<{ action: string; entity_id: string; tenant_id: string }>(
      `SELECT action, entity_id, tenant_id FROM ${identifier(AUDIT_TABLES.local)} WHERE action = 'user.joined' AND entity_id = ?`,
      [invitation.identityId],
    );
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'user.joined',
        entity_id: invitation.identityId,
        tenant_id: a.tenantId,
      }),
    ]);
    expect(await platform.signIn(verified.value)).toMatchObject({ ok: true });
  });

  it('rolls back identity, membership, invitation and local audit when the audit append fails', async () => {
    const a = await tenant('audit-rollback');
    const failingStore = new TypeOrmIdentityStore(sources[0]!, {
      appendAudit: async (manager, event) => {
        await appendLocalAuditAndDelivery(manager, { ...event, data: {} });
        throw new Error('synthetic audit failure');
      },
    });
    const failingPlatform = createPlatform({
      verifier,
      issuer: verifier.issuer,
      grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
      adapters: {
        identityStore: failingStore,
        tenants,
        audit: new InMemoryAuditStore(),
        auditRelay: { runBatch: async () => 0 },
      },
    });
    const counts = async () => ({
      identities: (
        await rows<{ total: number }>(
          `SELECT COUNT(*) AS total FROM ${identifier(IDENTITY_TABLES.identities)}`,
        )
      )[0]?.total,
      memberships: (
        await rows<{ total: number }>(
          `SELECT COUNT(*) AS total FROM ${identifier(IDENTITY_TABLES.memberships)} WHERE tenant_id = ?`,
          [a.tenantId],
        )
      )[0]?.total,
      invitations: (
        await rows<{ total: number }>(
          `SELECT COUNT(*) AS total FROM ${identifier(IDENTITY_TABLES.invitations)} WHERE tenant_id = ?`,
          [a.tenantId],
        )
      )[0]?.total,
      localAudit: (
        await rows<{ total: number }>(
          `SELECT COUNT(*) AS total FROM ${identifier(AUDIT_TABLES.local)} WHERE tenant_id = ? AND action = 'user.invited'`,
          [a.tenantId],
        )
      )[0]?.total,
      delivery: (
        await rows<{ total: number }>(
          `SELECT COUNT(*) AS total FROM ${identifier(AUDIT_TABLES.delivery)} d JOIN ${identifier(AUDIT_TABLES.local)} a ON a.tenant_id = d.tenant_id AND a.event_id = d.event_id WHERE a.tenant_id = ? AND a.action = 'user.invited'`,
          [a.tenantId],
        )
      )[0]?.total,
    });
    const before = await counts();
    expect(
      await failingPlatform.inviteUser(a.token, 'audit-rollback-correlation', 'editor'),
    ).toMatchObject({
      ok: false,
    });
    expect(await counts()).toEqual(before);
  });

  it('rolls back invitation acceptance, membership revocation and role creation with their audit rows', async () => {
    let failAudit = false;
    const failingStore = new TypeOrmIdentityStore(sources[0]!, {
      appendAudit: async (manager, event) => {
        await appendLocalAuditAndDelivery(manager, { ...event, data: {} });
        if (failAudit) throw new Error('synthetic audit failure');
      },
    });
    const failingPlatform = createPlatform({
      verifier,
      issuer: verifier.issuer,
      grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
      adapters: {
        identityStore: failingStore,
        tenants,
        audit: new InMemoryAuditStore(),
        auditRelay: { runBatch: async () => 0 },
      },
    });
    const a = await (async () => {
      const created = await failingPlatform.bootstrapTenant({
        name: 'Empresa audit-route-rollback',
        adminPrincipal: await principal('admin-audit-route-rollback'),
      });
      if (!created.value) throw new Error('tenant fixture failed');
      const login = await failingPlatform.signIn(await principal('admin-audit-route-rollback'));
      if (!login.value) throw new Error('login fixture failed');
      return { tenantId: created.value.tenantId, token: login.value.token };
    })();
    const invitation = (await failingPlatform.inviteUser(a.token, 'audit-route-invite', 'editor'))
      .value!;
    failAudit = true;
    const beforeAccept = await rows(
      'SELECT * FROM opslog_identity_memberships WHERE tenant_id = ?',
      [a.tenantId],
    );
    expect(
      await failingPlatform.acceptInvitation(
        invitation.invitationToken,
        await principal('invitee-audit-route-rollback'),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await rows('SELECT * FROM opslog_identity_memberships WHERE tenant_id = ?', [a.tenantId]),
    ).toEqual(beforeAccept);
    expect(
      await rows(
        `SELECT * FROM ${identifier(AUDIT_TABLES.local)} WHERE tenant_id = ? AND action = 'user.joined'`,
        [a.tenantId],
      ),
    ).toEqual([]);

    failAudit = false;
    const acceptedInvitation = (
      await failingPlatform.inviteUser(a.token, 'audit-route-revoke-invite', 'editor')
    ).value!;
    const accepted = await failingPlatform.acceptInvitation(
      acceptedInvitation.invitationToken,
      await principal('member-audit-route-revoke'),
    );
    if (!accepted.value) throw new Error('member fixture failed');
    failAudit = true;
    const beforeRevoke = await rows(
      'SELECT * FROM opslog_identity_memberships WHERE tenant_id = ?',
      [a.tenantId],
    );
    expect(
      await failingPlatform.removeMember(a.token, 'audit-route-revoke', accepted.value.identityId),
    ).toMatchObject({ ok: false });
    expect(
      await rows('SELECT * FROM opslog_identity_memberships WHERE tenant_id = ?', [a.tenantId]),
    ).toEqual(beforeRevoke);
    expect(
      await rows(
        `SELECT * FROM ${identifier(AUDIT_TABLES.local)} WHERE tenant_id = ? AND action = 'membership.revoked'`,
        [a.tenantId],
      ),
    ).toEqual([]);

    failAudit = false;
    failAudit = true;
    const roleCount = (
      await rows<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${identifier(IDENTITY_TABLES.roles)} WHERE tenant_id = ?`,
        [a.tenantId],
      )
    )[0]?.total;
    expect(
      await failingPlatform.copyRole(a.token, 'audit-route-copy', 'editor', 'Copied editor'),
    ).toMatchObject({ ok: false });
    expect(
      (
        await rows<{ total: number }>(
          `SELECT COUNT(*) AS total FROM ${identifier(IDENTITY_TABLES.roles)} WHERE tenant_id = ?`,
          [a.tenantId],
        )
      )[0]?.total,
    ).toBe(roleCount);
    expect(
      await rows(
        `SELECT * FROM ${identifier(AUDIT_TABLES.local)} WHERE tenant_id = ? AND action = 'role.copied'`,
        [a.tenantId],
      ),
    ).toEqual([]);
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
          adapters: {
            identityStore: latency.store as never,
            tenants,
            audit: auditRuntime.audit,
            auditRelay: auditRuntime.auditRelay,
          },
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
            flushAudit: () => auditRuntime.auditRelay.runBatch(),
          },
          `${order}-${round}-${suffix}`,
          order,
        );
      }
    },
    30_000,
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
