import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { IMPORT_ORM_ENTITIES } from './entities.js';
import { CreateImportJobs2026100600090, IMPORTS_MIGRATIONS_TABLE } from './migrations.js';

export interface ImportsDatabaseConfig {
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

/** Runtime accounts follow the control-plane naming rule: never root/admin, DML privileges only. Production grants: SELECT, INSERT, UPDATE on opslog_import_jobs (a job is finished, never removed) and SELECT, INSERT on opslog_import_job_rows and opslog_import_job_events (append-only); no DELETE anywhere. */
export const IMPORTS_RUNTIME_ACCOUNT = /^opslog_imports_[a-z0-9_]+$/i;

const common = {
  type: 'mysql',
  entities: [...IMPORT_ORM_ENTITIES],
  migrations: [CreateImportJobs2026100600090],
  migrationsTableName: IMPORTS_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

/** Runtime DataSource: restricted account, pooled, no schema changes, no query logging (parameters can hold reasons). */
export function createImportsDataSource(config: ImportsDatabaseConfig): DataSource {
  if (!IMPORTS_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Imports DataSource requires its restricted runtime account');
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
export function createImportsMigrationDataSource(
  config: Omit<ImportsDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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

export async function runImportsMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
