import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { DOCUMENT_ENTITIES } from './entities.js';
import { CreateDocuments2026100600060, DOCUMENTS_MIGRATIONS_TABLE } from './migrations.js';

export interface DocumentsDatabaseConfig {
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

/** Runtime accounts follow the control-plane naming rule: never root/admin, DML privileges only. Production grants: SELECT, INSERT, UPDATE on opslog_documents (no DELETE: soft delete) and SELECT, INSERT on opslog_document_revisions (append-only). */
export const DOCUMENTS_RUNTIME_ACCOUNT = /^opslog_documents_[a-z0-9_]+$/i;

const common = {
  type: 'mysql',
  entities: [...DOCUMENT_ENTITIES],
  migrations: [CreateDocuments2026100600060],
  migrationsTableName: DOCUMENTS_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

/** Runtime DataSource: restricted account, pooled, no schema changes, no query logging (parameters can hold personal data). */
export function createDocumentsDataSource(config: DocumentsDatabaseConfig): DataSource {
  if (!DOCUMENTS_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Documents DataSource requires its restricted runtime account');
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
export function createDocumentsMigrationDataSource(
  config: Omit<DocumentsDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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

export async function runDocumentsMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
