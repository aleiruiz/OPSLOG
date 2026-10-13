import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { INCIDENT_REPAIR_ENTITIES } from './entities.js';
import {
  CreateIncidentRepairLinks2026101700010,
  INCIDENT_REPAIRS_MIGRATIONS_TABLE,
} from './migrations.js';

export interface IncidentRepairsDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly connectTimeoutMs?: number;
}

/** Migration source of the repair links, with its own migrations table; it runs after the cases. */
export function createIncidentRepairsMigrationDataSource(
  config: IncidentRepairsDatabaseConfig,
): DataSource {
  return new DataSource({
    type: 'mysql',
    entities: INCIDENT_REPAIR_ENTITIES,
    migrations: [CreateIncidentRepairLinks2026101700010],
    migrationsTableName: INCIDENT_REPAIRS_MIGRATIONS_TABLE,
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
export async function runIncidentRepairsMigrations(dataSource: DataSource): Promise<void> {
  if (dataSource.options.synchronize === true || dataSource.options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
  await dataSource.runMigrations({ transaction: 'all' });
}
