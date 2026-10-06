import {
  opaqueTenantId,
  type Membership,
  type ProvisioningJob,
  type Session,
  type SessionId,
  type SubjectId,
  type Tenant,
  type TenantDatabaseLocation,
  type TenantId,
  type TenantStatus,
} from '../../../../packages/domain/tenants/src/index.js';
import {
  TENANT_DATABASE_MIGRATION_VERSION,
  type TenantStore,
} from '../../../../packages/persistence/tenancy/src/index.js';
import type { TenantDirectory } from '../../../worker/composition/src/index.js';

const pair = (tenantId: string, subject: string): string =>
  `${tenantId.length}:${tenantId}${subject.length}:${subject}`;

/**
 * In-memory control-plane adapter that mirrors the `TenantStore` port (including the monotonic
 * membership projection and the "active needs a verified location" rule of the TypeORM adapter).
 * It is a test/staging double: the durable adapter is `TypeOrmTenantStore`.
 */
export class InMemoryTenantStore implements TenantStore, TenantDirectory {
  private readonly tenants = new Map<string, Tenant>();
  private readonly locations = new Map<string, TenantDatabaseLocation>();
  private readonly memberships = new Map<string, Membership>();
  private readonly sessions = new Map<string, Session>();
  private databases = 0;
  public constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Mirrors the outcome of a successful provisioning run: an active tenant with a verified
   * location. Provisioning itself (databases, credentials) is covered by the tenancy package.
   */
  public provisionVerified(name: string): Tenant {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 160) throw new Error('tenant name is required');
    const tenant: Tenant = {
      id: opaqueTenantId(),
      name: trimmed,
      status: 'active',
      createdAt: this.now(),
    };
    this.databases += 1;
    this.tenants.set(tenant.id, tenant);
    this.locations.set(tenant.id, {
      tenantId: tenant.id,
      databaseName: `opslog_t_synthetic_${this.databases}`,
      credentialRef: 'ref:in-memory',
      secretVersion: 1,
      migrationVersion: TENANT_DATABASE_MIGRATION_VERSION,
      runtimeRoleVerified: true,
      isolationProbeVerified: true,
      verifiedAt: this.now(),
    });
    return tenant;
  }

  public async getTenant(id: TenantId): Promise<Tenant | undefined> {
    return this.tenants.get(id);
  }
  public async getMembership(
    tenantId: TenantId,
    subject: SubjectId,
  ): Promise<Membership | undefined> {
    return this.memberships.get(pair(tenantId, subject));
  }
  public async getSession(id: SessionId): Promise<Session | undefined> {
    return this.sessions.get(id);
  }
  public async getLocation(id: TenantId): Promise<TenantDatabaseLocation | undefined> {
    return this.locations.get(id);
  }
  public async getJob(): Promise<ProvisioningJob | undefined> {
    return undefined;
  }
  /** Monotonic: a version that is not newer than the stored one is ignored, as in the durable adapter. */
  public async projectMembership(
    tenantId: TenantId,
    subjectId: SubjectId,
    version: number,
    status: Membership['status'],
  ): Promise<Membership> {
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('membership version must be positive');
    const key = pair(tenantId, subjectId);
    const current = this.memberships.get(key);
    if (current && current.version >= version) return current;
    const next: Membership = { tenantId, subjectId, version, status };
    this.memberships.set(key, next);
    return next;
  }
  public async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  public async setTenantStatus(tenantId: TenantId, status: TenantStatus): Promise<void> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new Error('unknown tenant');
    if (status === 'active' && !this.locations.has(tenantId))
      throw new Error('active tenants need a verified location');
    this.tenants.set(tenantId, { ...tenant, status });
  }

  /** Every tenant known to the store, in any status (operator/diagnostic view). */
  public all(): readonly Tenant[] {
    return [...this.tenants.values()];
  }

  /** Worker view: anything that is not an active tenant is rejected before a handler runs. */
  public status(tenantId: string): 'active' | 'suspended' | 'missing' {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return 'missing';
    return tenant.status === 'active' ? 'active' : 'suspended';
  }
}
