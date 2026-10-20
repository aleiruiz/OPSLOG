import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildFleetAccounts,
  deriveAccountPassword,
  expectedMigrations,
} from '../../apps/api/composition/src/index.js';
import { readConfig } from '../../apps/api/server/src/config.js';
import { createOpsProbe } from '../../apps/api/server/src/ops.js';
import { runMigrate } from '../../apps/api/server/src/persistence.js';
import { startServer, type RunningServer } from '../../apps/api/server/src/server.js';
import { OPS_STAT_KEYS } from '../../packages/platform/observability/src/index.js';
import type { RuntimeDescriptor } from '../../infra/runtime/src/index.js';

/**
 * Readiness, counters and the least-privilege accounts against a real MySQL: the migrate job as the
 * deployment runs it, then the API on the result. Needs OPSLOG_TEST_MYSQL_ADMIN_URL (a hard failure
 * in CI); only synthetic data.
 */
const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrlValue && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; MySQL integration must not be skipped',
  );
const suite = adminUrlValue ? describe : describe.skip;

// Own account names: another suite using the same MySQL in the same vitest call must not collide.
const TAG = `p${randomBytes(3).toString('hex')}`;
const BACKUP_USER = `opslog_backup_${TAG}`;
const BACKUP_PASSWORD = randomBytes(24).toString('base64url');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (name: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('unsafe synthetic identifier');
  return `\`${name}\``;
};

suite('readiness, counters and accounts on MySQL', () => {
  const database = `opslog_t_ops_${randomBytes(5).toString('hex')}`;
  let admin: mysql.Connection;
  let host: string;
  let port: number;
  let env: Record<string, string>;
  let running: RunningServer | undefined;

  const asAccount = (user: string, password: string, extra: mysql.ConnectionOptions = {}) =>
    mysql.createConnection({ host, port, user, password, ...extra });
  const base = () => `http://127.0.0.1:${running?.port}`;
  const start = async (lines: string[] = []) => {
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
    running = await startServer(
      serverEnv,
      readConfig(serverEnv),
      JSON.parse(
        readFileSync(new URL('../../infra/runtime/staging.json', import.meta.url), 'utf8'),
      ) as RuntimeDescriptor,
      (line) => lines.push(line),
    );
    return lines;
  };

  beforeAll(async () => {
    const url = new URL(adminUrlValue as string);
    host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
      throw new Error('synthetic MySQL admin URL must use a loopback host');
    port = Number(url.port || 3306);
    const user = decodeURIComponent(url.username) || 'root';
    const password = decodeURIComponent(url.password);
    admin = await mysql.createConnection({ host, port, user, password, database: 'mysql' });
    env = {
      OPSLOG_MYSQL_HOST: host,
      OPSLOG_MYSQL_PORT: String(port),
      OPSLOG_MYSQL_DATABASE: database,
      OPSLOG_MYSQL_ADMIN_USER: user,
      OPSLOG_MYSQL_ROOT_PASSWORD: password,
      OPSLOG_MYSQL_SECRET: randomBytes(32).toString('base64url'),
      OPSLOG_PII_MASTER_KEY: randomBytes(32).toString('base64'),
      OPSLOG_BACKUP_PASSWORD: BACKUP_PASSWORD,
      OPSLOG_MYSQL_ACCOUNT_TAG: TAG,
      OPSLOG_BACKUP_USER: BACKUP_USER,
    };
    await runMigrate(env, () => undefined);
  }, 240_000);

  afterEach(async () => {
    vi.useRealTimers();
    await running?.stop();
    running = undefined;
  });

  afterAll(async () => {
    if (!admin) return;
    const accounts = buildFleetAccounts(TAG, TAG, () => '');
    const users = [
      ...Object.values(accounts.runtime),
      accounts.identity,
      accounts.ops,
      accounts.auditMigrator,
      accounts.filesMigrator,
      accounts.maintenanceMigrator,
      { username: BACKUP_USER },
    ];
    await admin.query(`DROP DATABASE IF EXISTS ${quote(database)}`);
    for (const { username } of users) await admin.query(`DROP USER IF EXISTS '${username}'@'%'`);
    await admin.end();
  }, 60_000);

  it('answers /readyz 200 on a migrated database and keeps /healthz independent of it', async () => {
    const lines = await start();
    const ready = await fetch(`${base()}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    expect((await fetch(`${base()}/healthz`)).status).toBe(200);
    expect(lines.map((line) => JSON.parse(line).level)).not.toContain('error');
  }, 60_000);

  it('answers 503 migration_pending when a migrations table is behind, and recovers', async () => {
    await start();
    const table = '`opslog_webhooks_migrations`';
    const [saved] = await admin.query(
      `SELECT id, timestamp, name FROM ${quote(database)}.${table}`,
    );
    const rows = saved as { id: number; timestamp: string; name: string }[];
    await admin.query(`DELETE FROM ${quote(database)}.${table}`);
    try {
      const pending = await fetch(`${base()}/readyz`);
      expect(pending.status).toBe(503);
      expect(await pending.json()).toEqual({ status: 'unready', code: 'migration_pending' });
      expect((await fetch(`${base()}/healthz`)).status).toBe(200);
    } finally {
      for (const row of rows)
        await admin.query(
          `INSERT INTO ${quote(database)}.${table} (id, timestamp, name) VALUES (?, ?, ?)`,
          [row.id, row.timestamp, row.name],
        );
    }
    expect((await fetch(`${base()}/readyz`)).status).toBe(200);
  }, 60_000);

  it('answers 503 db_unreachable when the probe account cannot connect, and 200 once it can', async () => {
    await start();
    const ops = buildFleetAccounts(TAG, TAG, () => '').ops.username;
    await admin.query(`ALTER USER '${ops}'@'%' ACCOUNT LOCK`);
    try {
      const down = await fetch(`${base()}/readyz`);
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ status: 'unready', code: 'db_unreachable' });
      expect((await fetch(`${base()}/healthz`)).status).toBe(200);
    } finally {
      await admin.query(`ALTER USER '${ops}'@'%' ACCOUNT UNLOCK`);
    }
    expect((await fetch(`${base()}/readyz`)).status).toBe(200);
  }, 60_000);

  it('answers 503 worker_stalled when no tick finished for a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await start();
    vi.setSystemTime(Date.now() + 61_000);
    const stalled = await fetch(`${base()}/readyz`);
    expect(stalled.status).toBe(503);
    expect(await stalled.json()).toEqual({ status: 'unready', code: 'worker_stalled' });
    await running?.tick();
    expect((await fetch(`${base()}/readyz`)).status).toBe(200);
  }, 60_000);

  it('writes one ops_stats line with every counter as a number', async () => {
    const lines = await start();
    await running?.stats();
    const stats = lines.map((line) => JSON.parse(line)).find((event) => event.msg === 'ops_stats');
    expect(Object.keys(stats.stats).sort()).toEqual([...OPS_STAT_KEYS].sort());
    for (const value of Object.values(stats.stats)) expect(Number.isInteger(value)).toBe(true);
    expect(stats.stats.dbConnections).toBeGreaterThanOrEqual(1);
    expect(stats.companyRef).toMatch(/^c_[0-9a-f]{16}$/);
  }, 60_000);

  it('counts dead-lettered and retrying webhook deliveries with the read-only account', async () => {
    const ops = buildFleetAccounts(TAG, TAG, () => '').ops;
    const probe = createOpsProbe(
      {
        host,
        port,
        database,
        account: {
          username: ops.username,
          password: deriveAccountPassword(env.OPSLOG_MYSQL_SECRET as string, ops.username),
        },
      },
      expectedMigrations(),
    );
    const before = await probe.stats();
    const db = quote(database);
    await admin.query(
      `INSERT INTO ${db}.opslog_webhook_endpoints (company_id, id, url, events, active, company_ref, secret_sealed, version, created_at, updated_at, created_by)
       VALUES ('c1', 'e1', 'https://hooks.example.com/in', JSON_ARRAY('vehicle.created'), 1, 'co_e1', 'sealed', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), 'ana')`,
    );
    await admin.query(
      `INSERT INTO ${db}.opslog_webhook_deliveries (company_id, id, endpoint_id, event_id, event_type, body, status, attempts, created_at, updated_at)
       VALUES ('c1', 'd1', 'e1', 'ev1', 'vehicle.created', '{}', 'dead_letter', 5, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)),
              ('c1', 'd2', 'e1', 'ev2', 'vehicle.created', '{}', 'failed', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
    );
    try {
      const after = await probe.stats();
      expect(after.webhooksDeadLetter).toBe(before.webhooksDeadLetter + 1);
      expect(after.webhooksPending).toBe(before.webhooksPending + 1);
      expect(await probe.readiness()).toBe('ok');
    } finally {
      await admin.query(`DELETE FROM ${db}.opslog_webhook_deliveries`);
      await admin.query(`DELETE FROM ${db}.opslog_webhook_endpoints`);
    }
  }, 60_000);

  it('reports migration_pending against a newer build and db_unreachable on a wrong password', async () => {
    const ops = buildFleetAccounts(TAG, TAG, () => '').ops.username;
    const password = deriveAccountPassword(env.OPSLOG_MYSQL_SECRET as string, ops);
    const endpoint = { host, port, database, account: { username: ops, password } };
    const newer = [
      ...expectedMigrations(),
      { table: 'opslog_webhooks_migrations', latest: '9999999999999' },
    ];
    expect(await createOpsProbe(endpoint, newer).readiness()).toBe('migration_pending');
    expect(
      await createOpsProbe(
        { ...endpoint, account: { username: ops, password: 'wrong' } },
        expectedMigrations(),
      ).readiness(),
    ).toBe('db_unreachable');
    expect(
      await createOpsProbe(endpoint, [
        { table: 'opslog_not_a_table_migrations', latest: '1' },
      ]).readiness(),
    ).toBe('migration_pending');
  });

  it('keeps the probe account read-only: it reads the queues and migrations, nothing else', async () => {
    const ops = buildFleetAccounts(TAG, TAG, () => '').ops.username;
    const connection = await asAccount(
      ops,
      deriveAccountPassword(env.OPSLOG_MYSQL_SECRET as string, ops),
      { database },
    );
    try {
      await connection.query('SELECT COUNT(*) FROM opslog_tenant_outbox');
      await connection.query('SELECT MAX(timestamp) FROM opslog_vehicles_migrations');
      // Column-level grants: the status columns only, never the payload of a queued message.
      await connection.query('SELECT status, available_at FROM opslog_tenant_outbox LIMIT 1');
      await expect(
        connection.query('SELECT payload FROM opslog_tenant_outbox LIMIT 1'),
      ).rejects.toMatchObject({ errno: 1143 });
      await expect(connection.query('SELECT * FROM opslog_tenant_outbox')).rejects.toMatchObject({
        errno: 1143,
      });
      await expect(connection.query('SELECT 1 FROM opslog_vehicles LIMIT 1')).rejects.toMatchObject(
        { errno: 1142 },
      );
      await expect(connection.query('DELETE FROM opslog_tenant_outbox')).rejects.toMatchObject({
        errno: 1142,
      });
      await expect(connection.query('CREATE TABLE ops_scratch (id INT)')).rejects.toMatchObject({
        errno: 1142,
      });
    } finally {
      await connection.end();
    }
  });

  it('gives the backup account what mysqldump and the binlog copy need and no way to write', async () => {
    const connection = await asAccount(BACKUP_USER, BACKUP_PASSWORD, {
      database,
      multipleStatements: false,
    });
    try {
      // Reading: every table (the dump) and the routines.
      await connection.query('SELECT COUNT(*) FROM opslog_vehicles');
      await connection.query('SHOW CREATE PROCEDURE opslog_append_local_audit_and_delivery');
      await connection.query('SHOW BINARY LOGS').catch((error: { errno?: number }) => {
        // A server with the binary log off has none to list; everything else must succeed.
        expect(error.errno).toBe(1381);
      });
      // Writing: nothing.
      const denied = [
        'INSERT INTO opslog_vehicles_migrations (timestamp, name) VALUES (1, "x")',
        'UPDATE opslog_vehicles_migrations SET name = "x"',
        'DELETE FROM opslog_vehicles_migrations',
        'CREATE TABLE backup_scratch (id INT)',
        'DROP TABLE opslog_vehicles',
        'ALTER TABLE opslog_vehicles ADD COLUMN x INT',
        'TRUNCATE TABLE opslog_vehicles',
        'CREATE DATABASE backup_scratch',
        'CREATE USER backup_intruder IDENTIFIED BY "x"',
        `GRANT ALL ON ${quote(database)}.* TO '${BACKUP_USER}'@'%'`,
        'CALL opslog_append_local_audit_and_delivery()',
      ];
      // TRIGGER is needed by mysqldump; creating one is blocked (1419) while the binary log is on and
      // log_bin_trust_function_creators=0, the compose settings. Asserted only on such a server.
      const [flags] = (await admin.query(
        'SELECT @@log_bin AS bin, @@log_bin_trust_function_creators AS trust',
      )) as unknown as [{ bin: number; trust: number }[]];
      if (flags[0]?.bin === 1 && flags[0].trust === 0)
        await expect(
          connection.query(
            'CREATE TRIGGER backup_trg BEFORE INSERT ON opslog_vehicles_migrations FOR EACH ROW SET NEW.name = "x"',
          ),
        ).rejects.toMatchObject({ errno: 1419 });
      for (const statement of denied)
        await expect(connection.query(statement), statement).rejects.toMatchObject({
          errno: expect.toSatisfy((errno: number) =>
            [1044, 1045, 1142, 1227, 1370, 1410].includes(errno),
          ),
        });
    } finally {
      await connection.end();
    }
    await sleep(0);
  });
});
