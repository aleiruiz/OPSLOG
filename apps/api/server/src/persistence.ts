import mysql from 'mysql2/promise';
import {
  buildFleetAccounts,
  deriveAccountPassword,
  expectedMigrations,
  migrateFleetDatabase,
  openMysqlPlatform,
  provisionBackupAccount,
  type MysqlPlatform,
} from '../../composition/src/index.js';
import { createOpsProbe, type OpsProbe } from './ops.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../packages/platform/pii/src/index.js';
import type { Env } from './config.js';
import { readMysqlEndpoint, readMysqlSecret, type MysqlServerConfig } from './mysql-config.js';

/** Fixed account suffix: the migrate job and the API derive the same names from the same secret. */
export const ACCOUNT_TAG = 'app';

/** Pooled connections per DataSource: the platform opens about sixteen, on a small shared host. */
export const CONNECTIONS_PER_SOURCE = 2;

const accountsFor = (secret: string) =>
  buildFleetAccounts(ACCOUNT_TAG, ACCOUNT_TAG, (username) =>
    deriveAccountPassword(secret, username),
  );

/**
 * Opens the whole platform on MySQL with the restricted runtime accounts. The schema and the
 * accounts must already exist (the `migrate` job creates them); this process never runs DDL.
 */
export function openPersistentAdapters(config: MysqlServerConfig): Promise<MysqlPlatform> {
  return openMysqlPlatform({
    host: config.host,
    port: config.port,
    database: config.database,
    accounts: accountsFor(config.secret),
    // Staging only: the master key lives in the environment (LocalDevKms refuses production).
    pii: new EnvelopePiiCipher(LocalDevKms.fromBase64(config.piiMasterKey, 'staging')),
    connectionLimit: CONNECTIONS_PER_SOURCE,
  });
}

/** The SELECT-only probe behind `/readyz` and `ops_stats`; it connects when asked, never at start-up. */
export function openOpsProbe(config: MysqlServerConfig): OpsProbe {
  return createOpsProbe(
    {
      host: config.host,
      port: config.port,
      database: config.database,
      account: accountsFor(config.secret).ops,
    },
    expectedMigrations(),
  );
}

/** Shortest backup password accepted: it is an operator-chosen secret, not a derived one. */
export const MIN_BACKUP_PASSWORD = 24;

/**
 * The one-shot migrate job: with the MySQL admin account it creates the database, applies every
 * migration, creates the restricted runtime accounts and grants them table privileges. Idempotent,
 * so it runs on every deploy before the API starts.
 */
export async function runMigrate(
  env: Env,
  log: (line: string) => void,
): Promise<readonly string[]> {
  const endpoint = readMysqlEndpoint(env);
  const password = env.OPSLOG_MYSQL_ROOT_PASSWORD;
  // An empty value is a legitimate (local) root password; only a missing variable is an error.
  if (password === undefined) throw new Error('OPSLOG_MYSQL_ROOT_PASSWORD is required');
  const applied = await migrateFleetDatabase(
    {
      host: endpoint.host,
      port: endpoint.port,
      user: env.OPSLOG_MYSQL_ADMIN_USER?.trim() || 'root',
      password,
    },
    endpoint.database,
    accountsFor(readMysqlSecret(env)),
    log,
  );
  // Optional: the account the `backup` container signs in with. Without a password none is created.
  const backupPassword = env.OPSLOG_BACKUP_PASSWORD;
  if (backupPassword) {
    if (backupPassword.length < MIN_BACKUP_PASSWORD)
      throw new Error(`OPSLOG_BACKUP_PASSWORD needs at least ${MIN_BACKUP_PASSWORD} characters`);
    const connection = await mysql.createConnection({
      host: endpoint.host,
      port: endpoint.port,
      user: env.OPSLOG_MYSQL_ADMIN_USER?.trim() || 'root',
      password,
      database: 'mysql',
    });
    try {
      await provisionBackupAccount(connection, backupPassword);
    } finally {
      await connection.end();
    }
    log('backup account provisioned');
  }
  log(`migrate done: ${applied.length} steps`);
  return applied;
}
