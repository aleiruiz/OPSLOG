import {
  createExportDataSource,
  createExportMigrationDataSource,
  EXPORT_MIGRATION_VERSION,
  runExportMigrations,
  TypeOrmExportJobStore,
  type ExportDatabaseConfig,
} from '../../../../packages/persistence/exports/src/index.js';

type Endpoint = Pick<ExportDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<ExportDatabaseConfig, 'username' | 'password'>;

/** Export jobs schema step: after the audit and outbox it writes events to. */
export function exportsMigrationSteps(endpoint: Endpoint, migrator: Account) {
  return [
    {
      name: 'exports',
      version: EXPORT_MIGRATION_VERSION,
      source: createExportMigrationDataSource({ ...endpoint, ...migrator }),
      run: runExportMigrations,
    },
  ] as const;
}

/** Uninitialized exports source; the caller initializes it so a failed startup closes it. */
export function createExportsRuntimeSource(
  endpoint: Omit<ExportDatabaseConfig, 'username' | 'password'>,
  account: Account,
) {
  return createExportDataSource({ ...endpoint, ...account });
}

/** The job store: it writes the event of a finished job to the tenant outbox with the status. */
export function exportsRuntimeAdapters(source: ReturnType<typeof createExportsRuntimeSource>) {
  return { exportJobs: new TypeOrmExportJobStore(source) };
}
