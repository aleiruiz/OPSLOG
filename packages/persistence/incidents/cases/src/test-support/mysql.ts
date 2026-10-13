import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
  AUDIT_TABLES,
  createAuditMigrationDataSource,
  runAuditMigrations,
} from '../../../../audit/src/index.js';
import {
  createIncidentDataSource,
  createIncidentMigrationDataSource,
  runIncidentMigrations,
} from '../data-source.js';
import { INCIDENT_TABLES } from '../entities.js';
import { INCIDENT_CHILD_TABLES } from '../../../third-parties/src/index.js';

export const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrl && process.env.CI)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; incident MySQL integration must not be skipped',
  );

function adminConfig(value: string) {
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
const identifier = (name: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid generated identifier');
  return `\`${name}\``;
};

/** Exactly the runtime grants of the incidents account (INC-CASES, "Persistencia"). */
export const INCIDENT_GRANTS: readonly { table: string; privileges: string }[] = [
  { table: INCIDENT_TABLES.incidents, privileges: 'SELECT, INSERT, UPDATE' },
  { table: INCIDENT_TABLES.folios, privileges: 'SELECT, INSERT, UPDATE' },
  { table: INCIDENT_TABLES.transitions, privileges: 'SELECT, INSERT' },
  { table: INCIDENT_TABLES.idempotency, privileges: 'SELECT, INSERT, DELETE' },
  { table: INCIDENT_CHILD_TABLES.thirdParties, privileges: 'SELECT, INSERT, UPDATE' },
  { table: INCIDENT_CHILD_TABLES.evidence, privileges: 'SELECT, INSERT, DELETE' },
  { table: AUDIT_TABLES.outbox, privileges: 'SELECT' },
];

export interface IncidentTestDatabase {
  readonly databaseName: string;
  readonly otherDatabaseName: string;
  readonly runtimeUserA: string;
  openIncidents(database?: 'a' | 'b'): Promise<DataSource>;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  rowsB<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Two disposable tenant-exclusive databases (A and B), each with its own restricted runtime user. */
export interface IncidentDatabaseExtension {
  /** Migrations of a later module of the incidents, run after the cases with the owner account. */
  readonly migrate?: (owner: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
  }) => Promise<void>;
  /** Runtime grants of that module. */
  readonly grants?: readonly { table: string; privileges: string }[];
}

export async function startIncidentDatabase(
  tag: string,
  extension: IncidentDatabaseExtension = {},
): Promise<IncidentTestDatabase> {
  const suffix = `${Date.now()}_${process.pid}_${randomBytes(4).toString('hex')}`;
  const cfg = adminConfig(adminUrl as string);
  const admin = await mysql.createConnection({ ...cfg, database: 'mysql' });
  const sources: DataSource[] = [];
  const owned: { database: string; users: string[] }[] = [];

  async function migrate(source: DataSource, run: (source: DataSource) => Promise<void>) {
    await source.initialize();
    try {
      await run(source);
    } finally {
      await source.destroy();
    }
  }
  async function provision(label: 'a' | 'b') {
    const database = `opslog_t_inc_${tag}_${label}_${suffix}`;
    const digest = createHash('sha256').update(`${suffix}:${label}`).digest('hex').slice(0, 8);
    const runtime = {
      user: `opslog_incidents_${digest}`,
      password: randomBytes(24).toString('base64url'),
    };
    const migrator = {
      user: `opslog_audit_migrator_${digest}`,
      password: randomBytes(24).toString('base64url'),
    };
    owned.push({ database, users: [runtime.user, migrator.user] });
    await admin.query(`CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4`);
    for (const account of [runtime, migrator])
      await admin.query(`CREATE USER '${account.user}'@'%' IDENTIFIED BY ?`, [account.password]);
    await admin.query(
      `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, REFERENCES, CREATE ROUTINE, ALTER ROUTINE ON ${identifier(database)}.* TO '${migrator.user}'@'%'`,
    );
    const endpoint = { host: cfg.host, port: cfg.port, database };
    await migrate(
      createAuditMigrationDataSource({
        ...endpoint,
        username: migrator.user,
        password: migrator.password,
      }),
      runAuditMigrations,
    );
    const owner = { ...endpoint, username: cfg.user, password: cfg.password };
    const migration = createIncidentMigrationDataSource(owner);
    await migration.initialize();
    try {
      const [row] = (await migration.query('SELECT VERSION() AS version')) as { version: string }[];
      if (!/^8\.4\./.test(String(row?.version ?? '')))
        throw new Error(
          `INC-CASES integration requires MySQL 8.4; found ${row?.version ?? 'unknown'}`,
        );
      await runIncidentMigrations(migration);
    } finally {
      await migration.destroy();
    }
    await extension.migrate?.(owner);
    for (const grant of [...INCIDENT_GRANTS, ...(extension.grants ?? [])])
      await admin.query(
        `GRANT ${grant.privileges} ON ${identifier(database)}.${identifier(grant.table)} TO '${runtime.user}'@'%'`,
      );
    for (const routine of [
      'opslog_append_local_audit_and_delivery',
      'opslog_enqueue_tenant_outbox',
    ])
      await admin.query(
        `GRANT EXECUTE ON PROCEDURE ${identifier(database)}.${identifier(routine)} TO '${runtime.user}'@'%'`,
      );
    return { endpoint, runtime };
  }
  const cleanup = async () => {
    await Promise.allSettled(sources.map((source) => source.destroy()));
    await admin.changeUser({ database: 'mysql' });
    for (const item of owned) {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(item.database)}`);
      for (const user of item.users) await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
    }
    await admin.end();
  };
  let a: Awaited<ReturnType<typeof provision>>;
  let b: Awaited<ReturnType<typeof provision>>;
  try {
    a = await provision('a');
    b = await provision('b');
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  const open = async (which: 'a' | 'b') => {
    const target = which === 'a' ? a : b;
    const source = createIncidentDataSource({
      ...target.endpoint,
      username: target.runtime.user,
      password: target.runtime.password,
      connectionLimit: 6,
    });
    await source.initialize();
    sources.push(source);
    return source;
  };
  return {
    databaseName: a.endpoint.database,
    otherDatabaseName: b.endpoint.database,
    runtimeUserA: a.runtime.user,
    openIncidents: (which = 'a') => open(which),
    async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      await admin.changeUser({ database: a.endpoint.database });
      const [result] = await admin.query(sql, params);
      return result as T[];
    },
    async rowsB<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      await admin.changeUser({ database: b.endpoint.database });
      const [result] = await admin.query(sql, params);
      return result as T[];
    },
    close: cleanup,
  };
}
