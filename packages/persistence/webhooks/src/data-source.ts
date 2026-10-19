import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { WEBHOOK_ENTITIES } from './entities.js';
import { CreateWebhooks2026101900070, WEBHOOK_MIGRATIONS_TABLE } from './migrations.js';

export interface WebhookDatabaseConfig {
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
export const WEBHOOK_RUNTIME_ACCOUNT = /^opslog_webhooks_[a-z0-9_]+$/i;

const common = {
  type: 'mysql',
  entities: [...WEBHOOK_ENTITIES],
  migrations: [CreateWebhooks2026101900070],
  migrationsTableName: WEBHOOK_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

/** Runtime DataSource: restricted account, pooled, no schema changes, no query logging. */
export function createWebhookDataSource(config: WebhookDatabaseConfig): DataSource {
  if (!WEBHOOK_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Webhook DataSource requires its restricted runtime account');
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
export function createWebhookMigrationDataSource(
  config: Omit<WebhookDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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

export async function runWebhookMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
