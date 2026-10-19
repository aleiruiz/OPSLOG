import {
  createAreasDataSource,
  TypeOrmAreaStore,
} from '../../../../packages/persistence/areas/src/index.js';
import {
  createVehiclesDataSource,
  TypeOrmVehicleStore,
} from '../../../../packages/persistence/vehicles/src/index.js';
import {
  createEmployeesDataSource,
  TypeOrmEmployeeStore,
} from '../../../../packages/persistence/employees/src/index.js';
import {
  createDocumentsDataSource,
  TypeOrmDocumentStore,
} from '../../../../packages/persistence/documents/src/index.js';
import {
  createInsuranceDataSource,
  TypeOrmPolicyStore,
} from '../../../../packages/persistence/insurance/src/index.js';
import {
  createAssignmentsDataSource,
  TypeOrmAssignmentStore,
} from '../../../../packages/persistence/assignments/src/index.js';
import {
  createSettingsDataSource,
  TypeOrmSettingsStore,
} from '../../../../packages/persistence/settings/src/index.js';
import {
  createImportsDataSource,
  TypeOrmImportStore,
} from '../../../../packages/persistence/imports/src/index.js';
import {
  createFilesDataSource,
  TypeOrmFileSagaStore,
} from '../../../../packages/persistence/files/src/index.js';
import {
  createAuditRelayDataSource,
  createAuditRuntimeDataSource,
  createMySqlAuditRuntime,
} from '../../../../packages/persistence/audit/src/index.js';
import type { PlatformAdapters } from './platform/types.js';
import {
  createMaintenanceRuntimeSources,
  maintenanceRuntimeAdapters,
} from './maintenance-source.js';
import { createIncidentRuntimeSource, incidentRuntimeAdapters } from './incident-source.js';
import { createSavedViewsRuntimeSource, savedViewsRuntimeAdapters } from './saved-views-source.js';
import { createSearchRuntimeSource, searchRuntimeAdapters } from './search-source.js';
import type { FleetDatabaseEndpoint } from './fleet-migrations.js';

export * from './fleet-migrations.js';

type FleetDataSource = ReturnType<typeof createAreasDataSource>;

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
    readonly files: { readonly username: string; readonly password: string };
    readonly maintenance: { readonly username: string; readonly password: string };
    readonly incidents: { readonly username: string; readonly password: string };
    readonly search: { readonly username: string; readonly password: string };
    readonly views: { readonly username: string; readonly password: string };
    readonly auditRuntime: { readonly username: string; readonly password: string };
    readonly auditRelay: { readonly username: string; readonly password: string };
  };
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
      | 'records'
      | 'scanQueue'
      | 'fileSagaJournal'
      | 'audit'
      | 'auditRelay'
      | 'outbox'
      | 'maintenancePlans'
      | 'maintenanceWorkshops'
      | 'maintenanceMechanics'
      | 'maintenanceOrders'
      | 'incidents'
      | 'search'
      | 'savedViews'
    >
  >;
  readonly audit: NonNullable<PlatformAdapters['audit']>;
  readonly auditRelay: NonNullable<PlatformAdapters['auditRelay']>;
  readonly outbox: NonNullable<PlatformAdapters['outbox']>;
  /** Tenant-local audit writer for a persistent identity store sharing this database. */
  readonly appendIdentityAudit: ReturnType<typeof createMySqlAuditRuntime>['appendIdentityAudit'];
  /** Bind this runtime to the tenant provisioned by its isolated BFF world. */
  bindTenant(tenantId: string): void;
  close(): Promise<void>;
}

export function withFleetAuditRuntime<T extends object>(
  adapters: T,
  auditRuntime: ReturnType<typeof createMySqlAuditRuntime>,
): T & Pick<PlatformAdapters, 'audit' | 'auditRelay' | 'outbox'> {
  const composed = Object.create(
    Object.getPrototypeOf(adapters),
    Object.getOwnPropertyDescriptors(adapters),
  ) as T & Pick<PlatformAdapters, 'audit' | 'auditRelay' | 'outbox'>;
  Object.defineProperties(composed, {
    audit: { value: auditRuntime.audit, enumerable: true, configurable: true },
    auditRelay: { value: auditRuntime.auditRelay, enumerable: true, configurable: true },
    outbox: { value: auditRuntime.outbox, enumerable: true, configurable: true },
  });
  return composed;
}

export interface FleetRuntimeOptions {
  /** Pooled connections per DataSource (default 4; a small server uses fewer). */
  readonly connectionLimit?: number;
}

export async function openFleetRuntimeStores(
  credentials: FleetRuntimeCredentials,
  options: FleetRuntimeOptions = {},
): Promise<FleetRuntimeStores> {
  const endpoint = {
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    connectionLimit: options.connectionLimit ?? 4,
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
  const auditRuntimeSource = createAuditRuntimeDataSource({
    ...endpoint,
    ...credentials.accounts.auditRuntime,
  });
  const auditRelaySource = createAuditRelayDataSource({
    ...endpoint,
    ...credentials.accounts.auditRelay,
  });
  const filesSource = createFilesDataSource({
    ...endpoint,
    ...credentials.accounts.files,
  });
  const maintenance = createMaintenanceRuntimeSources(endpoint, credentials.accounts.maintenance);
  const incidentSource = createIncidentRuntimeSource(endpoint, credentials.accounts.incidents);
  const searchSource = createSearchRuntimeSource(endpoint, credentials.accounts.search);
  const viewsSource = createSavedViewsRuntimeSource(endpoint, credentials.accounts.views);
  sources.push(maintenance.plans, maintenance.orders, incidentSource, searchSource, viewsSource);
  const initialized: FleetDataSource[] = [];
  let auditRuntimeInitialized = false;
  let auditRelayInitialized = false;
  let filesInitialized = false;
  const closeSources = async () => {
    await Promise.allSettled([
      ...initialized.map((source) => source.destroy()),
      ...(auditRuntimeInitialized ? [auditRuntimeSource.destroy()] : []),
      ...(auditRelayInitialized ? [auditRelaySource.destroy()] : []),
      ...(filesInitialized ? [filesSource.destroy()] : []),
    ]);
  };
  try {
    for (const source of sources) {
      await source.initialize();
      initialized.push(source);
    }
    await auditRuntimeSource.initialize();
    auditRuntimeInitialized = true;
    await auditRelaySource.initialize();
    auditRelayInitialized = true;
    await filesSource.initialize();
    filesInitialized = true;
    let boundTenantId: string | undefined;
    let fileStore: TypeOrmFileSagaStore | undefined;
    const resolveTenantSource = (tenantId: string) => {
      if (!boundTenantId || tenantId !== boundTenantId)
        throw new Error('audit resolver tenant mismatch');
      return auditRuntimeSource;
    };
    const auditRuntime = createMySqlAuditRuntime({
      listTenantIds: () => (boundTenantId ? [boundTenantId] : []),
      resolveRuntime: resolveTenantSource,
      resolveReader: resolveTenantSource,
      resolveRelay: (tenantId) => {
        if (!boundTenantId || tenantId !== boundTenantId)
          throw new Error('audit relay tenant mismatch');
        return auditRelaySource;
      },
    });
    const adapters = withFleetAuditRuntime(
      {
        areas: new TypeOrmAreaStore(sources[0] as FleetDataSource),
        vehicles: new TypeOrmVehicleStore(sources[1] as FleetDataSource),
        employees: new TypeOrmEmployeeStore(sources[2] as FleetDataSource),
        documents: new TypeOrmDocumentStore(sources[3] as FleetDataSource),
        insurance: new TypeOrmPolicyStore(sources[4] as FleetDataSource),
        assignments: new TypeOrmAssignmentStore(sources[5] as FleetDataSource),
        settings: new TypeOrmSettingsStore(sources[6] as FleetDataSource),
        imports: new TypeOrmImportStore(sources[7] as FleetDataSource),
        ...maintenanceRuntimeAdapters(maintenance),
        ...incidentRuntimeAdapters(incidentSource),
        ...searchRuntimeAdapters(searchSource),
        ...savedViewsRuntimeAdapters(viewsSource),
        get records() {
          if (!fileStore) throw new Error('fleet file runtime must be bound to a tenant first');
          return fileStore;
        },
        get scanQueue() {
          if (!fileStore) throw new Error('fleet file runtime must be bound to a tenant first');
          return fileStore;
        },
        get fileSagaJournal() {
          if (!fileStore) throw new Error('fleet file runtime must be bound to a tenant first');
          return fileStore;
        },
      },
      auditRuntime,
    ) as FleetRuntimeStores['adapters'];
    return {
      adapters,
      audit: auditRuntime.audit,
      auditRelay: auditRuntime.auditRelay,
      outbox: auditRuntime.outbox,
      appendIdentityAudit: auditRuntime.appendIdentityAudit,
      bindTenant(tenantId) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tenantId))
          throw new Error('invalid fleet tenant id');
        if (boundTenantId && boundTenantId !== tenantId)
          throw new Error('fleet audit runtime already bound to another tenant');
        boundTenantId = tenantId;
        fileStore ??= new TypeOrmFileSagaStore(filesSource, tenantId);
      },
      close: closeSources,
    };
  } catch (error) {
    await closeSources();
    throw error;
  }
}
