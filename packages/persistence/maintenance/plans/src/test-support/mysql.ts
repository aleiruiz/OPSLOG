import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
  AUDIT_TABLES,
  createAuditMigrationDataSource,
  runAuditMigrations,
} from '../../../../audit/src/index.js';
import {
  createMaintenanceDataSource,
  createMaintenanceMigrationDataSource,
  runMaintenanceMigrations,
} from '../data-source.js';
import { MAINTENANCE_TABLES } from '../entities.js';

export const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrl && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; maintenance MySQL integration must not be skipped',
  );

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
const identifier = (name: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid generated identifier');
  return `\`${name}\``;
};

export interface MaintenanceTestDatabase {
  readonly databaseName: string;
  readonly tenantDatabaseName: string;
  readonly runtimeUserA: string;
  readonly admin: mysql.Connection;
  openRuntime(database?: 'a' | 'b', connectionLimit?: number): Promise<DataSource>;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Creates two disposable tenant-exclusive MySQL databases with separate restricted runtime users. */
export async function startMaintenanceDatabase(tag: string): Promise<MaintenanceTestDatabase> {
  const suffix = `${Date.now()}_${process.pid}_${randomBytes(4).toString('hex')}`;
  const adminCfg = adminConfig(adminUrl as string);
  const admin = await mysql.createConnection({ ...adminCfg, database: 'mysql' });
  const sources: DataSource[] = [];
  const owned: { database: string; runtimeUser: string; migratorUser: string }[] = [];

  async function provision(label: 'a' | 'b') {
    const database = `opslog_t_mnt_${tag}_${label}_${suffix}`;
    const digest = createHash('sha256').update(`${suffix}:${label}`).digest('hex').slice(0, 8);
    const runtimeUser = `opslog_maintenance_${digest}`;
    const runtimePassword = randomBytes(24).toString('base64url');
    const migratorUser = `opslog_audit_migrator_${digest}`;
    const migratorPassword = randomBytes(24).toString('base64url');
    owned.push({ database, runtimeUser, migratorUser });
    await admin.query(`CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4`);
    await admin.query(`CREATE USER '${runtimeUser}'@'%' IDENTIFIED BY ?`, [runtimePassword]);
    await admin.query(`CREATE USER '${migratorUser}'@'%' IDENTIFIED BY ?`, [migratorPassword]);
    await admin.query(
      `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, REFERENCES, CREATE ROUTINE, ALTER ROUTINE ON ${identifier(database)}.* TO '${migratorUser}'@'%'`,
    );

    const auditMigrator = createAuditMigrationDataSource({
      ...adminCfg,
      database,
      username: migratorUser,
      password: migratorPassword,
    });
    await auditMigrator.initialize();
    try {
      await runAuditMigrations(auditMigrator);
    } finally {
      await auditMigrator.destroy();
    }
    const migrations = createMaintenanceMigrationDataSource({
      ...adminCfg,
      database,
      username: adminCfg.user,
      password: adminCfg.password,
    });
    await migrations.initialize();
    try {
      const versionRows = (await migrations.query('SELECT VERSION() AS version')) as {
        version: string;
      }[];
      const version = String(versionRows[0]?.version ?? '');
      if (!/^8\.4\./.test(version))
        throw new Error(`MNT-PLANS integration requires MySQL 8.4; found ${version || 'unknown'}`);
      await runMaintenanceMigrations(migrations);
      if (await migrations.showMigrations())
        throw new Error('maintenance migration was not applied');
    } finally {
      await migrations.destroy();
    }
    for (const table of Object.values(MAINTENANCE_TABLES))
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON ${identifier(database)}.${identifier(table)} TO '${runtimeUser}'@'%'`,
      );
    await admin.query(
      `GRANT SELECT ON ${identifier(database)}.${identifier(AUDIT_TABLES.outbox)} TO '${runtimeUser}'@'%'`,
    );
    await admin.query(
      `GRANT EXECUTE ON PROCEDURE ${identifier(database)}.\`opslog_append_local_audit_and_delivery\` TO '${runtimeUser}'@'%'`,
    );
    await admin.query(
      `GRANT EXECUTE ON PROCEDURE ${identifier(database)}.\`opslog_enqueue_tenant_outbox\` TO '${runtimeUser}'@'%'`,
    );
    return { database, runtimeUser, runtimePassword };
  }

  let a: Awaited<ReturnType<typeof provision>>;
  let b: Awaited<ReturnType<typeof provision>>;
  try {
    a = await provision('a');
    b = await provision('b');
  } catch (error) {
    await Promise.allSettled([
      (async () => {
        await admin.changeUser({ database: 'mysql' });
        for (const item of owned) {
          await admin.query(`DROP DATABASE IF EXISTS ${identifier(item.database)}`);
          await admin.query(`DROP USER IF EXISTS '${item.runtimeUser}'@'%'`);
          await admin.query(`DROP USER IF EXISTS '${item.migratorUser}'@'%'`);
        }
        await admin.end();
      })(),
    ]);
    throw error;
  }
  await admin.changeUser({ database: a.database });
  return {
    databaseName: a.database,
    tenantDatabaseName: b.database,
    runtimeUserA: a.runtimeUser,
    admin,
    async openRuntime(database = 'a', connectionLimit = 8) {
      const credentials = database === 'a' ? a : b;
      const source = createMaintenanceDataSource({
        ...adminCfg,
        database: credentials.database,
        username: credentials.runtimeUser,
        password: credentials.runtimePassword,
        connectionLimit,
      });
      await source.initialize();
      sources.push(source);
      return source;
    },
    async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      await admin.changeUser({ database: a.database });
      const [result] = await admin.query(sql, params);
      return result as T[];
    },
    async close() {
      await Promise.allSettled(sources.map((source) => source.destroy()));
      await admin.changeUser({ database: 'mysql' });
      for (const item of owned) {
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(item.database)}`);
        await admin.query(`DROP USER IF EXISTS '${item.runtimeUser}'@'%'`);
        await admin.query(`DROP USER IF EXISTS '${item.migratorUser}'@'%'`);
      }
      await admin.end();
    },
  };
}
