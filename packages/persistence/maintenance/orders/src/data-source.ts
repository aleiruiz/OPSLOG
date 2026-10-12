import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AUDIT_ENTITIES } from '../../../audit/src/index.js';
import { WORK_ORDER_ENTITIES } from './entities.js';
import {
  CreateMaintenanceWorkOrders2026101200030,
  WORK_ORDER_MIGRATIONS_TABLE,
} from './migrations.js';

export interface WorkOrderDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectionLimit?: number;
  readonly queueLimit?: number;
  readonly connectTimeoutMs?: number;
}
/** Work orders share the restricted maintenance runtime account of the tenant database. */
export const WORK_ORDER_RUNTIME_ACCOUNT = /^opslog_maintenance_[a-z0-9_]+$/i;
const common = {
  type: 'mysql',
  entities: [...WORK_ORDER_ENTITIES, ...AUDIT_ENTITIES],
  migrations: [CreateMaintenanceWorkOrders2026101200030],
  migrationsTableName: WORK_ORDER_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
  bigNumberStrings: true,
  supportBigNumbers: true,
} as const satisfies Partial<DataSourceOptions>;

export function createWorkOrderDataSource(config: WorkOrderDatabaseConfig): DataSource {
  if (!WORK_ORDER_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Work order DataSource requires the restricted maintenance runtime account');
  return new DataSource({
    ...common,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    connectTimeout: config.connectTimeoutMs ?? 10_000,
    extra: {
      connectionLimit: config.connectionLimit ?? 5,
      waitForConnections: true,
      queueLimit: config.queueLimit ?? 100,
    },
  });
}
export function createWorkOrderMigrationDataSource(
  config: Omit<WorkOrderDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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
export async function runWorkOrderMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
