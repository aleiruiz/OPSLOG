import { DataSource, type DataSourceOptions } from 'typeorm';
import { CreateTenancyControlPlane2026100400010 } from './migrations.js';
import { CONTROL_PLANE_ENTITIES } from './entities.js';

export interface ControlPlaneDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export function createControlPlaneDataSource(config: ControlPlaneDatabaseConfig): DataSource {
  if (!/^opslog_control_[a-z0-9_]+$/i.test(config.username))
    throw new Error('Control-plane DataSource requires its restricted runtime account');
  return new DataSource({
    type: 'mysql',
    ...config,
    entities: [...CONTROL_PLANE_ENTITIES],
    migrations: [CreateTenancyControlPlane2026100400010],
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'all',
    logging: false,
    timezone: 'Z',
    charset: 'utf8mb4',
  });
}

export async function runControlPlaneMigrations(dataSource: DataSource): Promise<void> {
  assertSafeMigrations(dataSource.options);
  await dataSource.runMigrations({ transaction: 'all' });
}

export async function runTenantMigrations(dataSource: DataSource): Promise<void> {
  assertSafeMigrations(dataSource.options);
  await dataSource.runMigrations({ transaction: 'all' });
}

function assertSafeMigrations(options: DataSourceOptions): void {
  if (options.synchronize === true || options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
}
