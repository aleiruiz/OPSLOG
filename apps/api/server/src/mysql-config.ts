import type { Env } from './config.js';

/** Everything the server needs to open its MySQL persistence. Never logged. */
export interface MysqlServerConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Root secret from which every per-account MySQL password is derived (at least 32 characters). */
  readonly secret: string;
  /** Base64 master key of the local KMS that seals personal data (at least 32 bytes). */
  readonly piiMasterKey: string;
  /** Suffix of the account names (default `app`); only tests that share one MySQL set it. */
  readonly accountTag?: string;
}

const MIN_SECRET = 32;
/** The persistence packages only accept a tenant-exclusive database named like this. */
const DATABASE = /^opslog_t_[a-z0-9_]{1,100}$/i;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required with OPSLOG_PERSISTENCE=mysql`);
  return value;
}

/** Endpoint and database shared by the API (`readMysqlConfig`) and the one-shot migrate job. */
export function readMysqlEndpoint(env: Env): Pick<MysqlServerConfig, 'host' | 'port' | 'database'> {
  const port = Number(env.OPSLOG_MYSQL_PORT?.trim() || '3306');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('OPSLOG_MYSQL_PORT is not a port');
  const database = env.OPSLOG_MYSQL_DATABASE?.trim() || 'opslog_t_main';
  if (!DATABASE.test(database))
    throw new Error('OPSLOG_MYSQL_DATABASE must be named opslog_t_<name>');
  return { host: env.OPSLOG_MYSQL_HOST?.trim() || 'mysql', port, database };
}

const ACCOUNT_TAG_PATTERN = /^[a-z0-9]{1,8}$/;
const BACKUP_USER_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** `OPSLOG_MYSQL_ACCOUNT_TAG`: suffix of the runtime account names; the same on `migrate` and `api`. */
export function readAccountTag(env: Env): string {
  const tag = env.OPSLOG_MYSQL_ACCOUNT_TAG?.trim() || 'app';
  if (!ACCOUNT_TAG_PATTERN.test(tag))
    throw new Error('OPSLOG_MYSQL_ACCOUNT_TAG must be 1 to 8 lowercase letters or digits');
  return tag;
}

/** `OPSLOG_BACKUP_USER`: name of the backup account (default `opslog_backup`). */
export function readBackupUser(env: Env): string {
  const user = env.OPSLOG_BACKUP_USER?.trim() || 'opslog_backup';
  if (!BACKUP_USER_PATTERN.test(user))
    throw new Error('OPSLOG_BACKUP_USER must be lowercase letters, digits and underscores');
  return user;
}

export function readMysqlSecret(env: Env): string {
  const secret = required(env, 'OPSLOG_MYSQL_SECRET');
  if (secret.length < MIN_SECRET)
    throw new Error(`OPSLOG_MYSQL_SECRET needs at least ${MIN_SECRET} characters`);
  return secret;
}

/** Parses the MySQL variables. Messages name the variable, never its value. */
export function readMysqlConfig(env: Env): MysqlServerConfig {
  const piiMasterKey = required(env, 'OPSLOG_PII_MASTER_KEY');
  if (Buffer.from(piiMasterKey, 'base64').length < MIN_SECRET)
    throw new Error('OPSLOG_PII_MASTER_KEY must be base64 of at least 32 bytes');
  return {
    ...readMysqlEndpoint(env),
    secret: readMysqlSecret(env),
    piiMasterKey,
    accountTag: readAccountTag(env),
  };
}
