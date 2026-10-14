import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { START, createBffWorld, type BffWorld } from '../../../apps/api/bff/src/test-support.js';
import {
  PersistentTenantStore,
  buildFleetAccounts,
  migrateFleetDatabase,
  openMysqlPlatform,
  type FleetAccountSet,
  type MysqlPlatform,
} from '../../../apps/api/composition/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../packages/platform/pii/src/index.js';

/**
 * The durable control plane on its own: suspension, removal and role changes survive a restart,
 * the pinned company cannot be provisioned twice (except after a failed attempt), and corrupt rows
 * stop the start instead of being guessed at. Needs OPSLOG_TEST_MYSQL_ADMIN_URL; synthetic data only.
 */
const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrlValue && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; MySQL integration must not be skipped',
  );
const suite = adminUrlValue ? describe : describe.skip;

const identifier = (value: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('unsafe synthetic identifier');
  return `\`${value}\``;
};

suite('durable control plane', () => {
  const tag = randomBytes(4).toString('hex');
  const database = `opslog_t_cp_${tag}`;
  const auditTag = tag.slice(0, 8);
  const pii = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
  let admin: mysql.Connection;
  let endpoint: { host: string; port: number; user: string; password: string };
  let accounts: FleetAccountSet;
  let open: { platform: MysqlPlatform; world: BffWorld } | undefined;

  const boot = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const platform = await openMysqlPlatform({
      host: endpoint.host,
      port: endpoint.port,
      database,
      accounts,
      pii,
    });
    const world = createBffWorld({ adapters: platform.adapters });
    await platform.hydrate(world.platform);
    open = { platform, world };
    return open;
  };
  const shutdown = async () => {
    open?.world.dispose();
    await open?.platform.close();
    open = undefined;
  };
  const sql = async (statement: string, params: unknown[] = []) => {
    await admin.changeUser({ database });
    try {
      return (await admin.query(statement, params))[0] as unknown[];
    } finally {
      await admin.changeUser({ database: 'mysql' });
    }
  };

  beforeAll(async () => {
    const url = new URL(adminUrlValue as string);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
      throw new Error('synthetic MySQL admin URL must use a loopback host');
    endpoint = {
      host,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username) || 'root',
      password: decodeURIComponent(url.password),
    };
    admin = await mysql.createConnection({ ...endpoint, database: 'mysql' });
    accounts = buildFleetAccounts(tag, auditTag, () => randomBytes(24).toString('base64url'));
    await migrateFleetDatabase(endpoint, database, accounts);
  }, 180_000);

  afterEach(shutdown);

  afterAll(async () => {
    await shutdown();
    if (!admin) return;
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
    const users = [
      ...Object.values(accounts.runtime),
      accounts.identity,
      accounts.auditMigrator,
      accounts.filesMigrator,
      accounts.maintenanceMigrator,
    ];
    for (const { username } of users) await admin.query(`DROP USER IF EXISTS '${username}'@'%'`);
    await admin.end();
  }, 60_000);

  it('leaves the schema-owning migrator accounts locked after migrate, and migrate is repeatable', async () => {
    const locked = async () => {
      const [rows] = await admin.query(
        'SELECT user, account_locked AS locked FROM mysql.user WHERE user IN (?)',
        [
          [accounts.auditMigrator, accounts.filesMigrator, accounts.maintenanceMigrator].map(
            (a) => a.username,
          ),
        ],
      );
      return (rows as { user: string; locked: string }[]).map((row) => row.locked);
    };
    expect(await locked()).toEqual(['Y', 'Y', 'Y']);
    await migrateFleetDatabase(endpoint, database, accounts);
    expect(await locked()).toEqual(['Y', 'Y', 'Y']);
  }, 120_000);

  it('keeps suspension, removal and role changes across restarts', async () => {
    const first = await boot();
    const tenantId = first.platform.tenantId;
    const created = await first.world.tenant('Empresa Control', 'cp-admin');
    expect(created.tenantId).toBe(tenantId);
    await first.world.member('cp-admin', 'viewer', 'cp-viewer');
    await first.world.member('cp-admin', 'editor', 'cp-editor');
    const adminSession = (
      await first.world.platform.signIn(await first.world.principal('cp-admin'))
    ).value;
    const token = adminSession?.token as string;
    const editorId = (
      await first.world.platform.listMembers(token, 'cp-members')
    ).value?.members.find((member) => member.roleId === 'editor')?.id as string;
    expect((await first.world.platform.changeRole(token, 'cp-role', editorId, 'viewer')).ok).toBe(
      true,
    );
    const viewerId = (await first.world.platform.listMembers(token, 'cp-members-2')).value?.members
      .filter((member) => member.roleId === 'viewer')
      .map((member) => member.id)
      .find((id) => id !== editorId) as string;
    expect((await first.world.platform.removeMember(token, 'cp-remove', viewerId)).ok).toBe(true);
    expect((await first.world.platform.signIn(await first.world.principal('cp-viewer'))).ok).toBe(
      false,
    );
    await first.world.platform.suspendTenant(tenantId);
    await shutdown();

    const second = await boot();
    expect(second.world.platform.tenants.status(tenantId)).toBe('suspended');
    // Suspended: nobody signs in, and the earlier session is refused by the tenant gate.
    expect((await second.world.platform.signIn(await second.world.principal('cp-admin'))).ok).toBe(
      false,
    );
    expect((await second.world.platform.session(token, 'cp-old')).ok).toBe(false);
    await second.world.platform.reactivateTenant(tenantId);
    await shutdown();

    const third = await boot();
    expect(third.world.platform.tenants.status(tenantId)).toBe('active');
    const adminLogin = await third.world.platform.signIn(await third.world.principal('cp-admin'));
    expect(adminLogin.ok).toBe(true);
    // The removed member stays out; the demoted editor kept the viewer role.
    expect((await third.world.platform.signIn(await third.world.principal('cp-viewer'))).ok).toBe(
      false,
    );
    const editorLogin = await third.world.platform.signIn(await third.world.principal('cp-editor'));
    expect(editorLogin.ok).toBe(true);
    const details = await third.world.platform.sessionDetails(
      editorLogin.value?.token as string,
      'cp-details',
    );
    expect(details.value?.roleId).toBe('viewer');
    expect(details.value?.companyName).toBe('Empresa Control');
  }, 120_000);

  it('provisions its pinned company once, and again only after a failed attempt', async () => {
    const { world, platform } = await boot();
    const tenants = world.platform.tenants;
    expect(tenants).toBeInstanceOf(PersistentTenantStore);
    expect(tenants.status(platform.tenantId)).toBe('active');
    await expect(tenants.provision('Otra')).rejects.toThrow('already hosts');
    await expect(tenants.provision('  ')).rejects.toThrow('name is required');
    expect(() => tenants.provisionVerified('Otra')).toThrow('provision()');
    await expect(tenants.setTenantStatus('missing' as never, 'suspended')).rejects.toThrow(
      'unknown tenant',
    );
    await expect(
      tenants.projectMembership(platform.tenantId as never, 'x' as never, 0, 'active'),
    ).rejects.toThrow('positive');

    await tenants.setTenantStatus(platform.tenantId as never, 'failed');
    const retried = await tenants.provision('  Empresa Reintentada ');
    expect(retried).toMatchObject({
      id: platform.tenantId,
      name: 'Empresa Reintentada',
      status: 'active',
    });
    await shutdown();

    const reopened = await boot();
    expect(reopened.world.platform.tenants.all().map((tenant) => tenant.name)).toEqual([
      'Empresa Reintentada',
    ]);
  }, 120_000);

  it('refuses to start on corrupt control-plane rows instead of guessing', async () => {
    const tenantId = (await sql('SELECT id FROM opslog_control_tenants'))[0] as { id: string };
    const original = (await sql('SELECT status FROM opslog_control_tenants'))[0] as {
      status: string;
    };

    await sql("UPDATE opslog_control_tenants SET status = 'bogus'");
    await expect(boot()).rejects.toThrow('unknown status');
    await sql('UPDATE opslog_control_tenants SET status = ?', [original.status]);

    await sql(
      "INSERT INTO opslog_control_tenants (id, name, status, created_at) VALUES ('second-tenant', 'X', 'active', NOW(6))",
    );
    await expect(boot()).rejects.toThrow('more than one company');
    await sql("DELETE FROM opslog_control_tenants WHERE id = 'second-tenant'");

    await sql(
      "INSERT INTO opslog_control_memberships (tenant_id, subject_id, version, status) VALUES (?, 'ghost', 1, 'bogus')",
      [tenantId.id],
    );
    await expect(boot()).rejects.toThrow('unknown status');
    await sql("UPDATE opslog_control_memberships SET status = 'active' WHERE subject_id = 'ghost'");
    // An active projection without a stored role grants nothing: the ghost is simply not restored.
    const healthy = await boot();
    expect(healthy.world.platform.access.roleOf(tenantId.id, 'ghost')).toBeNull();
    await shutdown();
    await sql("DELETE FROM opslog_control_memberships WHERE subject_id = 'ghost'");

    await sql(
      "INSERT INTO opslog_control_tenant_settings (tenant_id, name, mfa, session_idle_hours) VALUES (?, 'X', 'bogus', 8)",
      [tenantId.id],
    );
    await expect(boot()).rejects.toThrow('unknown MFA policy');
    await sql('DELETE FROM opslog_control_tenant_settings WHERE mfa = ?', ['bogus']);
    await boot();
  }, 120_000);
});
