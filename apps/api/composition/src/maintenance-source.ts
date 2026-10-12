import {
  createMaintenanceDataSource,
  TypeOrmMaintenancePlanStore,
  type MaintenanceDatabaseConfig,
} from '../../../../packages/persistence/maintenance/plans/src/index.js';
import { TypeOrmWorkshopStore } from '../../../../packages/persistence/maintenance/workshops/src/index.js';
import { TypeOrmMechanicStore } from '../../../../packages/persistence/maintenance/mechanics/src/index.js';

export async function openMaintenanceRuntimeSource(
  endpoint: Omit<MaintenanceDatabaseConfig, 'username' | 'password'>,
  account: Pick<MaintenanceDatabaseConfig, 'username' | 'password'>,
) {
  const source = createMaintenanceDataSource({ ...endpoint, ...account });
  await source.initialize();
  return source;
}

export function maintenanceRuntimeAdapters(
  source: Awaited<ReturnType<typeof openMaintenanceRuntimeSource>>,
) {
  return {
    maintenancePlans: new TypeOrmMaintenancePlanStore(source),
    maintenanceWorkshops: new TypeOrmWorkshopStore(source),
    maintenanceMechanics: new TypeOrmMechanicStore(source),
  };
}
