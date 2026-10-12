import {
  createMaintenanceDataSource,
  createMaintenanceMigrationDataSource,
  runMaintenanceMigrations,
  TypeOrmMaintenancePlanStore,
  type MaintenanceDatabaseConfig,
} from '../../../../packages/persistence/maintenance/plans/src/index.js';
import { TypeOrmWorkshopStore } from '../../../../packages/persistence/maintenance/workshops/src/index.js';
import { TypeOrmMechanicStore } from '../../../../packages/persistence/maintenance/mechanics/src/index.js';
import {
  createWorkOrderDataSource,
  createWorkOrderMigrationDataSource,
  runWorkOrderMigrations,
  TypeOrmWorkOrderStore,
} from '../../../../packages/persistence/maintenance/orders/src/index.js';

type Endpoint = Pick<MaintenanceDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<MaintenanceDatabaseConfig, 'username' | 'password'>;

/** Ordered maintenance schema steps: MNT-PLANS catalogs first, then the work orders that reference them. */
export function maintenanceMigrationSteps(endpoint: Endpoint, migrator: Account) {
  const config = { ...endpoint, ...migrator };
  return [
    {
      name: 'maintenance',
      version: '2026101200010',
      source: createMaintenanceMigrationDataSource(config),
      run: runMaintenanceMigrations,
    },
    {
      name: 'maintenance-orders',
      version: '2026101200030',
      source: createWorkOrderMigrationDataSource(config),
      run: runWorkOrderMigrations,
    },
  ] as const;
}

/** Uninitialized maintenance sources; the caller initializes them so a failed startup closes them. */
export function createMaintenanceRuntimeSources(
  endpoint: Omit<MaintenanceDatabaseConfig, 'username' | 'password'>,
  account: Pick<MaintenanceDatabaseConfig, 'username' | 'password'>,
) {
  return {
    plans: createMaintenanceDataSource({ ...endpoint, ...account }),
    orders: createWorkOrderDataSource({ ...endpoint, ...account }),
  };
}

export function maintenanceRuntimeAdapters(
  sources: ReturnType<typeof createMaintenanceRuntimeSources>,
) {
  return {
    maintenancePlans: new TypeOrmMaintenancePlanStore(sources.plans),
    maintenanceWorkshops: new TypeOrmWorkshopStore(sources.plans),
    maintenanceMechanics: new TypeOrmMechanicStore(sources.plans),
    maintenanceOrders: new TypeOrmWorkOrderStore(sources.orders),
  };
}
