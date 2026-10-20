import { AUDIT_TABLES } from '../../../../packages/persistence/audit/src/index.js';
import { EXPORT_TABLES } from '../../../../packages/persistence/exports/src/index.js';
import { FILE_TABLES } from '../../../../packages/persistence/files/src/index.js';
import { NOTIFICATION_TABLES } from '../../../../packages/persistence/notifications/src/index.js';
import { WEBHOOK_TABLES } from '../../../../packages/persistence/webhooks/src/index.js';
import { createAuditMigrationDataSource } from '../../../../packages/persistence/audit/src/index.js';
import { createIdentityMigrationDataSource } from '../../../../packages/persistence/identity/src/index.js';
import { identityControlSchema } from './control-plane/identity-schema.js';
import { createFleetMigrationModules } from './fleet-migrations.js';
import {
  buildFleetAccounts,
  ensureAccount,
  migrationCredentials,
  quoteName,
  quoteUser,
  type AdminConnection,
  type DbAccount,
  type FleetAccountSet,
} from './mysql-provisioning.js';

/**
 * The only columns of the queue tables the `ops_stats` counters read (see `ops.ts`). The probe
 * account gets column-level SELECT on these, so it cannot read payloads, recipients or tokens.
 */
export const OPS_STAT_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map([
  [AUDIT_TABLES.outbox, ['status', 'available_at']],
  [WEBHOOK_TABLES.deliveries, ['status']],
  [NOTIFICATION_TABLES.deliveries, ['status', 'channel']],
  [EXPORT_TABLES.jobs, ['status']],
  [FILE_TABLES.saga, ['stage', 'state']],
]);

export interface ExpectedMigration {
  /** TypeORM migrations table of one module. */
  readonly table: string;
  /** Timestamp (digits) of the newest migration the code ships for that table. */
  readonly latest: string;
}

/** TypeORM names a migration `<Name><13-digit timestamp>`. */
const timestampOf = (migration: unknown): string | undefined =>
  typeof migration === 'function' ? /(\d{13})$/.exec(migration.name)?.[1] : undefined;

/**
 * The newest migration this build ships for every migrations table (fleet modules, audit, identity
 * and control plane), read from the same data-source definitions `migrate` runs. No connection is
 * opened: constructing a DataSource does not connect.
 */
export function expectedMigrations(): readonly ExpectedMigration[] {
  const set = buildFleetAccounts('app', 'app', () => 'unused');
  const credentials = migrationCredentials(
    { host: 'unused', port: 3306, user: 'unused', password: 'unused' },
    'opslog_t_unused',
    set,
  );
  const endpoint = { host: 'unused', port: 3306, database: 'opslog_t_unused' };
  const sources = [
    ...createFleetMigrationModules(credentials).map((module) => module.source),
    createAuditMigrationDataSource({ ...endpoint, ...set.auditMigrator }),
    createIdentityMigrationDataSource({
      ...endpoint,
      username: 'unused',
      password: 'unused',
      ...identityControlSchema,
    }),
  ];
  const latest = new Map<string, bigint>();
  for (const { options } of sources) {
    const table = options.migrationsTableName;
    if (typeof table !== 'string' || !Array.isArray(options.migrations)) continue;
    for (const migration of options.migrations) {
      const stamp = timestampOf(migration);
      if (stamp === undefined) continue;
      const value = BigInt(stamp);
      if (value > (latest.get(table) ?? 0n)) latest.set(table, value);
    }
  }
  return [...latest].map(([table, value]) => ({ table, latest: value.toString() }));
}

/**
 * The probe account behind `/readyz` and `ops_stats`: SELECT only; the `timestamp` column of the
 * migrations tables and the status columns of `OPS_STAT_COLUMNS`. Run after every migration step
 * (the tables must exist).
 */
export async function provisionOpsAccount(
  admin: AdminConnection,
  database: string,
  set: FleetAccountSet,
): Promise<void> {
  const db = quoteName(database);
  await ensureAccount(admin, set.ops);
  const grants = new Map<string, readonly string[]>(OPS_STAT_COLUMNS);
  for (const entry of expectedMigrations()) grants.set(entry.table, ['timestamp']);
  const user = quoteUser(set.ops.username);
  for (const [table, columns] of grants) {
    const list = columns.map((column) => `\`${column}\``).join(', ');
    await admin.query(`GRANT SELECT (${list}) ON ${db}.${quoteName(table)} TO ${user}`);
  }
}

/** Default name of the backup account the `backup` container signs in with. */
export const BACKUP_ACCOUNT = 'opslog_backup';

/**
 * The account of the `backup` container: what `mysqldump --single-transaction --source-data=2
 * --routines --triggers` and the binlog copy need, and nothing that writes data or changes the
 * schema. Table privileges cover every `opslog_t_*` database, present and future.
 *
 * - SELECT, SHOW VIEW: read the data and view definitions.
 * - TRIGGER: `mysqldump --triggers` only sees a trigger when the account holds it (verified: without
 *   it the dump silently omits triggers). It also lets the account create one, which MySQL blocks
 *   with error 1419 only while the binlog is on and `log_bin_trust_function_creators=0`, the
 *   settings of this compose. The schema has no triggers today. See infra/operations/README.md.
 * - RELOAD: `FLUSH BINARY LOGS` and the brief global lock of `--source-data`.
 * - REPLICATION CLIENT: `SHOW BINARY LOGS` and the dump's binlog position.
 * - REPLICATION SLAVE: `mysqlbinlog --read-from-remote-server` (the copy of closed binlogs).
 * - SHOW_ROUTINE: `--routines` (the audit stored procedures).
 */
export async function provisionBackupAccount(
  admin: AdminConnection,
  password: string,
  username: string = BACKUP_ACCOUNT,
): Promise<void> {
  const account: DbAccount = { username, password };
  await ensureAccount(admin, account);
  const user = quoteUser(account.username);
  await admin.query(
    `GRANT RELOAD, REPLICATION CLIENT, REPLICATION SLAVE, SHOW_ROUTINE ON *.* TO ${user}`,
  );
  await admin.query(`GRANT SELECT, SHOW VIEW, TRIGGER ON \`opslog\\_t\\_%\`.* TO ${user}`);
}
