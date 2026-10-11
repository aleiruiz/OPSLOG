import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AUDIT_ENTITIES } from './entities.js';
import {
  CreateAuditStore2026100700010,
  CreateTenantOutbox2026100900010,
  AUDIT_MIGRATIONS_TABLE,
} from './migrations.js';

export interface AuditDatabaseConfig {
  readonly host: string;
  readonly port: number;
  /** One physical database for exactly one tenant: `opslog_t_<opaqueId>`. */
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectionLimit?: number;
  readonly queueLimit?: number;
  readonly connectTimeoutMs?: number;
}

export const AUDIT_TENANT_DATABASE = /^opslog_t_[a-z0-9_]{1,100}$/i;
export const AUDIT_RUNTIME_ACCOUNT = /^opslog_audit_runtime_[a-z0-9_]{1,48}$/i;
export const AUDIT_RELAY_ACCOUNT = /^opslog_audit_relay_[a-z0-9_]{1,48}$/i;
export const AUDIT_MIGRATOR_ACCOUNT = /^opslog_audit_migrator_[a-z0-9_]{1,48}$/i;

const common = {
  type: 'mysql',
  entities: [...AUDIT_ENTITIES],
  migrations: [CreateAuditStore2026100700010, CreateTenantOutbox2026100900010],
  migrationsTableName: AUDIT_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

function requireTenantDatabase(config: AuditDatabaseConfig): void {
  if (!AUDIT_TENANT_DATABASE.test(config.database))
    throw new Error('Audit DataSource requires one tenant-exclusive database');
}

function runtimeOptions(config: AuditDatabaseConfig): DataSourceOptions {
  requireTenantDatabase(config);
  return {
    ...common,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    connectTimeout: config.connectTimeoutMs ?? 10_000,
    extra: {
      connectionLimit: config.connectionLimit ?? 10,
      waitForConnections: true,
      queueLimit: config.queueLimit ?? 100,
    },
  } as DataSourceOptions;
}

/** API account: module business DML, EXECUTE on the idempotent local append routine, projection SELECT. */
export function createAuditRuntimeDataSource(config: AuditDatabaseConfig): DataSource {
  if (!AUDIT_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Audit runtime DataSource requires its restricted account');
  return new DataSource(runtimeOptions(config));
}

/** Relay account: local SELECT, projection/registry INSERT, and delivery-state UPDATE. */
export function createAuditRelayDataSource(config: AuditDatabaseConfig): DataSource {
  if (!AUDIT_RELAY_ACCOUNT.test(config.username))
    throw new Error('Audit relay DataSource requires its restricted account');
  return new DataSource(runtimeOptions(config));
}

/** Migration-only DataSource. Never pass its credentials to API or relay code. */
export function createAuditMigrationDataSource(config: AuditDatabaseConfig): DataSource {
  if (!AUDIT_MIGRATOR_ACCOUNT.test(config.username))
    throw new Error('Audit migration DataSource requires its schema-owner account');
  requireTenantDatabase(config);
  return new DataSource({
    ...common,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    connectTimeout: config.connectTimeoutMs ?? 10_000,
  });
}

export async function runAuditMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
