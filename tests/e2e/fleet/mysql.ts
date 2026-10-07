import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
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

export interface FleetDatabase {
  readonly databaseName: string;
  readonly host: string;
  readonly port: number;
  readonly appliedMigrations: readonly string[];
  readonly runtime: FleetRuntimeStores;
  readonly accounts: Accounts;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function startFleetDatabase(): Promise<FleetDatabase> {
  if (!adminUrl) throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is not configured');
  const admin = adminConfig(adminUrl);
  const suffix = randomBytes(6).toString('hex');
  const databaseName = `opslog_flt_${suffix}`;
  const runtime = Object.fromEntries(
    modules.map((name) => [
      name,
      {
        username: `opslog_${name}_${suffix}`,
        password: randomBytes(24).toString('base64url'),
      },
    ]),
  ) as Accounts;
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
    };
    const migrationModules = createFleetMigrationModules(migrationCredentials);
    const appliedMigrations = await runFleetMigrations(migrationCredentials);
    const idempotentMigrations = await runFleetMigrations(migrationCredentials);
    if (idempotentMigrations.join(',') !== appliedMigrations.join(','))
      throw new Error('fleet migration registry changed during idempotent rerun');
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
    }
    stores = await openFleetRuntimeStores({
      host: admin.host,
      port: admin.port,
      database: databaseName,
      accounts: runtime,
    });
    await connection.changeUser({ database: databaseName });
    return {
      databaseName,
      host: admin.host,
      port: admin.port,
      appliedMigrations,
      runtime: stores,
      accounts: runtime,
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
