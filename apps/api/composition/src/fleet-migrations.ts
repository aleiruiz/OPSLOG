import {
  createAreasMigrationDataSource,
  runAreasMigrations,
} from '../../../../packages/persistence/areas/src/index.js';
import {
  createVehiclesMigrationDataSource,
  runVehiclesMigrations,
} from '../../../../packages/persistence/vehicles/src/index.js';
import {
  createEmployeesMigrationDataSource,
  runEmployeesMigrations,
} from '../../../../packages/persistence/employees/src/index.js';
import {
  createDocumentsMigrationDataSource,
  runDocumentsMigrations,
} from '../../../../packages/persistence/documents/src/index.js';
import {
  createInsuranceMigrationDataSource,
  runInsuranceMigrations,
} from '../../../../packages/persistence/insurance/src/index.js';
import {
  createAssignmentsMigrationDataSource,
  runAssignmentsMigrations,
} from '../../../../packages/persistence/assignments/src/index.js';
import {
  createSettingsMigrationDataSource,
  runSettingsMigrations,
} from '../../../../packages/persistence/settings/src/index.js';
import {
  createImportsMigrationDataSource,
  runImportsMigrations,
} from '../../../../packages/persistence/imports/src/index.js';
import {
  createFilesMigrationDataSource,
  runFilesMigrations,
} from '../../../../packages/persistence/files/src/index.js';
import {
  createAuditMigrationDataSource,
  runAuditMigrations,
} from '../../../../packages/persistence/audit/src/index.js';
import { maintenanceMigrationSteps } from './maintenance-source.js';
import { incidentMigrationSteps } from './incident-source.js';
import { savedViewsMigrationSteps } from './saved-views-source.js';
import { searchMigrationSteps } from './search-source.js';

type FleetDataSource = ReturnType<typeof createAreasMigrationDataSource>;

export interface FleetDatabaseEndpoint {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

export interface FleetMigrationCredentials extends FleetDatabaseEndpoint {
  /** Schema-owning credentials. Use only from provisioning/test tooling, never from runtime stores. */
  readonly username: string;
  readonly password: string;
  readonly auditMigrator: { readonly username: string; readonly password: string };
  readonly filesMigrator: { readonly username: string; readonly password: string };
  readonly maintenanceMigrator: { readonly username: string; readonly password: string };
}

export interface FleetMigrationModule {
  readonly name: string;
  readonly version: string;
  readonly source: FleetDataSource;
  run(): Promise<void>;
}

const migrationModule = (
  name: string,
  version: string,
  source: FleetDataSource,
  run: (source: FleetDataSource) => Promise<void>,
): FleetMigrationModule => ({ name, version, source, run: () => run(source) });

/** One ordered migration registry for a tenant's composed M2 fleet database. */
export function createFleetMigrationModules(
  credentials: FleetMigrationCredentials,
): readonly FleetMigrationModule[] {
  const endpoint = {
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    username: credentials.username,
    password: credentials.password,
  };
  return [
    migrationModule(
      'vehicles',
      '2026101200020',
      createVehiclesMigrationDataSource(endpoint),
      runVehiclesMigrations,
    ),
    migrationModule(
      'areas',
      '2026100600040',
      createAreasMigrationDataSource(endpoint),
      runAreasMigrations,
    ),
    migrationModule(
      'employees',
      '2026100600050',
      createEmployeesMigrationDataSource(endpoint),
      runEmployeesMigrations,
    ),
    migrationModule(
      'documents',
      '2026100600060',
      createDocumentsMigrationDataSource(endpoint),
      runDocumentsMigrations,
    ),
    migrationModule(
      'insurance',
      '2026100600070',
      createInsuranceMigrationDataSource(endpoint),
      runInsuranceMigrations,
    ),
    migrationModule(
      'assignments',
      '2026100600080',
      createAssignmentsMigrationDataSource(endpoint),
      runAssignmentsMigrations,
    ),
    migrationModule(
      'settings',
      '2026100600090',
      createSettingsMigrationDataSource(endpoint),
      runSettingsMigrations,
    ),
    migrationModule(
      'imports',
      '2026100600090',
      createImportsMigrationDataSource(endpoint),
      runImportsMigrations,
    ),
    migrationModule(
      'files',
      '2026100700010',
      createFilesMigrationDataSource({
        host: credentials.host,
        port: credentials.port,
        database: credentials.database,
        username: credentials.filesMigrator.username,
        password: credentials.filesMigrator.password,
      }),
      runFilesMigrations,
    ),
    ...maintenanceMigrationSteps(
      { host: credentials.host, port: credentials.port, database: credentials.database },
      credentials.maintenanceMigrator,
    ).map((step) => migrationModule(step.name, step.version, step.source, step.run)),
    ...incidentMigrationSteps(
      { host: credentials.host, port: credentials.port, database: credentials.database },
      { username: credentials.username, password: credentials.password },
    ).map((step) => migrationModule(step.name, step.version, step.source, step.run)),
    // The search projection indexes the modules above and is derived from them.
    ...searchMigrationSteps(
      { host: credentials.host, port: credentials.port, database: credentials.database },
      { username: credentials.username, password: credentials.password },
    ).map((step) => migrationModule(step.name, step.version, step.source, step.run)),
    // Saved views and visible columns of the lists: no dependency on the modules.
    ...savedViewsMigrationSteps(
      { host: credentials.host, port: credentials.port, database: credentials.database },
      { username: credentials.username, password: credentials.password },
    ).map((step) => migrationModule(step.name, step.version, step.source, step.run)),
  ];
}

/** Provision schemas explicitly; API and worker runtime accounts never run DDL. */
export async function runFleetMigrations(
  credentials: FleetMigrationCredentials,
): Promise<readonly string[]> {
  const modules = createFleetMigrationModules(credentials);
  const initialized: FleetDataSource[] = [];
  try {
    for (const module of modules) {
      await module.source.initialize();
      initialized.push(module.source);
      await module.run();
      if (await module.source.showMigrations())
        throw new Error(`fleet migration remains pending: ${module.name}`);
    }
    return modules.map(({ name, version }) => `${name}:${version}`);
  } finally {
    await Promise.allSettled(initialized.map((source) => source.destroy()));
  }
}

/** Install the append-only audit tables/routine in the tenant-exclusive database. */
export async function runFleetAuditMigrations(
  credentials: FleetMigrationCredentials,
): Promise<void> {
  const source = createAuditMigrationDataSource({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    username: credentials.auditMigrator.username,
    password: credentials.auditMigrator.password,
  });
  try {
    await source.initialize();
    await runAuditMigrations(source);
    if (await source.showMigrations()) throw new Error('fleet audit migration remains pending');
  } finally {
    if (source.isInitialized) await source.destroy();
  }
}
