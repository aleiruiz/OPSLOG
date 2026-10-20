import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AUDIT_ENTITIES } from '../../audit/src/index.js';
import { EXPORT_ENTITIES } from './entities.js';
import { CreateExportJobs2026101900050, EXPORT_MIGRATIONS_TABLE } from './migrations.js';

export interface ExportDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectionLimit?: number;
  readonly queueLimit?: number;
  readonly connectTimeoutMs?: number;
}

/** Runtime accounts follow the control-plane naming rule: never root/admin, DML privileges only. */
export const EXPORT_RUNTIME_ACCOUNT = /^opslog_exports_[a-z0-9_]+$/i;

const common = {
  type: 'mysql',
  entities: [...EXPORT_ENTITIES, ...AUDIT_ENTITIES],
  migrations: [CreateExportJobs2026101900050],
  migrationsTableName: EXPORT_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

/** Runtime DataSource: restricted account, pooled, no schema changes, no query logging. */
export function createExportDataSource(config: ExportDatabaseConfig): DataSource {
  if (!EXPORT_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Export DataSource requires its restricted runtime account');
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

/** Migration source (deployment and test tooling, schema-owning account only). */
export function createExportMigrationDataSource(
  config: Omit<ExportDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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

export async function runExportMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
