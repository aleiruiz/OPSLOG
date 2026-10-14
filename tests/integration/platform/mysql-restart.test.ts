import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { START, createBffWorld, type BffWorld } from '../../../apps/api/bff/src/test-support.js';
import { readConfig } from '../../../apps/api/server/src/config.js';
import { readMysqlConfig } from '../../../apps/api/server/src/mysql-config.js';
import {
  ACCOUNT_TAG,
  openPersistentAdapters,
  runMigrate,
} from '../../../apps/api/server/src/persistence.js';
import { bootstrapFirstCompany } from '../../../apps/api/server/src/bootstrap.js';
import { startServer } from '../../../apps/api/server/src/server.js';
import { buildFleetAccounts, type MysqlPlatform } from '../../../apps/api/composition/src/index.js';
import type { RuntimeDescriptor } from '../../../infra/runtime/src/index.js';

/**
 * The deployed API on MySQL survives a restart: the platform is composed exactly as the server
 * does (`runMigrate` + `openPersistentAdapters`), a company and its data are created, everything is
 * closed, and a second composition over the same database signs the same person in and reads the
 * data back. Needs OPSLOG_TEST_MYSQL_ADMIN_URL (a hard failure in CI); only synthetic data.
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

suite('API on MySQL across a restart', () => {
  const database = `opslog_t_restart_${randomBytes(5).toString('hex')}`;
  let admin: mysql.Connection;
  let env: Record<string, string>;
  let open: { persistent: MysqlPlatform; world: BffWorld } | undefined;

  const boot = async () => {
    // The world fakes the clock; the stores must see the same time when they purge expired sessions.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const persistent = await openPersistentAdapters(readMysqlConfig(env));
    const world = createBffWorld({ adapters: persistent.adapters });
    await persistent.hydrate(world.platform);
    open = { persistent, world };
    return open;
  };
  const shutdown = async () => {
    open?.world.dispose();
    await open?.persistent.close();
    open = undefined;
  };

  beforeAll(async () => {
    const url = new URL(adminUrlValue as string);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
      throw new Error('synthetic MySQL admin URL must use a loopback host');
    const connection = {
      host,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username) || 'root',
      password: decodeURIComponent(url.password),
    };
    admin = await mysql.createConnection({ ...connection, database: 'mysql' });
    env = {
      OPSLOG_MYSQL_HOST: host,
      OPSLOG_MYSQL_PORT: String(connection.port),
      OPSLOG_MYSQL_DATABASE: database,
      OPSLOG_MYSQL_ADMIN_USER: connection.user,
      OPSLOG_MYSQL_ROOT_PASSWORD: connection.password,
      OPSLOG_MYSQL_SECRET: randomBytes(32).toString('base64url'),
      OPSLOG_PII_MASTER_KEY: randomBytes(32).toString('base64'),
    };
    await runMigrate(env, () => undefined);
  }, 180_000);

  afterEach(shutdown);

  afterAll(async () => {
    await shutdown();
    if (!admin) return;
    const accounts = buildFleetAccounts(ACCOUNT_TAG, ACCOUNT_TAG, () => '');
    const users = [
      ...Object.values(accounts.runtime),
      accounts.identity,
      accounts.auditMigrator,
      accounts.filesMigrator,
      accounts.maintenanceMigrator,
    ];
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
    for (const { username } of users) await admin.query(`DROP USER IF EXISTS '${username}'@'%'`);
    await admin.end();
  }, 60_000);

  it('keeps the company, the sign-in and every business record after a restart', async () => {
    // The migrate job is idempotent: a second run on an up-to-date database changes nothing.
    await runMigrate(env, () => undefined);

    const first = await boot();
    // First start: the operator's bootstrap (OPSLOG_BOOTSTRAP_*) creates the company and its admin.
    const bootstrap = { companyName: 'Empresa Persistente', adminSubject: 'subject-admin' };
    expect(
      await bootstrapFirstCompany(first.world.platform, first.world.verifier.issuer, bootstrap),
    ).toMatch(/^bootstrap_created/);
    const company = { tenantId: first.persistent.tenantId };
    await first.world.member('subject-admin', 'viewer', 'subject-viewer');
    const adminBrowser = await first.world.loginAs('subject-admin');
    const sessionBefore = await adminBrowser.get('/api/auth/session');
    expect(sessionBefore.status).toBe(200);

    const area = await adminBrowser.post('/api/areas', {
      json: { name: 'Flota Norte', code: null, parentId: null, responsibleIds: [] },
    });
    expect(area.status).toBe(201);
    const vehicle = await adminBrowser.post('/api/vehicles', {
      json: {
        economicNumber: 'PER-001',
        plate: 'PER001',
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId: area.json.id,
        odometerKm: 10,
      },
    });
    expect(vehicle.status).toBe(201);
    const driver = await adminBrowser.post('/api/employees', {
      json: {
        kind: 'driver',
        firstName: 'Ana',
        lastName: 'Perez',
        areaId: area.json.id,
        employeeNumber: 'PER-EMP-1',
        idType: 'ine',
        nationalId: 'SYNTH-ID-1',
        phone: '+52 555 100 0001',
        email: 'persistente@synthetic.example',
        licenseNumber: 'LIC-1',
        licenseType: 'c',
        licenseExpiresOn: '2099-12-31',
      },
    });
    expect(driver.status).toBe(201);
    const policy = await adminBrowser.post('/api/insurance-policies', {
      json: {
        vehicleId: vehicle.json.id,
        insurer: 'Aseguradora Ficticia',
        policyNumber: 'pol-persist',
        coverageType: 'comprehensive',
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      },
    });
    expect(policy.status).toBe(201);

    const adminLogin = await first.world.platform.signIn(
      await first.world.principal('subject-admin'),
    );
    const token = adminLogin.value?.token as string;
    const renamed = await first.world.platform.updateSettings(token, 'corr-settings', {
      name: 'Empresa Renombrada',
      mfa: 'optional',
      sessionIdleHours: 4,
      reason: 'prueba de reinicio',
    });
    expect(renamed.ok).toBe(true);
    // The audit API reads the projection: let the relay copy the local rows into it first.
    await first.world.platform.runtime.runAuditRelay();
    const auditBefore = (await first.world.platform.listAudit(token, 'corr-audit')).value ?? [];
    expect(auditBefore.length).toBeGreaterThan(0);

    await shutdown();

    // ---- restart: new pools, new platform, same database --------------------------------------
    const second = await boot();
    const login = await second.world.platform.signIn(await second.world.principal('subject-admin'));
    expect(login.ok).toBe(true);
    // The browser session of the first run is still valid: identity and control-plane sessions are durable.
    const resumed = second.world.browser();
    for (const [name, value] of adminBrowser.jar) resumed.jar.set(name, value);
    expect((await resumed.get('/api/auth/session')).status).toBe(200);
    const viewerLogin = await second.world.platform.signIn(
      await second.world.principal('subject-viewer'),
    );
    expect(viewerLogin.ok).toBe(true);

    const admin2 = await second.world.loginAs('subject-admin');
    const session = await admin2.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.json.company).toEqual({ id: company.tenantId, name: 'Empresa Renombrada' });

    const areas = await admin2.get('/api/areas');
    expect(areas.text).toContain('Flota Norte');
    const vehicles = await admin2.get('/api/vehicles');
    expect(vehicles.text).toContain('PER-001');
    const employees = await admin2.get(`/api/employees/${driver.json.id as string}`);
    expect(employees.status).toBe(200);
    expect(employees.text).toContain('Ana');
    const policies = await admin2.get('/api/insurance-policies');
    expect(policies.text).toContain('POL-PERSIST');

    const token2 = login.value?.token as string;
    const settings = await second.world.platform.getSettings(token2, 'corr-get');
    expect(settings.value).toMatchObject({
      name: 'Empresa Renombrada',
      mfa: 'optional',
      sessionIdleHours: 4,
      status: 'active',
    });
    const auditAfter = (await second.world.platform.listAudit(token2, 'corr-audit-2')).value ?? [];
    expect(auditAfter.length).toBeGreaterThanOrEqual(auditBefore.length);
    expect(auditAfter.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(auditBefore.map((event) => event.eventId)),
    );

    // The role survived too: the viewer can read but not manage.
    const members = await second.world.platform.listMembers(token2, 'corr-members');
    expect(members.value?.members.map((member) => member.roleId).sort()).toEqual([
      'admin',
      'viewer',
    ]);

    // The same bootstrap on the restarted server finds the administrator and creates nothing.
    expect(
      await bootstrapFirstCompany(second.world.platform, second.world.verifier.issuer, bootstrap),
    ).toMatch(/^bootstrap_skipped/);
    expect(second.world.platform.tenants.all()).toHaveLength(1);

    // The pinned company cannot be provisioned a second time (bootstrap stays idempotent).
    const again = await second.world.platform.bootstrapTenant({
      name: 'Otra Empresa',
      adminPrincipal: await second.world.principal('subject-other'),
    });
    expect(again.ok).toBe(false);
    expect(
      (await second.world.platform.signIn(await second.world.principal('subject-other'))).ok,
    ).toBe(false);
  }, 180_000);

  it('starts the server when the configured bootstrap admin can no longer sign in', async () => {
    const before = await boot();
    const { world } = before;
    // A second administrator removes the original one: the bootstrap subject has no membership left.
    const second = await world.member('subject-admin', 'admin', 'subject-admin-2');
    const token = (await world.platform.signIn(await world.principal('subject-admin-2'))).value
      ?.token as string;
    const members = (await world.platform.listMembers(token, 'corr-m')).value?.members ?? [];
    const original = members.find(
      (member) => member.roleId === 'admin' && member.id !== second.identityId,
    );
    expect(original).toBeDefined();
    expect((await world.platform.removeMember(token, 'corr-rm', original?.id as string)).ok).toBe(
      true,
    );
    expect((await world.platform.signIn(await world.principal('subject-admin'))).ok).toBe(false);
    const tenantsBefore = world.platform.tenants.all().length;
    await shutdown();

    const serverEnv = {
      ...env,
      OPSLOG_ENV: 'staging',
      OPSLOG_PERSISTENCE: 'mysql',
      OPSLOG_PUBLIC_ORIGIN: 'http://localhost:8081',
      OPSLOG_BFF_SECRET: 'b'.repeat(32),
      OPSLOG_GRANT_SECRET: 'g'.repeat(32),
      OPSLOG_BOOTSTRAP_COMPANY: 'Empresa Persistente',
      OPSLOG_BOOTSTRAP_ADMIN_SUB: 'subject-admin',
      PORT: '0',
      HOST: '127.0.0.1',
    };
    const lines: string[] = [];
    const running = await startServer(
      serverEnv,
      readConfig(serverEnv),
      JSON.parse(
        readFileSync(new URL('../../../infra/runtime/staging.json', import.meta.url), 'utf8'),
      ) as RuntimeDescriptor,
      (line) => lines.push(line),
    );
    try {
      expect(lines).toContain(
        'bootstrap_skipped company already exists (configured admin cannot sign in)',
      );
    } finally {
      await running.stop();
    }
    const [rows] = await admin.query(
      `SELECT COUNT(*) AS n FROM ${identifier(database)}.opslog_control_tenants`,
    );
    expect((rows as { n: number }[])[0]?.n).toBe(tenantsBefore);
  }, 120_000);

  it('starts the server on MySQL, answers the health check and closes cleanly', async () => {
    const serverEnv = {
      ...env,
      OPSLOG_ENV: 'staging',
      OPSLOG_PERSISTENCE: 'mysql',
      OPSLOG_PUBLIC_ORIGIN: 'http://localhost:8081',
      OPSLOG_BFF_SECRET: 'b'.repeat(32),
      OPSLOG_GRANT_SECRET: 'g'.repeat(32),
      PORT: '0',
      HOST: '127.0.0.1',
    };
    const lines: string[] = [];
    const running = await startServer(
      serverEnv,
      readConfig(serverEnv),
      JSON.parse(
        readFileSync(new URL('../../../infra/runtime/staging.json', import.meta.url), 'utf8'),
      ) as RuntimeDescriptor,
      (line) => lines.push(line),
    );
    try {
      const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
      expect(health.status).toBe(200);
      await running.tick();
      expect(lines.filter((line) => line.startsWith('worker_tick_failed'))).toEqual([]);
      expect(lines.some((line) => line.startsWith('restored '))).toBe(true);
    } finally {
      await running.stop();
    }
  }, 120_000);
});
