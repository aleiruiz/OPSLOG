import {
  buildFleetAccounts,
  deriveAccountPassword,
  migrateFleetDatabase,
  openMysqlPlatform,
  type MysqlPlatform,
} from '../../composition/src/index.js';
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
  log(`migrate done: ${applied.length} steps`);
  return applied;
}
