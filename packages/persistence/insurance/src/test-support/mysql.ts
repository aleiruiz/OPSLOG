import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
  createInsuranceDataSource,
  createInsuranceMigrationDataSource,
  runInsuranceMigrations,
} from '../data-source.js';
import { POLICY_TABLES } from '../entities.js';

/**
 * Real MySQL for the insurance tests (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL). Locally the
 * suites are skipped when the variable is unset; in CI (`CI` set by the runner) a missing variable
 * is a hard failure so they can never be skipped silently there. Only synthetic data; the database
 * and the runtime account are created per run and dropped afterwards.
 */
export const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrl && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; MySQL integration must not be skipped',
  );

export function loopbackAdminConfig(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
    throw new Error('synthetic MySQL admin URL must use a loopback host');
  return {
    host,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username) || 'root',
    password: decodeURIComponent(url.password),
  };
}

export const identifier = (value: string): string => {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('test generated an invalid identifier');
  return `\`${value}\``;
};

export interface InsuranceDatabase {
  readonly databaseName: string;
  readonly runtimeUser: string;
  /** Admin connection already switched to the synthetic database. */
  readonly admin: mysql.Connection;
  readonly adminConfig: ReturnType<typeof loopbackAdminConfig>;
  /** A new pooled runtime DataSource (initialized); stands in for one API process. */
  openRuntime(connectionLimit?: number): Promise<DataSource>;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Creates the database, the least-privilege runtime account and applies the migrations as the schema owner. */
export async function startInsuranceDatabase(tag: string): Promise<InsuranceDatabase> {
  const suffix = `${Date.now()}_${process.pid}`;
  const databaseName = `opslog_doc_${tag}_${suffix}`;
  const runtimeUser = `opslog_insurance_${createHash('sha256')
    .update(suffix + tag)
    .digest('hex')
    .slice(0, 14)}`;
  const runtimePassword = randomBytes(24).toString('base64url');
  const adminConfig = loopbackAdminConfig(adminUrl as string);
  const admin = await mysql.createConnection({ ...adminConfig, database: 'mysql' });
  const sources: DataSource[] = [];
  await admin.query(`CREATE DATABASE ${identifier(databaseName)} CHARACTER SET utf8mb4`);
  await admin.query(`CREATE USER '${runtimeUser}'@'%' IDENTIFIED BY ?`, [runtimePassword]);
  const migrations = createInsuranceMigrationDataSource({
    host: adminConfig.host,
    port: adminConfig.port,
    database: databaseName,
    username: adminConfig.user,
    password: adminConfig.password,
  });
  await migrations.initialize();
  try {
    await runInsuranceMigrations(migrations);
    if (await migrations.showMigrations()) throw new Error('migrations were not applied');
    // Down and up again: the migration is reversible.
    await migrations.undoLastMigration({ transaction: 'all' });
    await runInsuranceMigrations(migrations);
  } finally {
    await migrations.destroy();
  }
  // Least privilege per table (granted once the tables exist): policies are read, inserted and
  // updated but never deleted (BR-009 soft delete); revisions are append-only (read and insert).
  const table = (name: string) => `${identifier(databaseName)}.${identifier(name)}`;
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE ON ${table(POLICY_TABLES.policies)} TO '${runtimeUser}'@'%'`,
  );
  await admin.query(
    `GRANT SELECT, INSERT ON ${table(POLICY_TABLES.revisions)} TO '${runtimeUser}'@'%'`,
  );
  await admin.changeUser({ database: databaseName });
  return {
    databaseName,
    runtimeUser,
    admin,
    adminConfig,
    async openRuntime(connectionLimit = 8) {
      const source = createInsuranceDataSource({
        host: adminConfig.host,
        port: adminConfig.port,
        database: databaseName,
        username: runtimeUser,
        password: runtimePassword,
        connectionLimit,
      });
      await source.initialize();
      sources.push(source);
      return source;
    },
    async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const [result] = await admin.query(sql, params);
      return result as T[];
    },
    async close() {
      await Promise.allSettled(sources.map((source) => source.destroy()));
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)}`);
      await admin.query(`DROP USER IF EXISTS '${runtimeUser}'@'%'`);
      await admin.end();
    },
  };
}
