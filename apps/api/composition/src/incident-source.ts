import {
  createIncidentDataSource,
  createIncidentMigrationDataSource,
  runIncidentMigrations,
  TypeOrmIncidentStore,
  INCIDENT_MIGRATION_VERSION,
  type IncidentDatabaseConfig,
} from '../../../../packages/persistence/incidents/cases/src/index.js';

type Endpoint = Pick<IncidentDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<IncidentDatabaseConfig, 'username' | 'password'>;

/** Incident schema step; it runs after the maintenance steps and needs no module before it. */
export function incidentMigrationSteps(endpoint: Endpoint, migrator: Account) {
  return [
    {
      name: 'incident-cases',
      version: INCIDENT_MIGRATION_VERSION,
      source: createIncidentMigrationDataSource({ ...endpoint, ...migrator }),
      run: runIncidentMigrations,
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
  return { incidents: new TypeOrmIncidentStore(source) };
}
