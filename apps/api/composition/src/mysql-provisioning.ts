import { createHmac } from 'node:crypto';
import mysql from 'mysql2/promise';
import { AUDIT_TABLES } from '../../../../packages/persistence/audit/src/index.js';
import {
  CONTROL_PLANE_TABLES,
  IDENTITY_TABLES,
} from '../../../../packages/persistence/identity/src/index.js';
import {
  FILES_MIGRATOR_ACCOUNT,
  FILES_RUNTIME_ACCOUNT,
} from '../../../../packages/persistence/files/src/index.js';
import { MAINTENANCE_RUNTIME_ACCOUNT } from '../../../../packages/persistence/maintenance/plans/src/index.js';
import { INCIDENT_RUNTIME_ACCOUNT } from '../../../../packages/persistence/incidents/cases/src/index.js';
import { SAVED_VIEWS_RUNTIME_ACCOUNT } from '../../../../packages/persistence/saved-views/src/index.js';
import { SEARCH_RUNTIME_ACCOUNT } from '../../../../packages/persistence/search/src/index.js';
import { EXPORT_RUNTIME_ACCOUNT } from '../../../../packages/persistence/exports/src/index.js';
import { NOTIFICATION_RUNTIME_ACCOUNT } from '../../../../packages/persistence/notifications/src/index.js';
import { WEBHOOK_RUNTIME_ACCOUNT } from '../../../../packages/persistence/webhooks/src/index.js';
import { runIdentityControlMigrations } from './control-plane/identity-schema.js';
import {
  runFleetAuditMigrations,
  runFleetMigrations,
  type FleetMigrationCredentials,
  type FleetRuntimeCredentials,
} from './fleet-persistence.js';
import { FLEET_MODULES, FLEET_TABLE_GRANTS } from './mysql-grants.js';

export interface DbAccount {
  readonly username: string;
  readonly password: string;
}

/** Every MySQL account of one deployment: runtime accounts per module, the control plane and the migrators. */
export interface FleetAccountSet {
  readonly runtime: FleetRuntimeCredentials['accounts'];
  /** Identity store and control plane (one pool, one account). */
  readonly identity: DbAccount;
  readonly auditMigrator: DbAccount;
  readonly filesMigrator: DbAccount;
  readonly maintenanceMigrator: DbAccount;
}

/** Account names are interpolated into SQL (they cannot be bound), so they are checked first. */
const SAFE_NAME = /^[A-Za-z0-9_]{1,32}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;
const quoteName = (value: string): string => {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error('unsafe MySQL identifier');
  return `\`${value}\``;
};
const quoteUser = (username: string): string => {
  if (!SAFE_NAME.test(username)) throw new Error('unsafe MySQL account name');
  return `'${username}'@'%'`;
};

/** A stable, per-account password: the same secret always yields the same password for an account. */
export function deriveAccountPassword(secret: string, username: string): string {
  return createHmac('sha256', secret)
    .update(`opslog-mysql-account:${username}`)
    .digest('base64url');
}

/**
 * Names the accounts of one database. `tag` suffixes the runtime and migrator accounts, `auditTag`
 * (at most 10 characters: the audit names are close to MySQL's 32-character limit) the audit ones.
 * Production uses fixed names, so the migrate and API processes agree without sharing state.
 */
export function buildFleetAccounts(
  tag: string,
  auditTag: string,
  passwordFor: (username: string) => string,
): FleetAccountSet {
  const account = (username: string): DbAccount => {
    if (!SAFE_NAME.test(username)) throw new Error('MySQL account name is too long or unsafe');
    return { username, password: passwordFor(username) };
  };
  const runtime = Object.fromEntries(
    FLEET_MODULES.map((name) => [name, account(`opslog_${name}_${tag}`)]),
  ) as Omit<FleetRuntimeCredentials['accounts'], 'auditRuntime' | 'auditRelay'>;
  const set: FleetAccountSet = {
    runtime: {
      ...runtime,
      auditRuntime: account(`opslog_audit_runtime_${auditTag}`),
      auditRelay: account(`opslog_audit_relay_${auditTag}`),
    },
    identity: account(`opslog_identity_${tag}`),
    auditMigrator: account(`opslog_audit_migrator_${auditTag}`),
    filesMigrator: account(`opslog_files_migrator_${auditTag}`),
    maintenanceMigrator: account(`opslog_migrator_${auditTag}`),
  };
  if (!FILES_MIGRATOR_ACCOUNT.test(set.filesMigrator.username))
    throw new Error('files migrator account name is invalid');
  if (!FILES_RUNTIME_ACCOUNT.test(set.runtime.files.username))
    throw new Error('files runtime account name is invalid');
  if (!MAINTENANCE_RUNTIME_ACCOUNT.test(set.runtime.maintenance.username))
    throw new Error('maintenance runtime account name is invalid');
  if (!INCIDENT_RUNTIME_ACCOUNT.test(set.runtime.incidents.username))
    throw new Error('incidents runtime account name is invalid');
  if (!SEARCH_RUNTIME_ACCOUNT.test(set.runtime.search.username))
    throw new Error('search runtime account name is invalid');
  if (!SAVED_VIEWS_RUNTIME_ACCOUNT.test(set.runtime.views.username))
    throw new Error('saved views runtime account name is invalid');
  if (!EXPORT_RUNTIME_ACCOUNT.test(set.runtime.exports.username))
    throw new Error('exports runtime account name is invalid');
  if (!NOTIFICATION_RUNTIME_ACCOUNT.test(set.runtime.notify.username))
    throw new Error('notifications runtime account name is invalid');
  if (!WEBHOOK_RUNTIME_ACCOUNT.test(set.runtime.webhooks.username))
    throw new Error('webhooks runtime account name is invalid');
  return set;
}

/** Anything with `query`: a mysql2 connection or pool opened with schema-owning credentials. */
export interface AdminConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

/** Creates the account if missing and always (re)sets its password, so reruns follow a rotated secret. */
export async function ensureAccount(admin: AdminConnection, account: DbAccount): Promise<void> {
  const user = quoteUser(account.username);
  await admin.query(`CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ?`, [account.password]);
  await admin.query(`ALTER USER ${user} IDENTIFIED BY ?`, [account.password]);
}

export const migratorAccounts = (set: FleetAccountSet): readonly DbAccount[] => [
  set.filesMigrator,
  set.maintenanceMigrator,
  set.auditMigrator,
];

/** Creates the three schema-scoped migrator accounts with the privileges their migrations need. */
export async function provisionMigrators(
  admin: AdminConnection,
  database: string,
  set: FleetAccountSet,
): Promise<void> {
  const db = quoteName(database);
  for (const migrator of migratorAccounts(set)) await ensureAccount(admin, migrator);
  for (const migrator of [set.filesMigrator, set.maintenanceMigrator])
    await admin.query(
      `GRANT CREATE, ALTER, DROP, INDEX, SELECT, INSERT, REFERENCES ON ${db}.* TO ${quoteUser(migrator.username)}`,
    );
  // BackfillOccurrenceLifecycle2026101300020 updates legacy occurrence rows, so the schema owner
  // needs UPDATE (tables do not exist yet to grant per table).
  await admin.query(`GRANT UPDATE ON ${db}.* TO ${quoteUser(set.maintenanceMigrator.username)}`);
  await admin.query(
    `GRANT CREATE, ALTER, INDEX, SELECT, INSERT, CREATE ROUTINE, ALTER ROUTINE ON ${db}.* TO ${quoteUser(set.auditMigrator.username)}`,
  );
}

/**
 * Unlocks or locks the DDL-capable migrator accounts. They stay locked outside `migrateFleetDatabase`,
 * so a process that merely holds the derivation secret (the API) cannot sign in as a schema owner.
 */
export async function setMigratorsLocked(
  admin: AdminConnection,
  set: FleetAccountSet,
  locked: boolean,
): Promise<void> {
  for (const migrator of migratorAccounts(set))
    await admin.query(
      `ALTER USER ${quoteUser(migrator.username)} ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`,
    );
}

const APPEND_AUDIT = 'opslog_append_local_audit_and_delivery';
const ENQUEUE_OUTBOX = 'opslog_enqueue_tenant_outbox';

/**
 * Creates the fleet, files, maintenance, incident and audit runtime accounts and grants them table
 * privileges only (no DDL, no DELETE where the module never deletes). Run after every migration
 * step: the tables must exist to be granted.
 */
export async function provisionFleetRuntimeAccounts(
  admin: AdminConnection,
  database: string,
  set: FleetAccountSet,
): Promise<void> {
  const db = quoteName(database);
  const table = (name: string) => `${db}.${quoteName(name)}`;
  const procedure = (name: string) => `PROCEDURE ${db}.${quoteName(name)}`;
  const grant = (privileges: string, on: string, user: DbAccount) =>
    admin.query(`GRANT ${privileges} ON ${on} TO ${quoteUser(user.username)}`);

  for (const name of FLEET_MODULES) {
    const account = set.runtime[name];
    await ensureAccount(admin, account);
    for (const entry of FLEET_TABLE_GRANTS[name])
      await grant(entry.privileges.join(', '), table(entry.table), account);
    await grant('EXECUTE', procedure(APPEND_AUDIT), account);
  }
  // Maintenance, incidents, search, exports and notifications enqueue their events through the durable tenant outbox.
  for (const account of [
    set.runtime.maintenance,
    set.runtime.incidents,
    set.runtime.search,
    set.runtime.exports,
    set.runtime.notify,
  ]) {
    await grant('SELECT', table(AUDIT_TABLES.outbox), account);
    await grant('EXECUTE', procedure(ENQUEUE_OUTBOX), account);
  }

  const { auditRuntime, auditRelay } = set.runtime;
  await ensureAccount(admin, auditRuntime);
  await ensureAccount(admin, auditRelay);
  await grant('EXECUTE', procedure(APPEND_AUDIT), auditRuntime);
  await grant('EXECUTE', procedure(ENQUEUE_OUTBOX), auditRuntime);
  await grant('SELECT', table(AUDIT_TABLES.projection), auditRuntime);
  await grant('SELECT', table(AUDIT_TABLES.outbox), auditRuntime);
  await grant('SELECT', table(AUDIT_TABLES.local), auditRelay);
  await grant('SELECT', table(AUDIT_TABLES.delivery), auditRelay);
  await grant('SELECT, INSERT', table(AUDIT_TABLES.registry), auditRelay);
  await grant('INSERT', table(AUDIT_TABLES.projection), auditRelay);
  await grant('UPDATE', table(AUDIT_TABLES.delivery), auditRelay);
  await grant(
    'SELECT, UPDATE (status, attempts, available_at, lease_until, fencing, worker_id, last_error, handler_completed)',
    table(AUDIT_TABLES.outbox),
    auditRelay,
  );
}

/** Identity store and control plane: plain DML on their own tables, run after the identity migration. */
export async function provisionIdentityAccount(
  admin: AdminConnection,
  database: string,
  set: FleetAccountSet,
): Promise<void> {
  const db = quoteName(database);
  const table = (name: string) => `${db}.${quoteName(name)}`;
  const grant = (privileges: string, on: string) =>
    admin.query(`GRANT ${privileges} ON ${on} TO ${quoteUser(set.identity.username)}`);
  await ensureAccount(admin, set.identity);
  for (const name of [...Object.values(IDENTITY_TABLES), ...Object.values(CONTROL_PLANE_TABLES)])
    await grant('SELECT, INSERT, UPDATE, DELETE', table(name));
  await grant('EXECUTE', `PROCEDURE ${db}.${quoteName(APPEND_AUDIT)}`);
}

export interface MysqlAdminEndpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

/** Credentials for the schema-owning migration steps of `database`. */
export function migrationCredentials(
  admin: MysqlAdminEndpoint,
  database: string,
  set: FleetAccountSet,
): FleetMigrationCredentials {
  return {
    host: admin.host,
    port: admin.port,
    database,
    username: admin.user,
    password: admin.password,
    auditMigrator: set.auditMigrator,
    filesMigrator: set.filesMigrator,
    maintenanceMigrator: set.maintenanceMigrator,
  };
}

/**
 * One-shot, idempotent provisioning of a deployment database with the admin account: creates the
 * database and the migrator accounts, applies every migration in order (fleet modules, files,
 * maintenance, incidents, audit, identity and control plane), then creates the runtime accounts with
 * their grants. The migrator accounts are unlocked only while it runs. Safe to run on every deploy; the API runtime accounts never run DDL.
 */
export async function migrateFleetDatabase(
  admin: MysqlAdminEndpoint,
  database: string,
  set: FleetAccountSet,
  log: (line: string) => void = () => undefined,
): Promise<readonly string[]> {
  const connection = await mysql.createConnection({
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    database: 'mysql',
  });
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteName(database)} CHARACTER SET utf8mb4`,
    );
    await provisionMigrators(connection, database, set);
    await setMigratorsLocked(connection, set, false);
    const credentials = migrationCredentials(admin, database, set);
    const applied = await runFleetMigrations(credentials);
    log(`fleet migrations applied: ${applied.join(', ')}`);
    await runFleetAuditMigrations(credentials);
    await runIdentityControlMigrations(credentials);
    await provisionFleetRuntimeAccounts(connection, database, set);
    await provisionIdentityAccount(connection, database, set);
    return [...applied, 'audit', 'identity', 'control-plane'];
  } finally {
    try {
      await setMigratorsLocked(connection, set, true);
    } finally {
      await connection.end();
    }
  }
}
