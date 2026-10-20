import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AUDIT_ENTITIES } from '../../audit/src/index.js';
import { NOTIFICATION_ENTITIES } from './entities.js';
import { CreateNotifications2026101900060, NOTIFICATION_MIGRATIONS_TABLE } from './migrations.js';

export interface NotificationDatabaseConfig {
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
export const NOTIFICATION_RUNTIME_ACCOUNT = /^opslog_notify_[a-z0-9_]+$/i;

const common = {
  type: 'mysql',
  entities: [...NOTIFICATION_ENTITIES, ...AUDIT_ENTITIES],
  migrations: [CreateNotifications2026101900060],
  migrationsTableName: NOTIFICATION_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

/** Runtime DataSource: restricted account, pooled, no schema changes, no query logging. */
export function createNotificationDataSource(config: NotificationDatabaseConfig): DataSource {
  if (!NOTIFICATION_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Notification DataSource requires its restricted runtime account');
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
export function createNotificationMigrationDataSource(
  config: Omit<NotificationDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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

export async function runNotificationMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
