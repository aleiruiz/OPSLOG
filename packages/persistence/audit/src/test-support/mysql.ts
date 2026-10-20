import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { AUDIT_TABLES } from '../entities.js';
import {
  createAuditMigrationDataSource,
  createAuditRelayDataSource,
  createAuditRuntimeDataSource,
  runAuditMigrations,
} from '../data-source.js';

/**
 * A synthetic tenant database with the three audit accounts (runtime, relay, migrator) and the same grants
 * as production provisioning. CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL; locally the suites skip when
 * the variable is unset, and in CI a missing variable is a hard failure.
 */
export const auditAdminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!auditAdminUrl && process.env.CI)
  throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; audit MySQL tests cannot skip');

const identifier = (value: string) => {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('invalid synthetic identifier');
  return `\`${value}\``;
};

export interface AuditDatabase {
  readonly database: string;
  /** Admin connection already switched to the synthetic database (test fixtures only). */
  readonly admin: mysql.Connection;
  openRuntime(): Promise<DataSource>;
  openRelay(): Promise<DataSource>;
  close(): Promise<void>;
}

export async function startAuditDatabase(tag: string): Promise<AuditDatabase> {
  const url = new URL(auditAdminUrl as string);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'mysql:' ||
    (!['localhost', '127.0.0.1', '::1'].includes(host) &&
      process.env.OPSLOG_TEST_MYSQL_ALLOW_REMOTE !== '1')
  )
    throw new Error('synthetic MySQL admin URL must use a loopback host');
  const port = Number(url.port || 3306);
  const suffix = createHash('sha256')
    .update(`${tag}:${Date.now()}:${randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 20);
  const accountSuffix = suffix.slice(0, 7);
  const database = `opslog_t_${suffix}`;
  const accounts = {
    runtime: [`opslog_audit_runtime_${accountSuffix}`, randomBytes(24).toString('base64url')],
    relay: [`opslog_audit_relay_${accountSuffix}`, randomBytes(24).toString('base64url')],
    migrator: [`opslog_audit_migrator_${accountSuffix}`, randomBytes(24).toString('base64url')],
  } as const;
  const admin = await mysql.createConnection({
    host,
    port,
    user: decodeURIComponent(url.username) || 'root',
    password: decodeURIComponent(url.password),
    database: 'mysql',
  });
  const base = { host, port, database };
  const sources: DataSource[] = [];
  await admin.query(`CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4`);
  for (const [user, password] of Object.values(accounts))
    await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY ?`, [password]);
  const [migrator, migratorPassword] = accounts.migrator;
  await admin.query(
    `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, CREATE ROUTINE, ALTER ROUTINE ON ${identifier(database)}.* TO '${migrator}'@'%'`,
  );
  const migrations = createAuditMigrationDataSource({
    ...base,
    username: migrator,
    password: migratorPassword,
  });
  await migrations.initialize();
  try {
    await runAuditMigrations(migrations);
  } finally {
    await migrations.destroy();
  }
  const table = (name: string) => `${identifier(database)}.${identifier(name)}`;
  const [runtime] = accounts.runtime;
  const [relay] = accounts.relay;
  const grants = [
    `GRANT EXECUTE ON PROCEDURE ${identifier(database)}.\`opslog_append_local_audit_and_delivery\` TO '${runtime}'@'%'`,
    `GRANT EXECUTE ON PROCEDURE ${identifier(database)}.\`opslog_enqueue_tenant_outbox\` TO '${runtime}'@'%'`,
    `GRANT SELECT ON ${table(AUDIT_TABLES.projection)} TO '${runtime}'@'%'`,
    `GRANT SELECT ON ${table(AUDIT_TABLES.outbox)} TO '${runtime}'@'%'`,
    `GRANT SELECT ON ${table(AUDIT_TABLES.local)} TO '${relay}'@'%'`,
    `GRANT SELECT ON ${table(AUDIT_TABLES.delivery)} TO '${relay}'@'%'`,
    `GRANT SELECT, INSERT ON ${table(AUDIT_TABLES.registry)} TO '${relay}'@'%'`,
    `GRANT INSERT ON ${table(AUDIT_TABLES.projection)} TO '${relay}'@'%'`,
    `GRANT UPDATE ON ${table(AUDIT_TABLES.delivery)} TO '${relay}'@'%'`,
    `GRANT SELECT ON ${table(AUDIT_TABLES.outbox)} TO '${relay}'@'%'`,
    `GRANT UPDATE (status, attempts, available_at, lease_until, fencing, worker_id, last_error, handler_completed) ON ${table(AUDIT_TABLES.outbox)} TO '${relay}'@'%'`,
  ];
  for (const grant of grants) await admin.query(grant);
  await admin.changeUser({ database });
  return {
    database,
    admin,
    async openRuntime() {
      const source = createAuditRuntimeDataSource({
        ...base,
        username: accounts.runtime[0],
        password: accounts.runtime[1],
      });
      await source.initialize();
      sources.push(source);
      return source;
    },
    async openRelay() {
      const source = createAuditRelayDataSource({
        ...base,
        username: accounts.relay[0],
        password: accounts.relay[1],
      });
      await source.initialize();
      sources.push(source);
      return source;
    },
    async close() {
      await Promise.allSettled(sources.map((source) => source.destroy()));
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
      for (const [user] of Object.values(accounts))
        await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await admin.end();
    },
  };
}
