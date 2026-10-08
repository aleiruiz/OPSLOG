import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { AREA_TABLES } from '../../../packages/persistence/areas/src/index.js';
import { VEHICLE_TABLES } from '../../../packages/persistence/vehicles/src/index.js';
import { EMPLOYEE_TABLES } from '../../../packages/persistence/employees/src/index.js';
import { DOCUMENT_TABLES } from '../../../packages/persistence/documents/src/index.js';
import { POLICY_TABLES } from '../../../packages/persistence/insurance/src/index.js';
import { ASSIGNMENT_TABLES } from '../../../packages/persistence/assignments/src/index.js';
import { SETTINGS_TABLES } from '../../../packages/persistence/settings/src/index.js';
import { IMPORT_TABLES } from '../../../packages/persistence/imports/src/index.js';
import {
  createFleetMigrationModules,
  openFleetRuntimeStores,
  runFleetAuditMigrations,
  runFleetMigrations,
  type FleetMigrationCredentials,
  type FleetRuntimeCredentials,
  type FleetRuntimeStores,
} from '../../../apps/api/composition/src/index.js';

export const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrl && process.env.CI)
  throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; fleet integration must not skip');

const identifier = (value: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('unsafe synthetic MySQL identifier');
  return `\`${value}\``;
};

function adminConfig(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
    throw new Error('fleet integration requires a loopback-only synthetic MySQL URL');
  return {
    host,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username) || 'root',
    password: decodeURIComponent(url.password),
  };
}

type Grant = { readonly table: string; readonly privileges: readonly string[] };
const grants = {
  areas: [
    { table: AREA_TABLES.areas, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: AREA_TABLES.responsibles, privileges: ['SELECT', 'INSERT', 'DELETE'] },
    { table: AREA_TABLES.history, privileges: ['SELECT', 'INSERT'] },
    { table: AREA_TABLES.locks, privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  ],
  vehicles: [
    { table: VEHICLE_TABLES.vehicles, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: VEHICLE_TABLES.statusHistory, privileges: ['SELECT', 'INSERT'] },
  ],
  employees: [
    { table: EMPLOYEE_TABLES.employees, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: EMPLOYEE_TABLES.history, privileges: ['SELECT', 'INSERT'] },
  ],
  documents: [
    { table: DOCUMENT_TABLES.documents, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: DOCUMENT_TABLES.revisions, privileges: ['SELECT', 'INSERT'] },
  ],
  insurance: [
    { table: POLICY_TABLES.policies, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: POLICY_TABLES.revisions, privileges: ['SELECT', 'INSERT'] },
  ],
  assignments: [
    { table: ASSIGNMENT_TABLES.assignments, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: ASSIGNMENT_TABLES.events, privileges: ['SELECT', 'INSERT'] },
  ],
  settings: [{ table: SETTINGS_TABLES.settings, privileges: ['SELECT', 'INSERT', 'UPDATE'] }],
  imports: [
    { table: IMPORT_TABLES.jobs, privileges: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: IMPORT_TABLES.rows, privileges: ['SELECT', 'INSERT'] },
    { table: IMPORT_TABLES.events, privileges: ['SELECT', 'INSERT'] },
  ],
} satisfies Record<string, readonly Grant[]>;

type Module = keyof typeof grants;
type Accounts = FleetRuntimeCredentials['accounts'];
const modules: readonly Module[] = [
  'areas',
  'vehicles',
  'employees',
  'documents',
  'insurance',
  'assignments',
  'settings',
  'imports',
];

export interface FleetTenantDatabase {
  readonly databaseName: string;
  readonly host: string;
  readonly port: number;
  readonly appliedMigrations: readonly string[];
  readonly runtime: FleetRuntimeStores;
  readonly accounts: Accounts;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface FleetDatabase extends FleetTenantDatabase {
  /** Each side is a physically separate database and runtime composition. */
  readonly tenantA: FleetTenantDatabase;
  readonly tenantB: FleetTenantDatabase;
  rowsB<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function startTenantDatabase(label: string): Promise<FleetTenantDatabase> {
  if (!adminUrl) throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is not configured');
  const admin = adminConfig(adminUrl);
  const suffix = randomBytes(6).toString('hex');
  const databaseName = `opslog_t_${suffix}`;
  const auditSuffix = randomBytes(5).toString('hex').slice(0, 9);
  const runtime = Object.fromEntries(
    modules.map((name) => [
      name,
      {
        username: `opslog_${name}_${suffix}`,
        password: randomBytes(24).toString('base64url'),
      },
    ]),
  ) as Omit<Accounts, 'auditRuntime' | 'auditRelay'>;
  const auditRuntime = {
    username: `opslog_audit_runtime_${auditSuffix}`,
    password: randomBytes(24).toString('base64url'),
  };
  const auditRelay = {
    username: `opslog_audit_relay_${auditSuffix}`,
    password: randomBytes(24).toString('base64url'),
  };
  const auditMigrator = {
    username: `opslog_audit_migrator_${auditSuffix}`,
    password: randomBytes(24).toString('base64url'),
  };
  const accounts = { ...runtime, auditRuntime, auditRelay } as Accounts;
  const users: string[] = [];
  const connection = await mysql.createConnection({ ...admin, database: 'mysql' });
  let stores: FleetRuntimeStores | undefined;
  let databaseCreated = false;
  try {
    await connection.query(`CREATE DATABASE ${identifier(databaseName)} CHARACTER SET utf8mb4`);
    databaseCreated = true;
    const migrationCredentials: FleetMigrationCredentials = {
      host: admin.host,
      port: admin.port,
      database: databaseName,
      username: admin.user,
      password: admin.password,
      auditMigrator,
    };
    const appliedMigrations = await runFleetMigrations(migrationCredentials);
    const idempotentMigrations = await runFleetMigrations(migrationCredentials);
    if (idempotentMigrations.join(',') !== appliedMigrations.join(','))
      throw new Error(`fleet migration registry changed during idempotent rerun: ${label}`);
    const migrationModules = createFleetMigrationModules(migrationCredentials);
    for (const module of [...migrationModules].reverse()) {
      await module.source.initialize();
      try {
        await module.source.undoLastMigration({ transaction: 'all' });
        if (!(await module.source.showMigrations()))
          throw new Error(`fleet migration did not revert: ${module.name}`);
        await module.run();
        if (await module.source.showMigrations())
          throw new Error(`fleet migration did not reapply: ${module.name}`);
      } finally {
        await module.source.destroy();
      }
    }
    await connection.query(`CREATE USER '${auditMigrator.username}'@'%' IDENTIFIED BY ?`, [
      auditMigrator.password,
    ]);
    users.push(auditMigrator.username);
    await connection.query(
      `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, CREATE ROUTINE, ALTER ROUTINE ON ${identifier(databaseName)}.* TO '${auditMigrator.username}'@'%'`,
    );
    await runFleetAuditMigrations(migrationCredentials);
    await runFleetAuditMigrations(migrationCredentials);
    for (const name of modules) {
      const account = runtime[name];
      await connection.query(`CREATE USER '${account.username}'@'%' IDENTIFIED BY ?`, [
        account.password,
      ]);
      users.push(account.username);
      for (const grant of grants[name]) {
        const table = `${identifier(databaseName)}.${identifier(grant.table)}`;
        await connection.query(
          `GRANT ${grant.privileges.join(', ')} ON ${table} TO '${account.username}'@'%'`,
        );
      }
      await connection.query(
        `GRANT EXECUTE ON PROCEDURE ${identifier(databaseName)}.\`opslog_append_local_audit_and_delivery\` TO '${account.username}'@'%'`,
      );
    }

    for (const account of [auditRuntime, auditRelay]) {
      await connection.query(`CREATE USER '${account.username}'@'%' IDENTIFIED BY ?`, [
        account.password,
      ]);
      users.push(account.username);
    }
    const table = (name: string) => `${identifier(databaseName)}.${identifier(name)}`;
    await connection.query(
      `GRANT EXECUTE ON PROCEDURE ${identifier(databaseName)}.\`opslog_append_local_audit_and_delivery\` TO '${auditRuntime.username}'@'%'`,
    );
    await connection.query(
      `GRANT SELECT ON ${table(AUDIT_TABLES.projection)} TO '${auditRuntime.username}'@'%'`,
    );
    await connection.query(
      `GRANT SELECT ON ${table(AUDIT_TABLES.local)} TO '${auditRelay.username}'@'%'`,
    );
    await connection.query(
      `GRANT SELECT ON ${table(AUDIT_TABLES.delivery)} TO '${auditRelay.username}'@'%'`,
    );
    await connection.query(
      `GRANT SELECT, INSERT ON ${table(AUDIT_TABLES.registry)} TO '${auditRelay.username}'@'%'`,
    );
    await connection.query(
      `GRANT INSERT ON ${table(AUDIT_TABLES.projection)} TO '${auditRelay.username}'@'%'`,
    );
    await connection.query(
      `GRANT UPDATE ON ${table(AUDIT_TABLES.delivery)} TO '${auditRelay.username}'@'%'`,
    );

    stores = await openFleetRuntimeStores({
      host: admin.host,
      port: admin.port,
      database: databaseName,
      accounts,
    });
    await connection.changeUser({ database: databaseName });
    return {
      databaseName,
      host: admin.host,
      port: admin.port,
      appliedMigrations: [...appliedMigrations, 'audit:2026100700010'],
      runtime: stores,
      accounts,
      async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        const [result] = await connection.query(sql, params);
        return result as T[];
      },
      async close() {
        try {
          await stores?.close();
          await connection.changeUser({ database: 'mysql' });
          const cleanup = await Promise.allSettled([
            connection.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)}`),
            ...users.map((user) => connection.query(`DROP USER IF EXISTS '${user}'@'%'`)),
          ]);
          const failures = cleanup.filter((result) => result.status === 'rejected');
          if (failures.length > 0) throw new AggregateError(failures, 'fleet MySQL cleanup failed');
        } finally {
          await connection.end();
        }
      },
    };
  } catch (error) {
    try {
      await stores?.close();
      await connection.changeUser({ database: 'mysql' });
      const cleanup = await Promise.allSettled([
        ...(databaseCreated
          ? [connection.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)}`)]
          : []),
        ...users.map((user) => connection.query(`DROP USER IF EXISTS '${user}'@'%'`)),
      ]);
      const failures = cleanup.filter((result) => result.status === 'rejected');
      if (failures.length > 0)
        throw new AggregateError(failures, 'fleet MySQL setup cleanup failed');
    } finally {
      await connection.end();
    }
    throw error;
  }
}

export async function startFleetDatabase(): Promise<FleetDatabase> {
  const tenantA = await startTenantDatabase('a');
  try {
    const tenantB = await startTenantDatabase('b');
    return {
      ...tenantA,
      tenantA,
      tenantB,
      rowsB: tenantB.rows,
      async close() {
        const results = await Promise.allSettled([tenantA.close(), tenantB.close()]);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) throw new AggregateError(failures, 'fleet tenants cleanup failed');
      },
    };
  } catch (error) {
    await tenantA.close();
    throw error;
  }
}
