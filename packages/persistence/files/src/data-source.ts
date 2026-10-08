import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AUDIT_ENTITIES } from '../../audit/src/entities.js';
import { FILE_ENTITIES } from './entities.js';
import { CreateFiles2026100700010, FILES_MIGRATIONS_TABLE } from './migrations.js';

export interface FilesDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectionLimit?: number;
  readonly queueLimit?: number;
  readonly connectTimeoutMs?: number;
}

export const FILES_RUNTIME_ACCOUNT = /^opslog_files_[a-z0-9_]+$/i;
export const FILES_MIGRATOR_ACCOUNT = /^opslog_files_migrator_[a-z0-9_]+$/i;
export const FILES_TENANT_DATABASE = /^opslog_t_[a-z0-9_]{1,100}$/i;

const common = {
  type: 'mysql',
  entities: [...FILE_ENTITIES, ...AUDIT_ENTITIES],
  migrations: [CreateFiles2026100700010],
  migrationsTableName: FILES_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

export function createFilesDataSource(config: FilesDatabaseConfig): DataSource {
  if (!FILES_TENANT_DATABASE.test(config.database))
    throw new Error('Files DataSource requires one tenant-exclusive database');
  if (!FILES_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Files DataSource requires its tenant-scoped runtime account');
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

export function createFilesMigrationDataSource(
  config: Omit<FilesDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
): DataSource {
  if (!FILES_TENANT_DATABASE.test(config.database))
    throw new Error('Files migration DataSource requires one tenant-exclusive database');
  if (!FILES_MIGRATOR_ACCOUNT.test(config.username))
    throw new Error('Files migration DataSource requires its schema-owner account');
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

export async function runFilesMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.type !== 'mysql') throw new Error('Files migrations require MySQL');
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic file schema synchronization and startup migrations are forbidden');
  if (
    typeof dataSource.options.username !== 'string' ||
    !FILES_MIGRATOR_ACCOUNT.test(dataSource.options.username)
  )
    throw new Error('Files migrations require the schema-owner account');
  await dataSource.runMigrations({ transaction: 'all' });
}
