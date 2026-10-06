import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { IDENTITY_ENTITIES } from './entities.js';
import { CreateIdentityStore2026100600010, IDENTITY_MIGRATIONS_TABLE } from './migrations.js';

export interface IdentityDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  /** Maximum pooled connections of this process (default 10). */
  readonly connectionLimit?: number;
  /** Maximum queued connection requests once the pool is exhausted (default 100; 0 is unbounded). */
  readonly queueLimit?: number;
  /** TCP connect timeout in milliseconds (default 10 000). */
  readonly connectTimeoutMs?: number;
}

/** Runtime accounts follow the control-plane naming rule: never root/admin, DML privileges only. */
export const IDENTITY_RUNTIME_ACCOUNT = /^opslog_(identity|control)_[a-z0-9_]+$/i;

const common = {
  type: 'mysql',
  entities: [...IDENTITY_ENTITIES],
  migrations: [CreateIdentityStore2026100600010],
  migrationsTableName: IDENTITY_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

/** Runtime DataSource: restricted account, pooled, no schema changes, no query logging (parameters can hold PII). */
export function createIdentityDataSource(config: IdentityDatabaseConfig): DataSource {
  if (!IDENTITY_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Identity DataSource requires its restricted runtime account');
  return new DataSource({
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
  });
}

/**
 * Migration/administration DataSource (CI and deployment tooling only, with a schema-owning
 * account). The runtime service never receives these credentials.
 */
export function createIdentityMigrationDataSource(
  config: Omit<IdentityDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
): DataSource {
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

export async function runIdentityMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
