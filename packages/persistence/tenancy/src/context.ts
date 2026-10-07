import {
  immutableContext,
  opaqueId,
  TenantAccessDeniedError,
  type SessionId,
  type TenantContext,
} from '@opslog/domain-tenants';
import type { DataSource, Repository } from 'typeorm';
import { TENANT_DATABASE_MIGRATION_VERSION } from './migrations.js';
import { TenantDataRecordEntity } from './entities.js';
import { markTrustedContext } from './trusted-context.js';
import type { TenantStore } from './contracts.js';

export class TenantContextResolver {
  constructor(private readonly store: TenantStore) {}

  async resolve(request: { readonly sessionId: SessionId }): Promise<TenantContext> {
    const session = await this.store.getSession(request.sessionId);
    if (!session || session.revoked || session.expiresAt.getTime() <= Date.now())
      throw new TenantAccessDeniedError();
    const [tenant, membership, database] = await Promise.all([
      this.store.getTenant(session.tenantId),
      this.store.getMembership(session.tenantId, session.subjectId),
      this.store.getLocation(session.tenantId),
    ]);
    if (
      !tenant ||
      tenant.status !== 'active' ||
      !membership ||
      membership.status !== 'active' ||
      session.authorizationVersion !== membership.version ||
      !database ||
      database.tenantId !== session.tenantId ||
      !database.runtimeRoleVerified ||
      !database.isolationProbeVerified ||
      database.migrationVersion !== TENANT_DATABASE_MIGRATION_VERSION
    )
      throw new TenantAccessDeniedError();
    return markTrustedContext(
      immutableContext({
        tenantId: session.tenantId,
        actor: { subjectId: session.subjectId, membershipVersion: membership.version },
        authorizationVersion: membership.version,
        correlationId: opaqueId() as TenantContext['correlationId'],
        database,
      }),
    );
  }
}

export class TenantScopedRepository {
  constructor(
    private readonly context: TenantContext,
    private readonly repository: Repository<TenantDataRecordEntity>,
  ) {}

  findById(id: string): Promise<TenantDataRecordEntity | null> {
    return this.repository.findOneBy({ id, tenantId: this.context.tenantId });
  }

  findAll(): Promise<TenantDataRecordEntity[]> {
    return this.repository.findBy({ tenantId: this.context.tenantId });
  }

  async insert(record: { readonly id: string; readonly value: string }): Promise<void> {
    await this.repository.insert({ ...record, tenantId: this.context.tenantId, version: 1 });
  }
}

export function tenantScopedRepository(
  context: TenantContext,
  dataSource: DataSource,
): TenantScopedRepository {
  if (dataSource.options.database !== context.database.databaseName)
    throw new TenantAccessDeniedError();
  return new TenantScopedRepository(context, dataSource.getRepository(TenantDataRecordEntity));
}
