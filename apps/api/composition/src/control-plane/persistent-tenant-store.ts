import {
  opaqueTenantId,
  type Membership,
  type Session,
  type SessionId,
  type SubjectId,
  type Tenant,
  type TenantId,
  type TenantStatus,
} from '../../../../../packages/domain/tenants/src/index.js';
import type { TypeOrmControlPlaneStore } from '../../../../../packages/persistence/identity/src/index.js';
import { InMemoryTenantStore } from '../tenancy.js';

const TENANT_STATUSES: readonly TenantStatus[] = ['provisioning', 'active', 'suspended', 'failed'];
const MEMBERSHIP_STATUSES: readonly Membership['status'][] = ['pending', 'active', 'revoked'];

const tenantStatus = (value: string): TenantStatus => {
  const found = TENANT_STATUSES.find((status) => status === value);
  if (!found) throw new Error('stored tenant has an unknown status');
  return found;
};
const membershipStatus = (value: string): Membership['status'] => {
  const found = MEMBERSHIP_STATUSES.find((status) => status === value);
  if (!found) throw new Error('stored membership has an unknown status');
  return found;
};

/**
 * Control plane of a deployment that serves exactly one company (one database per tenant). It is
 * the in-memory store plus write-through persistence: tenants and memberships are cached for the
 * synchronous reads the platform needs (`status`, `all`) and rehydrated at start-up; sessions are
 * read from the database, so a signed-in browser survives a restart of the API.
 *
 * The tenant id is pinned the first time the store is opened (status `provisioning`) and never
 * changes, so the runtime stores can be bound to it before the platform exists. `provision` then
 * names and activates that tenant; it can run once, or again only after a failed attempt.
 */
export class PersistentTenantStore extends InMemoryTenantStore {
  private constructor(
    private readonly rows: TypeOrmControlPlaneStore,
    public readonly tenantId: TenantId,
    now: () => Date,
  ) {
    super(now);
  }

  /** Loads the stored control plane, reserving the tenant id on the very first start. */
  public static async open(
    rows: TypeOrmControlPlaneStore,
    now: () => Date = () => new Date(),
  ): Promise<PersistentTenantStore> {
    const stored = await rows.listTenants();
    if (stored.length > 1) throw new Error('control plane holds more than one company');
    let tenant = stored[0];
    if (!tenant) {
      tenant = { id: opaqueTenantId(), name: '', status: 'provisioning', createdAt: now() };
      await rows.insertTenant(tenant);
    }
    const store = new PersistentTenantStore(rows, tenant.id as TenantId, now);
    store.adoptTenant({
      id: tenant.id as TenantId,
      name: tenant.name,
      status: tenantStatus(tenant.status),
      createdAt: tenant.createdAt,
    });
    for (const membership of await rows.listMemberships())
      store.adoptMembership({
        tenantId: membership.tenantId as TenantId,
        subjectId: membership.subjectId as SubjectId,
        version: membership.version,
        status: membershipStatus(membership.status),
      });
    await rows.purgeSessions(now());
    return store;
  }

  /** Active memberships as projected in the control plane: what the access directory rebuilds from. */
  public activeMemberships(): readonly Membership[] {
    return [...this.memberships.values()].filter((membership) => membership.status === 'active');
  }

  /** Names and activates the pinned tenant. Refused once the company exists, unless a previous attempt failed. */
  public override async provision(name: string): Promise<Tenant> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 160) throw new Error('tenant name is required');
    const current = this.tenants.get(this.tenantId);
    if (!current || (current.status !== 'provisioning' && current.status !== 'failed'))
      throw new Error('this deployment already hosts its company');
    const tenant: Tenant = { ...current, name: trimmed, status: 'active' };
    await this.rows.updateTenant(tenant.id, { name: tenant.name, status: tenant.status });
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  /** Tenants are pinned and provisioned through `provision`; the synchronous in-memory path is closed. */
  public override provisionVerified(): Tenant {
    throw new Error('persistent tenants are provisioned with provision()');
  }

  public override async setTenantStatus(tenantId: TenantId, status: TenantStatus): Promise<void> {
    if (!this.tenants.has(tenantId)) throw new Error('unknown tenant');
    await this.rows.updateTenant(tenantId, { status });
    await super.setTenantStatus(tenantId, status);
  }

  public override async projectMembership(
    tenantId: TenantId,
    subjectId: SubjectId,
    version: number,
    status: Membership['status'],
  ): Promise<Membership> {
    const current = await this.getMembership(tenantId, subjectId);
    if (Number.isSafeInteger(version) && version >= 1 && (!current || current.version < version))
      await this.rows.upsertMembership({ tenantId, subjectId, version, status });
    return super.projectMembership(tenantId, subjectId, version, status);
  }

  public override async saveSession(session: Session): Promise<void> {
    await this.rows.upsertSession(session);
  }

  public override async getSession(id: SessionId): Promise<Session | undefined> {
    const row = await this.rows.findSession(id);
    return row
      ? {
          ...row,
          id: row.id as SessionId,
          tenantId: row.tenantId as TenantId,
          subjectId: row.subjectId as SubjectId,
        }
      : undefined;
  }
}
