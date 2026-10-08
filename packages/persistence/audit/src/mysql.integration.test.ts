import 'reflect-metadata';
import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  AUDIT_TABLES,
  appendAuditProjection,
  appendLocalAuditAndDelivery,
  createMySqlAuditRuntime,
  createAuditMigrationDataSource,
  createAuditRelayDataSource,
  createAuditRuntimeDataSource,
  ensureAuditYearPartition,
  listPendingAuditEventIds,
  MySqlAuditStore,
  MySqlAuditApiStore,
  MySqlAuditRelay,
  relayPendingAuditEvent,
  runAuditMigrations,
  type AuditDatabaseConfig,
} from './index.js';

const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrl && process.env.CI)
  throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; audit MySQL tests cannot skip');

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

interface TenantDb {
  readonly tenantId: string;
  readonly database: string;
  readonly runtimeUser: string;
  readonly relayUser: string;
  readonly migratorUser: string;
  readonly runtimePassword: string;
  readonly relayPassword: string;
  readonly migratorPassword: string;
  readonly admin: mysql.Connection;
  readonly migrationSource: DataSource;
  readonly runtimeSources: DataSource[];
  readonly relaySources: DataSource[];
  readonly config: Omit<AuditDatabaseConfig, 'username' | 'password'>;
  openRuntime(): Promise<DataSource>;
  openRelay(): Promise<DataSource>;
  close(): Promise<void>;
}

async function createTenantDb(label: string): Promise<TenantDb> {
  const suffix = createHash('sha256')
    .update(`${label}:${Date.now()}:${randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 20);
  const accountSuffix = suffix.slice(0, 7);
  const database = `opslog_t_${suffix}`;
  const tenantId = `tenant-${label}`;
  const runtimeUser = `opslog_audit_runtime_${accountSuffix}`;
  const relayUser = `opslog_audit_relay_${accountSuffix}`;
  const migratorUser = `opslog_audit_migrator_${accountSuffix}`;
  const runtimePassword = randomBytes(24).toString('base64url');
  const relayPassword = randomBytes(24).toString('base64url');
  const migratorPassword = randomBytes(24).toString('base64url');
  const admin = await mysql.createConnection({
    ...adminConfig(adminUrl as string),
    database: 'mysql',
  });
  const [versionRows] = await admin.query('SELECT VERSION() AS version');
  if (!/^8\./.test((versionRows as { version: string }[])[0]?.version ?? ''))
    throw new Error('audit integration requires synthetic MySQL 8');
  const adminSettings = adminConfig(adminUrl as string);
  const config = {
    host: adminSettings.host,
    port: adminSettings.port,
    database,
  } as const;
  const migrationSource = createAuditMigrationDataSource({
    ...config,
    username: migratorUser,
    password: migratorPassword,
  });
  const runtimeSources: DataSource[] = [];
  const relaySources: DataSource[] = [];
  await admin.query(`CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4`);
  for (const [user, password] of [
    [runtimeUser, runtimePassword],
    [relayUser, relayPassword],
    [migratorUser, migratorPassword],
  ]) {
    await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY ?`, [password]);
  }
  await admin.query(
    `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, CREATE ROUTINE, ALTER ROUTINE ON ${identifier(database)}.* TO '${migratorUser}'@'%'`,
  );
  await migrationSource.initialize();
  await runAuditMigrations(migrationSource);
  const table = (name: string) => `${identifier(database)}.${identifier(name)}`;
  await admin.query(`CREATE TABLE ${table('synthetic_business')} (id VARCHAR(128) PRIMARY KEY)`);
  await admin.query(`CREATE TABLE ${table('synthetic_history')} (id VARCHAR(128) PRIMARY KEY)`);
  await admin.query(`GRANT INSERT ON ${table('synthetic_business')} TO '${runtimeUser}'@'%'`);
  await admin.query(`GRANT INSERT ON ${table('synthetic_history')} TO '${runtimeUser}'@'%'`);
  await admin.query(
    `GRANT EXECUTE ON PROCEDURE ${identifier(database)}.\`opslog_append_local_audit_and_delivery\` TO '${runtimeUser}'@'%'`,
  );
  await admin.query(`GRANT SELECT ON ${table(AUDIT_TABLES.projection)} TO '${runtimeUser}'@'%'`);
  await admin.query(`GRANT SELECT ON ${table(AUDIT_TABLES.local)} TO '${relayUser}'@'%'`);
  await admin.query(`GRANT SELECT ON ${table(AUDIT_TABLES.delivery)} TO '${relayUser}'@'%'`);
  await admin.query(
    `GRANT SELECT, INSERT ON ${table(AUDIT_TABLES.registry)} TO '${relayUser}'@'%'`,
  );
  await admin.query(`GRANT INSERT ON ${table(AUDIT_TABLES.projection)} TO '${relayUser}'@'%'`);
  await admin.query(`GRANT UPDATE ON ${table(AUDIT_TABLES.delivery)} TO '${relayUser}'@'%'`);
  await admin.changeUser({ database });

  return {
    tenantId,
    database,
    runtimeUser,
    relayUser,
    migratorUser,
    runtimePassword,
    relayPassword,
    migratorPassword,
    admin,
    migrationSource,
    runtimeSources,
    relaySources,
    config,
    async openRuntime() {
      const source = createAuditRuntimeDataSource({
        ...config,
        username: runtimeUser,
        password: runtimePassword,
      });
      await source.initialize();
      runtimeSources.push(source);
      return source;
    },
    async openRelay() {
      const source = createAuditRelayDataSource({
        ...config,
        username: relayUser,
        password: relayPassword,
      });
      await source.initialize();
      relaySources.push(source);
      return source;
    },
    async close() {
      await Promise.allSettled([
        ...runtimeSources.map((source) => source.destroy()),
        ...relaySources.map((source) => source.destroy()),
        migrationSource.destroy(),
      ]);
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
      for (const user of [runtimeUser, relayUser, migratorUser])
        await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await admin.end();
    },
  };
}

const event = (tenantId: string, eventId: string, occurredAt = '2026-10-07T10:00:00.000Z') => ({
  eventId,
  tenantId,
  action: 'vehicle.created',
  entityType: 'vehicle',
  entityId: 'opaque-vehicle-1',
  occurredAt,
  actor: { id: 'system', kind: 'system' as const },
  correlationId: 'corr-synthetic',
  data: { attempts: 1 },
});

const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' } as const;

describe.skipIf(!adminUrl)('tenant-local audit persistence against MySQL 8', () => {
  let a: TenantDb;
  let b: TenantDb;
  let runtimeA: DataSource;
  let runtimeB: DataSource;
  let relayA: DataSource;
  let relayB: DataSource;
  let store: MySqlAuditStore;
  let apiStore: MySqlAuditApiStore;
  let relay: MySqlAuditRelay;

  beforeAll(async () => {
    a = await createTenantDb('a');
    b = await createTenantDb('b');
    runtimeA = await a.openRuntime();
    runtimeB = await b.openRuntime();
    relayA = await a.openRelay();
    relayB = await b.openRelay();
    const auditRuntime = createMySqlAuditRuntime({
      listTenantIds: () => [a.tenantId, b.tenantId],
      resolveRuntime: (tenantId) => (tenantId === a.tenantId ? runtimeA : runtimeB),
      resolveRelay: (tenantId) => (tenantId === a.tenantId ? relayA : relayB),
      resolveReader: (tenantId) => (tenantId === a.tenantId ? runtimeA : runtimeB),
    });
    apiStore = auditRuntime.audit;
    store = new MySqlAuditStore(
      (tenantId) => (tenantId === a.tenantId ? relayA : relayB),
      (tenantId) => (tenantId === a.tenantId ? runtimeA : runtimeB),
    );
    relay = auditRuntime.auditRelay;
  });

  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  });

  it('rolls back business, history stand-in, immutable local audit, and initial delivery together', async () => {
    const rejected = runtimeA.transaction('READ COMMITTED', async (manager) => {
      await manager.query('INSERT INTO synthetic_business (id) VALUES (?)', ['rollback-item']);
      await manager.query('INSERT INTO synthetic_history (id) VALUES (?)', ['rollback-history']);
      await appendLocalAuditAndDelivery(manager, event(a.tenantId, 'rollback-event'));
      throw new Error('synthetic rollback');
    });
    await expect(rejected).rejects.toThrow('synthetic rollback');
    const [business] = await a.admin.query('SELECT id FROM synthetic_business');
    const [history] = await a.admin.query('SELECT id FROM synthetic_history');
    expect(business).toEqual([]);
    expect(history).toEqual([]);
    const [local] = await a.admin.query(`SELECT event_id FROM ${identifier(AUDIT_TABLES.local)}`);
    const [delivery] = await a.admin.query(
      `SELECT event_id FROM ${identifier(AUDIT_TABLES.delivery)}`,
    );
    expect(local).toEqual([]);
    expect(delivery).toEqual([]);
  });

  it('commits local audit/outbox atomically and preserves the local row after relay and restart', async () => {
    const item = event(a.tenantId, 'durable-event');
    await runtimeA.transaction('READ COMMITTED', async (manager) => {
      await manager.query('INSERT INTO synthetic_business (id) VALUES (?)', ['durable-item']);
      await manager.query('INSERT INTO synthetic_history (id) VALUES (?)', ['durable-history']);
      await appendLocalAuditAndDelivery(manager, item);
    });
    expect(await listPendingAuditEventIds(relayA, a.tenantId)).toEqual([item.eventId]);
    expect(await relayPendingAuditEvent(relayA, a.tenantId, item.eventId)).toBe(true);
    const [localBefore] = await a.admin.query(
      `SELECT * FROM ${identifier(AUDIT_TABLES.local)} WHERE tenant_id = ?`,
      [a.tenantId],
    );
    const [delivery] = await a.admin.query(
      `SELECT status FROM ${identifier(AUDIT_TABLES.delivery)} WHERE tenant_id = ?`,
      [a.tenantId],
    );
    const [projection] = await a.admin.query(
      `SELECT event_id FROM ${identifier(AUDIT_TABLES.projection)} WHERE tenant_id = ?`,
      [a.tenantId],
    );
    expect((localBefore as { event_id: string }[])[0]?.event_id).toBe(item.eventId);
    expect(delivery).toEqual([{ status: 'delivered' }]);
    expect(projection).toEqual([{ event_id: item.eventId }]);
    expect(await relayPendingAuditEvent(relayA, a.tenantId, item.eventId)).toBe(false);
    expect(await listPendingAuditEventIds(relayA, a.tenantId)).toEqual([]);
    expect(await store.list(a.tenantId, range)).toHaveLength(1);
    const restarted = await a.openRuntime();
    expect(
      await new MySqlAuditStore(
        (id) => (id === a.tenantId ? restarted : runtimeB),
        (id) => (id === a.tenantId ? restarted : runtimeB),
      ).list(a.tenantId, range),
    ).toHaveLength(1);
  });

  it('API AuditStore append queues locally and the concrete worker relay publishes the tenant view', async () => {
    const item = event(a.tenantId, 'api-audit-event');
    await apiStore.append(item);
    await Promise.all([apiStore.append(item), apiStore.append(item)]);
    await expect(apiStore.append({ ...item, action: 'vehicle.deleted' })).rejects.toMatchObject({
      code: 'AUDIT_EVENT_CONFLICT',
    });
    expect(await listPendingAuditEventIds(relayA, a.tenantId)).toEqual([item.eventId]);
    expect((await store.list(a.tenantId, range)).some((row) => row.eventId === item.eventId)).toBe(
      false,
    );
    expect(await relay.runBatch(10)).toBe(1);
    expect(
      (await store.list(a.tenantId, range)).filter((row) => row.eventId === item.eventId),
    ).toMatchObject([{ eventId: item.eventId, tenantId: a.tenantId }]);
  });

  it('retries after projection commit before delivery acknowledgement without duplicating the projection', async () => {
    const item = event(a.tenantId, 'crash-window-event');
    await runtimeA.transaction('READ COMMITTED', (manager) =>
      appendLocalAuditAndDelivery(manager, item),
    );
    await relayA.transaction('READ COMMITTED', (manager) => appendAuditProjection(manager, item));
    expect(await relayPendingAuditEvent(relayA, a.tenantId, item.eventId)).toBe(true);
    const [rows] = await a.admin.query(
      `SELECT event_id FROM ${identifier(AUDIT_TABLES.projection)} WHERE event_id = ?`,
      [item.eventId],
    );
    expect(rows).toEqual([{ event_id: item.eventId }]);
  });

  it('keeps delivery pending after a relay write failure and succeeds on retry', async () => {
    const item = event(a.tenantId, 'relay-retry-event');
    await runtimeA.transaction('READ COMMITTED', (manager) =>
      appendLocalAuditAndDelivery(manager, item),
    );
    await a.admin.query(
      `REVOKE INSERT ON ${identifier(AUDIT_TABLES.registry)} FROM '${a.relayUser}'@'%'`,
    );
    await expect(relayPendingAuditEvent(relayA, a.tenantId, item.eventId)).rejects.toBeDefined();
    expect(await listPendingAuditEventIds(relayA, a.tenantId)).toContain(item.eventId);
    await a.admin.query(
      `GRANT SELECT, INSERT ON ${identifier(AUDIT_TABLES.registry)} TO '${a.relayUser}'@'%'`,
    );
    expect(await relayPendingAuditEvent(relayA, a.tenantId, item.eventId)).toBe(true);
    expect(await listPendingAuditEventIds(relayA, a.tenantId)).not.toContain(item.eventId);
  });

  it('deduplicates concurrent projection retries and rejects changed immutable content', async () => {
    const item = event(a.tenantId, 'race-event');
    await Promise.all([store.append(item), store.append(item)]);
    expect(await listPendingAuditEventIds(relayA, a.tenantId)).not.toContain(item.eventId);
    await expect(store.append({ ...item, action: 'vehicle.deleted' })).rejects.toMatchObject({
      code: 'AUDIT_EVENT_CONFLICT',
    });
    const [rows] = await a.admin.query(
      `SELECT event_id FROM ${identifier(AUDIT_TABLES.projection)} WHERE event_id = ?`,
      [item.eventId],
    );
    expect(rows).toEqual([{ event_id: item.eventId }]);
  });

  it('keeps event-id uniqueness global when a retry changes the target date partition', async () => {
    const original = event(a.tenantId, 'cross-partition-event');
    await store.append(original);
    await expect(
      store.append({ ...original, occurredAt: '2036-06-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'AUDIT_EVENT_CONFLICT' });
    const [registry] = await a.admin.query(
      `SELECT event_id FROM ${identifier(AUDIT_TABLES.registry)} WHERE tenant_id = ? AND event_id = ?`,
      [a.tenantId, original.eventId],
    );
    const [projection] = await a.admin.query(
      `SELECT event_id FROM ${identifier(AUDIT_TABLES.projection)} WHERE tenant_id = ? AND event_id = ?`,
      [a.tenantId, original.eventId],
    );
    expect(registry).toEqual([{ event_id: original.eventId }]);
    expect(projection).toEqual([{ event_id: original.eventId }]);
  });

  it('isolates repeated event ids across tenant databases and rejects A credentials on B', async () => {
    const eventA = event(a.tenantId, 'same-id');
    const eventB = event(b.tenantId, 'same-id');
    await Promise.all([store.append(eventA), store.append(eventB)]);
    expect((await store.list(a.tenantId, range)).map((row) => row.tenantId)).toContain(a.tenantId);
    expect((await store.list(b.tenantId, range)).map((row) => row.tenantId)).toContain(b.tenantId);
    const wrongTenant = createAuditRuntimeDataSource({
      ...b.config,
      username: a.runtimeUser,
      password: a.runtimePassword,
    });
    await expect(wrongTenant.initialize()).rejects.toBeDefined();
    await wrongTenant.destroy().catch(() => undefined);
  });

  it('enforces role grants and rolls back when runtime cannot insert initial delivery state', async () => {
    await expect(
      runtimeA.query(
        `INSERT INTO ${identifier(AUDIT_TABLES.local)} (tenant_id, event_id) VALUES (?, ?)`,
        [a.tenantId, 'forbidden-direct-insert'],
      ),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(
        `INSERT INTO ${identifier(AUDIT_TABLES.delivery)} (tenant_id, event_id) VALUES (?, ?)`,
        [a.tenantId, 'forbidden-direct-delivery'],
      ),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(`SELECT event_id FROM ${identifier(AUDIT_TABLES.local)}`),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(`SELECT event_id FROM ${identifier(AUDIT_TABLES.delivery)}`),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(`UPDATE ${identifier(AUDIT_TABLES.local)} SET action = 'bad'`),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(`DELETE FROM ${identifier(AUDIT_TABLES.local)}`),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(`UPDATE ${identifier(AUDIT_TABLES.delivery)} SET status = 'delivered'`),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(
        `INSERT INTO ${identifier(AUDIT_TABLES.projection)} (tenant_id,event_id,action,entity_type,entity_id,occurred_at,actor_id,actor_kind,correlation_id,data,content_hash) VALUES ('x','x','x','x','x',NOW(),'system','system','x',JSON_OBJECT(),'${'0'.repeat(64)}')`,
      ),
    ).rejects.toBeDefined();
    await expect(
      runtimeA.query(`ALTER TABLE ${identifier(AUDIT_TABLES.local)} ADD COLUMN forbidden INT`),
    ).rejects.toBeDefined();
    await expect(
      relayA.query(
        `INSERT INTO ${identifier(AUDIT_TABLES.delivery)} (tenant_id,event_id,status,created_at) VALUES ('x','x','pending',NOW())`,
      ),
    ).rejects.toBeDefined();
    await expect(
      relayA.query(`UPDATE ${identifier(AUDIT_TABLES.local)} SET action = 'bad'`),
    ).rejects.toBeDefined();
    await expect(
      relayA.query(`UPDATE ${identifier(AUDIT_TABLES.registry)} SET content_hash = REPEAT('0',64)`),
    ).rejects.toBeDefined();
    await a.admin.query(
      `REVOKE EXECUTE ON PROCEDURE ${identifier(a.database)}.\`opslog_append_local_audit_and_delivery\` FROM '${a.runtimeUser}'@'%'`,
    );
    const failed = runtimeA.transaction('READ COMMITTED', async (manager) => {
      await manager.query('INSERT INTO synthetic_business (id) VALUES (?)', ['grant-rollback']);
      await manager.query('INSERT INTO synthetic_history (id) VALUES (?)', [
        'grant-rollback-history',
      ]);
      await appendLocalAuditAndDelivery(manager, event(a.tenantId, 'grant-rollback-event'));
    });
    await expect(failed).rejects.toBeDefined();
    await a.admin.query(
      `GRANT EXECUTE ON PROCEDURE ${identifier(a.database)}.\`opslog_append_local_audit_and_delivery\` TO '${a.runtimeUser}'@'%'`,
    );
    const [business] = await a.admin.query('SELECT id FROM synthetic_business WHERE id = ?', [
      'grant-rollback',
    ]);
    const [history] = await a.admin.query('SELECT id FROM synthetic_history WHERE id = ?', [
      'grant-rollback-history',
    ]);
    const [local] = await a.admin.query(
      `SELECT event_id FROM ${identifier(AUDIT_TABLES.local)} WHERE event_id = ?`,
      ['grant-rollback-event'],
    );
    expect(business).toEqual([]);
    expect(history).toEqual([]);
    expect(local).toEqual([]);
  });

  it('creates annual partitions on rollover and prunes date-bounded reads', async () => {
    const runner = a.migrationSource.createQueryRunner();
    await runner.connect();
    try {
      await ensureAuditYearPartition(runner, 2036);
    } finally {
      await runner.release();
    }
    const item = event(a.tenantId, 'rollover-event', '2036-06-01T00:00:00.000Z');
    await store.append(item);
    await relay.runBatch(10);
    const [plan] = await a.admin.query(
      `EXPLAIN SELECT event_id FROM ${identifier(AUDIT_TABLES.projection)} WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?`,
      [a.tenantId, '2036-01-01 00:00:00', '2037-01-01 00:00:00'],
    );
    expect((plan as { partitions?: string }[])[0]?.partitions).toContain('p2036');
    expect(
      await store.list(a.tenantId, {
        from: '2036-01-01T00:00:00.000Z',
        to: '2037-01-01T00:00:00.000Z',
      }),
    ).toHaveLength(1);
  });
});
