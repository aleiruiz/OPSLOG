import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { POLICY_ENTITIES } from './entities.js';
import { AUDIT_ENTITIES } from '../../audit/src/index.js';
import { CreateInsurancePolicies2026100600070, INSURANCE_MIGRATIONS_TABLE } from './migrations.js';

export interface InsuranceDatabaseConfig {
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

/** Runtime accounts follow the control-plane naming rule: never root/admin, DML privileges only. Production grants: SELECT, INSERT, UPDATE on opslog_insurance_policies (no DELETE: soft delete) and SELECT, INSERT on opslog_insurance_policy_revisions (append-only). */
export const INSURANCE_RUNTIME_ACCOUNT = /^opslog_insurance_[a-z0-9_]+$/i;

const common = {
  type: 'mysql',
  entities: [...POLICY_ENTITIES, ...AUDIT_ENTITIES.slice(0, 2)],
  migrations: [CreateInsurancePolicies2026100600070],
  migrationsTableName: INSURANCE_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
} as const satisfies Partial<DataSourceOptions>;

/** Runtime DataSource: restricted account, pooled, no schema changes, no query logging (parameters can hold personal data). */
export function createInsuranceDataSource(config: InsuranceDatabaseConfig): DataSource {
  if (!INSURANCE_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Insurance DataSource requires its restricted runtime account');
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
export function createInsuranceMigrationDataSource(
  config: Omit<InsuranceDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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

export async function runInsuranceMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
