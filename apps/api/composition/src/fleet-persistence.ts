import {
  createAreasDataSource,
  createAreasMigrationDataSource,
  runAreasMigrations,
  TypeOrmAreaStore,
} from '../../../../packages/persistence/areas/src/index.js';
import {
  createVehiclesDataSource,
  createVehiclesMigrationDataSource,
  runVehiclesMigrations,
  TypeOrmVehicleStore,
} from '../../../../packages/persistence/vehicles/src/index.js';
import {
  createEmployeesDataSource,
  createEmployeesMigrationDataSource,
  runEmployeesMigrations,
  TypeOrmEmployeeStore,
} from '../../../../packages/persistence/employees/src/index.js';
import {
  createDocumentsDataSource,
  createDocumentsMigrationDataSource,
  runDocumentsMigrations,
  TypeOrmDocumentStore,
} from '../../../../packages/persistence/documents/src/index.js';
import {
  createInsuranceDataSource,
  createInsuranceMigrationDataSource,
  runInsuranceMigrations,
  TypeOrmPolicyStore,
} from '../../../../packages/persistence/insurance/src/index.js';
import {
  createAssignmentsDataSource,
  createAssignmentsMigrationDataSource,
  runAssignmentsMigrations,
  TypeOrmAssignmentStore,
} from '../../../../packages/persistence/assignments/src/index.js';
import {
  createSettingsDataSource,
  createSettingsMigrationDataSource,
  runSettingsMigrations,
  TypeOrmSettingsStore,
} from '../../../../packages/persistence/settings/src/index.js';
import {
  createImportsDataSource,
  createImportsMigrationDataSource,
  runImportsMigrations,
  TypeOrmImportStore,
} from '../../../../packages/persistence/imports/src/index.js';
import type { PlatformAdapters } from './platform/types.js';

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
}

export interface FleetRuntimeCredentials extends FleetDatabaseEndpoint {
  readonly accounts: {
    readonly areas: { readonly username: string; readonly password: string };
    readonly vehicles: { readonly username: string; readonly password: string };
    readonly employees: { readonly username: string; readonly password: string };
    readonly documents: { readonly username: string; readonly password: string };
    readonly insurance: { readonly username: string; readonly password: string };
    readonly assignments: { readonly username: string; readonly password: string };
    readonly settings: { readonly username: string; readonly password: string };
    readonly imports: { readonly username: string; readonly password: string };
  };
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
      '2026100600030',
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

export interface FleetRuntimeStores {
  readonly adapters: Required<
    Pick<
      PlatformAdapters,
      | 'areas'
      | 'vehicles'
      | 'employees'
      | 'documents'
      | 'insurance'
      | 'assignments'
      | 'settings'
      | 'imports'
    >
  >;
  close(): Promise<void>;
}

/** Open module-owned runtime accounts against one tenant database; no credential can perform DDL. */
export async function openFleetRuntimeStores(
  credentials: FleetRuntimeCredentials,
): Promise<FleetRuntimeStores> {
  const endpoint = {
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    connectionLimit: 4,
  };
  const sources = [
    createAreasDataSource({ ...endpoint, ...credentials.accounts.areas }),
    createVehiclesDataSource({ ...endpoint, ...credentials.accounts.vehicles }),
    createEmployeesDataSource({ ...endpoint, ...credentials.accounts.employees }),
    createDocumentsDataSource({ ...endpoint, ...credentials.accounts.documents }),
    createInsuranceDataSource({ ...endpoint, ...credentials.accounts.insurance }),
    createAssignmentsDataSource({ ...endpoint, ...credentials.accounts.assignments }),
    createSettingsDataSource({ ...endpoint, ...credentials.accounts.settings }),
    createImportsDataSource({ ...endpoint, ...credentials.accounts.imports }),
  ];
  const initialized: FleetDataSource[] = [];
  try {
    for (const source of sources) {
      await source.initialize();
      initialized.push(source);
    }
    return {
      adapters: {
        areas: new TypeOrmAreaStore(sources[0] as FleetDataSource),
        vehicles: new TypeOrmVehicleStore(sources[1] as FleetDataSource),
        employees: new TypeOrmEmployeeStore(sources[2] as FleetDataSource),
        documents: new TypeOrmDocumentStore(sources[3] as FleetDataSource),
        insurance: new TypeOrmPolicyStore(sources[4] as FleetDataSource),
        assignments: new TypeOrmAssignmentStore(sources[5] as FleetDataSource),
        settings: new TypeOrmSettingsStore(sources[6] as FleetDataSource),
        imports: new TypeOrmImportStore(sources[7] as FleetDataSource),
      },
      close: async () => {
        await Promise.allSettled(initialized.map((source) => source.destroy()));
      },
    };
  } catch (error) {
    await Promise.allSettled(initialized.map((source) => source.destroy()));
    throw error;
  }
}
