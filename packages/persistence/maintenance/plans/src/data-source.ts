import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AUDIT_ENTITIES } from '../../../audit/src/index.js';
import { MAINTENANCE_ENTITIES } from './entities.js';
import {
  AddOccurrenceLifecycle2026101300010,
  BackfillOccurrenceLifecycle2026101300020,
  CreateMaintenancePlans2026101200010,
  MAINTENANCE_MIGRATIONS_TABLE,
} from './migrations.js';

export type { DataSource as MaintenanceDataSource } from 'typeorm';

export interface MaintenanceDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectionLimit?: number;
  readonly queueLimit?: number;
  readonly connectTimeoutMs?: number;
}
export const MAINTENANCE_RUNTIME_ACCOUNT = /^opslog_maintenance_[a-z0-9_]+$/i;
const common = {
  type: 'mysql',
  entities: [...MAINTENANCE_ENTITIES, ...AUDIT_ENTITIES],
  migrations: [
    CreateMaintenancePlans2026101200010,
    AddOccurrenceLifecycle2026101300010,
    BackfillOccurrenceLifecycle2026101300020,
  ],
  migrationsTableName: MAINTENANCE_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

export function createMaintenanceDataSource(config: MaintenanceDatabaseConfig): DataSource {
  if (!MAINTENANCE_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Maintenance DataSource requires its restricted runtime account');
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
export function createMaintenanceMigrationDataSource(
  config: Omit<MaintenanceDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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
export async function runMaintenanceMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
