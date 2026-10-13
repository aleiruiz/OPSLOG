import {
  createIncidentDataSource,
  createIncidentMigrationDataSource,
  runIncidentMigrations,
  TypeOrmIncidentStore,
  INCIDENT_MIGRATION_VERSION,
  type IncidentDatabaseConfig,
} from '../../../../packages/persistence/incidents/cases/src/index.js';
import {
  INCIDENT_WORKFLOW_MIGRATION_VERSION,
  TypeOrmIncidentClosures,
  createIncidentWorkflowMigrationDataSource,
  runIncidentWorkflowMigrations,
} from '../../../../packages/persistence/incidents/workflow/src/index.js';
import {
  INCIDENT_REPAIRS_MIGRATION_VERSION,
  TypeOrmIncidentRepairStore,
  createIncidentRepairsMigrationDataSource,
  runIncidentRepairsMigrations,
} from '../../../../packages/persistence/incidents/repairs/src/index.js';
import {
  INCIDENT_COSTS_MIGRATION_VERSION,
  TypeOrmIncidentCostStore,
  createIncidentCostsMigrationDataSource,
  runIncidentCostsMigrations,
} from '../../../../packages/persistence/incidents/costs/src/index.js';
import { TypeOrmIncidentChildStore } from '../../../../packages/persistence/incidents/third-parties/src/index.js';

type Endpoint = Pick<IncidentDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<IncidentDatabaseConfig, 'username' | 'password'>;

/**
 * Incident schema step (the cases, then their third parties and evidence, in version order); it
 * runs after the maintenance steps and needs no module before it.
 */
export function incidentMigrationSteps(endpoint: Endpoint, migrator: Account) {
  return [
    {
      name: 'incident-cases',
      version: INCIDENT_MIGRATION_VERSION,
      source: createIncidentMigrationDataSource({ ...endpoint, ...migrator }),
      run: runIncidentMigrations,
    },
    // The snapshot of each closed cycle: its own migrations table, after the cases it points to.
    {
      name: 'incident-workflow',
      version: INCIDENT_WORKFLOW_MIGRATION_VERSION,
      source: createIncidentWorkflowMigrationDataSource({ ...endpoint, ...migrator }),
      run: runIncidentWorkflowMigrations,
    },
    // The links to the workshop's orders and the costs of the case, in version order after the workflow.
    {
      name: 'incident-repairs',
      version: INCIDENT_REPAIRS_MIGRATION_VERSION,
      source: createIncidentRepairsMigrationDataSource({ ...endpoint, ...migrator }),
      run: runIncidentRepairsMigrations,
    },
    {
      name: 'incident-costs',
      version: INCIDENT_COSTS_MIGRATION_VERSION,
      source: createIncidentCostsMigrationDataSource({ ...endpoint, ...migrator }),
      run: runIncidentCostsMigrations,
    },
  ] as const;
}

/** Uninitialized incidents source; the caller initializes it so a failed startup closes it. */
export function createIncidentRuntimeSource(
  endpoint: Omit<IncidentDatabaseConfig, 'username' | 'password'>,
  account: Account,
) {
  return createIncidentDataSource({ ...endpoint, ...account });
}

export function incidentRuntimeAdapters(source: ReturnType<typeof createIncidentRuntimeSource>) {
  const incidents = new TypeOrmIncidentStore(source);
  // The children write through the incident store, so a case and its children share a transaction.
  return {
    incidents,
    incidentChildren: new TypeOrmIncidentChildStore(source, incidents),
    // The closure row joins the transaction of the case through the store's extra write.
    incidentClosures: new TypeOrmIncidentClosures(source),
    // Links and cost lines join the transaction of the case the same way.
    incidentRepairs: new TypeOrmIncidentRepairStore(source, incidents),
    incidentCosts: new TypeOrmIncidentCostStore(source, incidents),
  };
}
