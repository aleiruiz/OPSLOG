import {
  createIdentityDataSource,
  TypeOrmControlPlaneStore,
  TypeOrmIdentityStore,
} from '../../../../packages/persistence/identity/src/index.js';
import type { PiiCipher } from '../../../../packages/platform/pii/src/index.js';
import { hydrateAccessDirectory } from './control-plane/hydrate-access.js';
import { identityControlSchema } from './control-plane/identity-schema.js';
import { PersistentTenantSettings } from './control-plane/persistent-settings.js';
import { PersistentTenantStore } from './control-plane/persistent-tenant-store.js';
import { openFleetRuntimeStores } from './fleet-persistence.js';
import type { FleetAccountSet } from './mysql-provisioning.js';
import type { Platform } from './platform.js';
import type { PlatformAdapters } from './platform/types.js';

export interface MysqlPlatformOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly accounts: FleetAccountSet;
  /** Seals personal data (employees, incident parties); it must outlive restarts. */
  readonly pii: PiiCipher;
  /** Pooled connections per DataSource (default 2). */
  readonly connectionLimit?: number;
  readonly now?: () => Date;
}

export interface MysqlPlatform {
  /** Every persistent adapter of the platform; add object storage and other ports on top. */
  readonly adapters: PlatformAdapters;
  /** The one company of this deployment: reserved on first start, named by the bootstrap. */
  readonly tenantId: string;
  /** Rebuilds the access directory of a freshly created platform; call before serving requests. */
  hydrate(platform: Platform): Promise<number>;
  close(): Promise<void>;
}

/**
 * Opens the whole platform on MySQL with the restricted runtime accounts created by
 * `migrateFleetDatabase`: the fleet, files, maintenance, incident and audit stores, plus the
 * identity store and the durable control plane (tenant, memberships, sessions, settings). One
 * deployment serves one company, so the database is bound to its single tenant up front.
 */
export async function openMysqlPlatform(options: MysqlPlatformOptions): Promise<MysqlPlatform> {
  const endpoint = { host: options.host, port: options.port, database: options.database };
  const connectionLimit = options.connectionLimit ?? 2;
  const identitySource = createIdentityDataSource({
    ...endpoint,
    ...options.accounts.identity,
    connectionLimit,
    ...identityControlSchema,
  });
  let stores: Awaited<ReturnType<typeof openFleetRuntimeStores>> | undefined;
  try {
    await identitySource.initialize();
    const controlPlane = new TypeOrmControlPlaneStore(identitySource);
    const tenants = await PersistentTenantStore.open(controlPlane, options.now);
    const tenantSettings = await PersistentTenantSettings.open(controlPlane);
    stores = await openFleetRuntimeStores(
      { ...endpoint, accounts: options.accounts.runtime },
      { connectionLimit },
    );
    stores.bindTenant(tenants.tenantId);
    const identityStore = new TypeOrmIdentityStore(identitySource, {
      appendAudit: stores.appendIdentityAudit,
      ...(options.now ? { now: options.now } : {}),
    });
    const opened = stores;
    return {
      adapters: { ...opened.adapters, identityStore, tenants, tenantSettings, pii: options.pii },
      tenantId: tenants.tenantId,
      hydrate: (platform) => hydrateAccessDirectory(platform.access, tenants, identityStore),
      close: async () => {
        await opened.close();
        await identitySource.destroy();
      },
    };
  } catch (error) {
    await stores?.close();
    if (identitySource.isInitialized) await identitySource.destroy();
    throw error;
  }
}
