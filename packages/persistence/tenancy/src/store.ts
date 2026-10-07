import {
  ProvisioningFailedError,
  sessionIdHash,
  type Membership,
  type ProvisioningJob,
  type Session,
  type SubjectId,
  type Tenant,
  type TenantDatabaseLocation,
  type TenantId,
  type TenantStatus,
  type SessionId,
} from '@opslog/domain-tenants';
import type { DataSource } from 'typeorm';
import {
  MembershipProjectionEntity,
  ProvisioningJobEntity,
  TenantDatabaseLocationEntity,
  TenantEntity,
  TenantSessionEntity,
} from './entities.js';
import type { TenantProvisioner, TenantStore } from './contracts.js';
import type { VerifiedTenantProvisioningAdapter } from './provisioning.js';
import { toJob, toLocation, toMembership, toSession, toTenant } from './row-mappers.js';
import { createAndProvision, type TenantStoreDeps } from './store-provisioning.js';
import { isDuplicateKey, isLockContention } from './store-helpers.js';

export class TypeOrmTenantStore implements TenantStore, TenantProvisioner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly leaseMs = 60_000,
    private readonly waitMs = 65_000,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Tenant control plane requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !/^opslog_control_[a-z0-9_]+$/i.test(username))
      throw new Error('Tenant control plane requires its restricted runtime account');
  }

  async getTenant(id: TenantId): Promise<Tenant | undefined> {
    const row = await this.dataSource.getRepository(TenantEntity).findOneBy({ id });
    return row ? toTenant(row) : undefined;
  }

  async getMembership(tenantId: TenantId, subject: SubjectId): Promise<Membership | undefined> {
    const row = await this.dataSource
      .getRepository(MembershipProjectionEntity)
      .findOneBy({ tenantId, subjectId: subject });
    return row ? toMembership(row) : undefined;
  }

  async getSession(id: SessionId): Promise<Session | undefined> {
    const row = await this.dataSource
      .getRepository(TenantSessionEntity)
      .findOneBy({ sessionIdHash: sessionIdHash(id) });
    return row ? toSession(row, id) : undefined;
  }

  async saveSession(session: Session): Promise<void> {
    const repository = this.dataSource.getRepository(TenantSessionEntity);
    await repository.upsert(
      {
        sessionIdHash: sessionIdHash(session.id),
        tenantId: session.tenantId,
        subjectId: session.subjectId,
        authorizationVersion: session.authorizationVersion,
        expiresAt: session.expiresAt,
        revoked: session.revoked,
      },
      ['sessionIdHash'],
    );
  }

  async setTenantStatus(tenantId: TenantId, status: TenantStatus): Promise<void> {
    if (status === 'active' && !(await this.getLocation(tenantId)))
      throw new ProvisioningFailedError();
    await this.dataSource.getRepository(TenantEntity).update({ id: tenantId }, { status });
  }

  async getLocation(id: TenantId): Promise<TenantDatabaseLocation | undefined> {
    const row = await this.dataSource
      .getRepository(TenantDatabaseLocationEntity)
      .findOneBy({ tenantId: id });
    if (
      !row?.migrationVersion ||
      !row.runtimeRoleVerified ||
      !row.isolationProbeVerified ||
      !row.verifiedAt
    )
      return undefined;
    return toLocation(row);
  }

  async getJob(tenantId: TenantId, idempotencyKey: string): Promise<ProvisioningJob | undefined> {
    const row = await this.dataSource
      .getRepository(ProvisioningJobEntity)
      .findOneBy({ idempotencyKey, tenantId });
    return row ? toJob(row) : undefined;
  }

  async projectMembership(
    tenantId: TenantId,
    subjectId: SubjectId,
    version: number,
    status: Membership['status'],
  ): Promise<Membership> {
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('membership version must be positive');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const memberships = manager.getRepository(MembershipProjectionEntity);
          const current = await memberships.findOne({
            where: { tenantId, subjectId },
            lock: { mode: 'pessimistic_write' },
          });
          if (current && current.version >= version) return toMembership(current);
          if (current) {
            await memberships.update(
              { tenantId, subjectId, version: current.version },
              { version, status },
            );
          } else {
            await memberships.insert({ tenantId, subjectId, version, status });
          }
          return { tenantId, subjectId, version, status };
        });
      } catch (error) {
        if (!(isDuplicateKey(error) || isLockContention(error)) || attempt === 2) throw error;
      }
    }
    throw new Error('membership projection retry exhausted');
  }

  createAndProvision(
    request: { readonly name: string },
    idempotencyKey: string,
    adapter: VerifiedTenantProvisioningAdapter,
  ): Promise<Tenant> {
    const deps: TenantStoreDeps = {
      dataSource: this.dataSource,
      leaseMs: this.leaseMs,
      waitMs: this.waitMs,
      getTenant: (id) => this.getTenant(id),
    };
    return createAndProvision(deps, request, idempotencyKey, adapter);
  }
}
