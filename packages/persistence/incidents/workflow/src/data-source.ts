import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { INCIDENT_WORKFLOW_ENTITIES } from './entities.js';
import {
  CreateIncidentClosures2026101600010,
  INCIDENT_WORKFLOW_MIGRATIONS_TABLE,
} from './migrations.js';

export interface IncidentWorkflowDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectTimeoutMs?: number;
}

/** Migration source of the workflow, with its own migrations table; it runs after the cases. */
export function createIncidentWorkflowMigrationDataSource(
  config: IncidentWorkflowDatabaseConfig,
): DataSource {
  return new DataSource({
    type: 'mysql',
    entities: INCIDENT_WORKFLOW_ENTITIES,
    migrations: [CreateIncidentClosures2026101600010],
    migrationsTableName: INCIDENT_WORKFLOW_MIGRATIONS_TABLE,
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'all',
    logging: false,
    timezone: 'Z',
    charset: 'utf8mb4',
    bigNumberStrings: true,
    supportBigNumbers: true,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    connectTimeout: config.connectTimeoutMs ?? 10_000,
  });
}
export async function runIncidentWorkflowMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
