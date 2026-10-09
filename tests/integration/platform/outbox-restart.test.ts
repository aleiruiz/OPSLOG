import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStore } from '../../../packages/platform/audit/src/index.js';
import { Worker } from '../../../apps/worker/base/src/index.js';
import {
  AUDIT_TABLES,
  createAuditMigrationDataSource,
  createAuditRelayDataSource,
  createAuditRuntimeDataSource,
  MySqlTenantOutboxStore,
  runAuditMigrations,
  type AuditDatabaseConfig,
} from '../../../packages/persistence/audit/src/index.js';

const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrl && process.env.CI)
  throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required for durable outbox integration');

function adminConfig(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'mysql:' ||
    (!['localhost', '127.0.0.1', '::1'].includes(host) &&
      process.env.OPSLOG_TEST_MYSQL_ALLOW_REMOTE !== '1')
  )
    throw new Error('synthetic MySQL admin URL must use a loopback host');
  return {
    host,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username) || 'root',
    password: decodeURIComponent(url.password),
  };
}

const identifier = (value: string) => {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('invalid synthetic identifier');
  return `\`${value}\``;
};

function withCredential(
  config: Omit<AuditDatabaseConfig, 'password'>,
  credential: string,
): AuditDatabaseConfig {
  return Object.assign({}, config, { password: credential });
}

describe.skipIf(!adminUrl)('durable outbox worker on synthetic MySQL 8', () => {
  const tenantId = 'tenant-outbox-restart';
  const now = 1_800_000_000_000;
  let admin: mysql.Connection;
  let database: string;
  let runtimeUser: string;
  let workerUser: string;
  let migratorUser: string;
  let runtimeCredential: string;
  let workerCredential: string;
  let migratorCredential: string;
  let runtime: ReturnType<typeof createAuditRuntimeDataSource>;
  let workerSource: ReturnType<typeof createAuditRelayDataSource>;
  let migrator: ReturnType<typeof createAuditMigrationDataSource>;

  beforeAll(async () => {
    const settings = adminConfig(adminUrl as string);
    const suffix = createHash('sha256')
      .update(`${Date.now()}:${randomBytes(8).toString('hex')}`)
      .digest('hex')
      .slice(0, 18);
    const accountSuffix = suffix.slice(0, 8);
    database = `opslog_t_outbox_${suffix}`;
    runtimeUser = `opslog_audit_runtime_${accountSuffix}`;
    workerUser = `opslog_audit_relay_${accountSuffix}`;
    migratorUser = `opslog_audit_migrator_${accountSuffix}`;
    runtimeCredential = randomBytes(24).toString('base64url');
    workerCredential = randomBytes(24).toString('base64url');
    migratorCredential = randomBytes(24).toString('base64url');
    admin = await mysql.createConnection({ ...settings, database: 'mysql' });
    const [versions] = await admin.query('SELECT VERSION() AS version');
    if (!/^8\./.test((versions as { version: string }[])[0]?.version ?? ''))
      throw new Error('durable outbox integration requires synthetic MySQL 8');
    await admin.query(`CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4`);
    for (const [user, credential] of [
      [runtimeUser, runtimeCredential],
      [workerUser, workerCredential],
      [migratorUser, migratorCredential],
    ])
      await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY ?`, [credential]);
    await admin.query(
      `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, CREATE ROUTINE, ALTER ROUTINE ON ${identifier(database)}.* TO '${migratorUser}'@'%'`,
    );
    const baseConfig: Omit<AuditDatabaseConfig, 'password'> = {
      host: settings.host,
      port: settings.port,
      database,
      username: migratorUser,
    };
    const config = withCredential(baseConfig, migratorCredential);
    migrator = createAuditMigrationDataSource(config);
    await migrator.initialize();
    await runAuditMigrations(migrator);
    const outboxTable = `${identifier(database)}.${identifier(AUDIT_TABLES.outbox)}`;
    await admin.query(`GRANT SELECT, INSERT ON ${outboxTable} TO '${runtimeUser}'@'%'`);
    await admin.query(`GRANT SELECT ON ${outboxTable} TO '${workerUser}'@'%'`);
    await admin.query(
      `GRANT UPDATE (status, attempts, available_at, lease_until, fencing, worker_id, last_error, handler_completed) ON ${outboxTable} TO '${workerUser}'@'%'`,
    );
    const auditLocal = `${identifier(database)}.${identifier(AUDIT_TABLES.local)}`;
    const auditDelivery = `${identifier(database)}.${identifier(AUDIT_TABLES.delivery)}`;
    const auditProjection = `${identifier(database)}.${identifier(AUDIT_TABLES.projection)}`;
    const auditRegistry = `${identifier(database)}.${identifier(AUDIT_TABLES.registry)}`;
    await admin.query(`GRANT SELECT ON ${auditLocal} TO '${workerUser}'@'%'`);
    await admin.query(`GRANT SELECT ON ${auditDelivery} TO '${workerUser}'@'%'`);
    await admin.query(`GRANT SELECT, INSERT ON ${auditRegistry} TO '${workerUser}'@'%'`);
    await admin.query(`GRANT INSERT ON ${auditProjection} TO '${workerUser}'@'%'`);
    await admin.query(`GRANT UPDATE ON ${auditDelivery} TO '${workerUser}'@'%'`);
    runtime = createAuditRuntimeDataSource(
      withCredential({ ...baseConfig, username: runtimeUser }, runtimeCredential),
    );
    workerSource = createAuditRelayDataSource(
      withCredential({ ...baseConfig, username: workerUser }, workerCredential),
    );
    await Promise.all([runtime.initialize(), workerSource.initialize()]);
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([runtime?.destroy(), workerSource?.destroy(), migrator?.destroy()]);
    if (admin) {
      await admin.changeUser({ database: 'mysql' });
      if (database) await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
      for (const user of [runtimeUser, workerUser, migratorUser])
        if (user) await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await admin.end();
    }
  });

  const newStore = () =>
    new MySqlTenantOutboxStore(
      () => [tenantId],
      () => runtime,
      () => workerSource,
      () => now,
      () => 0.5,
    );
  const enqueue = (store: MySqlTenantOutboxStore, eventId: string) =>
    store.transaction((tx) =>
      tx.enqueue({
        eventId,
        tenantId,
        type: 'synthetic.worker-job',
        payload: { value: eventId },
        occurredAt: new Date(now).toISOString(),
        idempotencyKey: eventId,
      }),
    );
  const tenantDirectory = { status: () => 'active' as const };

  it('does not replay a completed handler when a restarted worker retries failed audit append', async () => {
    const firstStore = newStore();
    const eventId = 'worker-restart-event';
    await enqueue(firstStore, eventId);
    let handlerCalls = 0;
    let failAudit = true;
    let auditCalls = 0;
    const audit: AuditStore = {
      append: async () => {
        auditCalls += 1;
        if (failAudit) throw new Error('synthetic audit outage');
      },
      list: async () => [],
    };
    const firstWorker = new Worker(
      firstStore,
      tenantDirectory,
      audit,
      'worker-before-restart',
      10,
      6,
      () => now,
    );
    firstWorker.register('synthetic.worker-job', async () => void (handlerCalls += 1));
    await expect(firstWorker.process(now)).resolves.toBe(true);
    expect(handlerCalls).toBe(1);
    expect(await firstStore.get(tenantId, eventId)).toMatchObject({
      status: 'processing',
      handlerCompleted: true,
      fencing: 1,
    });

    const restartedStore = newStore();
    expect(await restartedStore.reconcile(now + 11)).toBe(1);
    failAudit = false;
    const restartedWorker = new Worker(
      restartedStore,
      tenantDirectory,
      audit,
      'worker-after-restart',
      10,
      6,
      () => now + 11,
    );
    restartedWorker.register('synthetic.worker-job', async () => void (handlerCalls += 1));
    await expect(restartedWorker.process(now + 11)).resolves.toBe(true);
    expect(handlerCalls).toBe(1);
    expect(auditCalls).toBe(2);
    expect(await restartedStore.get(tenantId, eventId)).toMatchObject({
      status: 'delivered',
      handlerCompleted: true,
      fencing: 2,
    });
  });

  it('serializes concurrent claims for one event and rejects the expired worker fence', async () => {
    const firstStore = newStore();
    const secondStore = newStore();
    const eventId = 'concurrent-fence-event';
    await enqueue(firstStore, eventId);
    const claims = await Promise.all([
      firstStore.claim(now, 10, 'worker-a'),
      secondStore.claim(now, 10, 'worker-b'),
    ]);
    const validClaims = claims.filter((claim) => claim !== undefined);
    expect(validClaims).toHaveLength(1);
    const first = validClaims[0]!;

    expect(await secondStore.reconcile(now + 11)).toBe(1);
    const second = await secondStore.claim(now + 11, 10, 'worker-b');
    expect(second?.fencing).toBeGreaterThan(first.fencing);
    await expect(firstStore.markHandlerCompleted(tenantId, eventId, first.fencing)).rejects.toThrow(
      'stale fencing',
    );
    await secondStore.markHandlerCompleted(tenantId, eventId, second!.fencing);
    await secondStore.acknowledge(tenantId, eventId, second!.fencing);
    expect(await secondStore.get(tenantId, eventId)).toMatchObject({ status: 'delivered' });
  });
});
