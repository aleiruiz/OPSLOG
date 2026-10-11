import { MySqlAuditApiStore, MySqlAuditRelay } from './store.js';
import { appendLocalAuditAndDelivery, type TenantAuditDataSourceResolver } from './store.js';
import type { EntityManager } from 'typeorm';
import { AUDIT_ENTITIES } from './entities.js';
import { CreateAuditStore2026100700010, CreateTenantOutbox2026100900010 } from './migrations.js';
import { MySqlTenantOutboxStore } from './outbox-store.js';

export interface IdentityMutationAuditRecord {
  readonly eventId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: string;
  readonly actor: { readonly id: string; readonly kind: 'user' | 'system' };
  readonly correlationId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface MySqlAuditRuntimeOptions {
  /** Trusted control-plane enumeration; never accepts tenant IDs from an API request. */
  readonly listTenantIds: () => readonly string[] | Promise<readonly string[]>;
  /** Runtime account resolver for one tenant's exclusive database. */
  readonly resolveRuntime: TenantAuditDataSourceResolver;
  /** Relay account resolver for that same tenant database. */
  readonly resolveRelay: TenantAuditDataSourceResolver;
  /** Optional restricted reader; defaults to the runtime account resolver. */
  readonly resolveReader?: TenantAuditDataSourceResolver;
}

/** Builds the API store and worker relay over explicit, tenant-exclusive datasource resolvers. */
export function createMySqlAuditRuntime(options: MySqlAuditRuntimeOptions) {
  const appendIdentityAudit = (manager: EntityManager, event: IdentityMutationAuditRecord) =>
    appendLocalAuditAndDelivery(manager, { ...event, data: {} }).then(() => undefined);
  return {
    audit: new MySqlAuditApiStore(options.resolveRuntime, options.resolveReader),
    auditRelay: new MySqlAuditRelay(options.listTenantIds, options.resolveRelay),
    outbox: new MySqlTenantOutboxStore(
      options.listTenantIds,
      options.resolveRuntime,
      options.resolveRelay,
    ),
    /** Pass to TypeOrmIdentityStoreOptions.appendAudit to share the identity transaction. */
    appendIdentityAudit,
    /** Spread into createIdentityDataSource/createIdentityMigrationDataSource for same-DB tables. */
    identitySchema: {
      additionalEntities: AUDIT_ENTITIES,
      additionalMigrations: [CreateAuditStore2026100700010, CreateTenantOutbox2026100900010],
    },
  } as const;
}
