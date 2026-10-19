import type { PlatformAdapters } from './types.js';
import { TypeOrmFileSagaStore } from '../../../../../packages/persistence/files/src/index.js';
import { TypeOrmAreaStore } from '../../../../../packages/persistence/areas/src/index.js';
import { TypeOrmAssignmentStore } from '../../../../../packages/persistence/assignments/src/index.js';
import { TypeOrmDocumentStore } from '../../../../../packages/persistence/documents/src/index.js';
import { TypeOrmEmployeeStore } from '../../../../../packages/persistence/employees/src/index.js';
import { TypeOrmImportStore } from '../../../../../packages/persistence/imports/src/index.js';
import { TypeOrmPolicyStore } from '../../../../../packages/persistence/insurance/src/index.js';
import { TypeOrmSettingsStore } from '../../../../../packages/persistence/settings/src/index.js';
import { TypeOrmVehicleStore } from '../../../../../packages/persistence/vehicles/src/index.js';
import { InMemoryMaintenancePlanStore } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import { InMemoryWorkshopStore } from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { InMemoryWorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';

export function hasPersistentBusinessStores(adapters: PlatformAdapters): boolean {
  return [
    adapters.roleStore !== undefined,
    adapters.areas instanceof TypeOrmAreaStore,
    adapters.vehicles instanceof TypeOrmVehicleStore,
    adapters.employees instanceof TypeOrmEmployeeStore,
    adapters.documents instanceof TypeOrmDocumentStore,
    adapters.insurance instanceof TypeOrmPolicyStore,
    adapters.assignments instanceof TypeOrmAssignmentStore,
    adapters.settings instanceof TypeOrmSettingsStore,
    adapters.imports instanceof TypeOrmImportStore,
    adapters.records !== undefined,
    (adapters.maintenancePlans !== undefined &&
      !(adapters.maintenancePlans instanceof InMemoryMaintenancePlanStore)) ||
      (adapters.maintenanceWorkshops !== undefined &&
        !(adapters.maintenanceWorkshops instanceof InMemoryWorkshopStore)) ||
      (adapters.maintenanceMechanics !== undefined &&
        !(adapters.maintenanceMechanics instanceof InMemoryMechanicStore)) ||
      (adapters.maintenanceOrders !== undefined &&
        !(adapters.maintenanceOrders instanceof InMemoryWorkOrderStore)),
  ].some(Boolean);
}

/** A persistent file saga store must be the one store behind the records, the queue and the journal. */
export function assertDurableFileStores(adapters: PlatformAdapters): void {
  if (
    adapters.records instanceof TypeOrmFileSagaStore &&
    (adapters.fileSagaJournal !== adapters.records || adapters.scanQueue !== adapters.records)
  )
    throw new Error(
      'persistent file stores require one durable file saga store for records, queue and journal',
    );
}
