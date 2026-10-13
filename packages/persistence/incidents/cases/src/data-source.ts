import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AUDIT_ENTITIES } from '../../../audit/src/index.js';
import {
  CreateIncidentChildren2026101500020,
  INCIDENT_CHILD_ENTITIES,
} from '../../third-parties/src/index.js';
import { INCIDENT_ENTITIES } from './entities.js';
import { CreateIncidentCases2026101500010, INCIDENT_MIGRATIONS_TABLE } from './migrations.js';

export interface IncidentDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectionLimit?: number;
  readonly queueLimit?: number;
  readonly connectTimeoutMs?: number;
}
/** Incidents have their own restricted runtime account of the tenant database. */
export const INCIDENT_RUNTIME_ACCOUNT = /^opslog_incidents_[a-z0-9_]+$/i;
const common = {
  type: 'mysql',
  entities: [...INCIDENT_ENTITIES, ...INCIDENT_CHILD_ENTITIES, ...AUDIT_ENTITIES],
  // Ordered by version: the cases first, then their third parties and evidence (PR 2).
  migrations: [CreateIncidentCases2026101500010, CreateIncidentChildren2026101500020],
  migrationsTableName: INCIDENT_MIGRATIONS_TABLE,
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  logging: false,
  timezone: 'Z',
  charset: 'utf8mb4',
  bigNumberStrings: true,
  supportBigNumbers: true,
} as const satisfies Partial<DataSourceOptions>;

export function createIncidentDataSource(config: IncidentDatabaseConfig): DataSource {
  if (!INCIDENT_RUNTIME_ACCOUNT.test(config.username))
    throw new Error('Incident DataSource requires the restricted incidents runtime account');
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
export function createIncidentMigrationDataSource(
  config: Omit<IncidentDatabaseConfig, 'connectionLimit' | 'queueLimit'>,
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
export async function runIncidentMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
