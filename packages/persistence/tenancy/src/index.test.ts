import { describe, expect, it } from 'vitest';
import {
  type Membership,
  type Session,
  type SubjectId,
  type Tenant,
  type TenantDatabaseLocation,
  type TenantId,
  type SessionId,
  opaqueTenantId,
  subjectId,
} from '@opslog/domain-tenants';
import { TenantAccessDeniedError } from '@opslog/domain-tenants';
import {
  TenantContextResolver,
  TenantDataSourceFactory,
  createControlPlaneDataSource,
  type TenantCredentialResolver,
  type TenantStore,
} from './index.js';

// Test-only UUIDv7 identities are generated at runtime; they are not credentials or external resources.
const tenantId = opaqueTenantId();
const actorId = subjectId('synthetic-subject');
const location: TenantDatabaseLocation = {
  tenantId,
  databaseName: 'opslog_t_019b5b3343a07eaa9e58319c8d8ec321',
  credentialRef: `tenant/${tenantId}/runtime`,
  secretVersion: 1,
  migrationVersion: '2026100400020',
  runtimeRoleVerified: true,
  isolationProbeVerified: true,
  verifiedAt: new Date(),
};

class TestTenantStore implements TenantStore {
  constructor(
    private tenant: Tenant,
    private membership: Membership,
    private session: Session,
    private readonly dbLocation: TenantDatabaseLocation,
  ) {}
  async getTenant(id: TenantId): Promise<Tenant | undefined> {
    return id === this.tenant.id ? this.tenant : undefined;
  }
  async getMembership(id: TenantId, subject: SubjectId): Promise<Membership | undefined> {
    return id === this.membership.tenantId && subject === this.membership.subjectId
      ? this.membership
      : undefined;
  }
  async getSession(id: SessionId): Promise<Session | undefined> {
    return id === this.session.id ? this.session : undefined;
  }
  async getLocation(id: TenantId): Promise<TenantDatabaseLocation | undefined> {
    return id === this.dbLocation.tenantId ? this.dbLocation : undefined;
  }
  async getJob(): Promise<undefined> {
    return undefined;
  }
  async projectMembership(
    _id: TenantId,
    _subject: SubjectId,
    _version: number,
    _status: Membership['status'],
  ): Promise<Membership> {
    throw new Error('not implemented in unit fixture');
  }
  async saveSession(_session: Session): Promise<void> {
    throw new Error('not implemented in unit fixture');
  }
  async setTenantStatus(_tenantId: TenantId, _status: Tenant['status']): Promise<void> {
    throw new Error('not implemented in unit fixture');
  }
}

function fixture(
  status: Tenant['status'] = 'active',
  membershipStatus: Membership['status'] = 'active',
) {
  const tenant: Tenant = {
    id: tenantId,
    name: 'Synthetic tenant',
    status,
    authorizationVersion: 4,
    createdAt: new Date(),
  };
  const membership: Membership = {
    tenantId,
    subjectId: actorId,
    status: membershipStatus,
    version: 7,
  };
  const session: Session = {
    id: 'synthetic-session' as SessionId,
    tenantId,
    subjectId: actorId,
    authorizationVersion: 4,
    expiresAt: new Date(Date.now() + 60_000),
    revoked: false,
  };
  const store = new TestTenantStore(tenant, membership, session, location);
  return { tenant, membership, session, resolver: new TenantContextResolver(store) };
}

describe('trusted tenant context and data source selection', () => {
  it('resolves tenant solely from central session, membership and directory state', async () => {
    const { resolver, session } = fixture();
    const attackedRequest = {
      sessionId: session.id,
      headers: { 'x-tenant-id': opaqueTenantId() },
      body: { tenantId: opaqueTenantId() },
      query: { tenantId: opaqueTenantId() },
    };
    const context = await resolver.resolve(attackedRequest);
    expect(context.tenantId).toBe(tenantId);
    expect(context.database.databaseName).toBe(location.databaseName);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.database)).toBe(true);
  });

  it('denies missing, suspended, revoked and expired sessions uniformly', async () => {
    const suspended = fixture('suspended');
    const revoked = fixture('active', 'revoked');
    await expect(
      suspended.resolver.resolve({ sessionId: suspended.session.id }),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);
    await expect(
      revoked.resolver.resolve({ sessionId: revoked.session.id }),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);
    const expired = fixture();
    const store = new TestTenantStore(
      expired.tenant,
      expired.membership,
      { ...expired.session, expiresAt: new Date(0) },
      location,
    );
    await expect(
      new TenantContextResolver(store).resolve({ sessionId: expired.session.id }),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);
  });

  it('creates a MySQL data source only for the verified directory location and resolved credential', async () => {
    const { resolver, session } = fixture();
    const context = await resolver.resolve({ sessionId: session.id });
    const credentialResolver: TenantCredentialResolver = {
      async resolve(ref, version) {
        expect(ref).toBe(location.credentialRef);
        return {
          tenantId,
          databaseName: location.databaseName,
          username: 'opslog_u_synthetic',
          password: 'synthetic-test-only',
          secretVersion: version,
        };
      },
    };
    const source = await new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      credentialResolver,
    ).create(context);
    expect(source.options.database).toBe(location.databaseName);
    expect(source.options).toMatchObject({
      username: 'opslog_u_synthetic',
      synchronize: false,
      password: 'synthetic-test-only',
    });
  });

  it('refuses an unverified directory entry before credential resolution', async () => {
    const { tenant, membership, session } = fixture();
    const incomplete = { ...location, isolationProbeVerified: false };
    const resolver = new TenantContextResolver(
      new TestTenantStore(tenant, membership, session, incomplete),
    );
    await expect(resolver.resolve({ sessionId: session.id })).rejects.toBeInstanceOf(
      TenantAccessDeniedError,
    );
  });

  it('rejects master accounts for the runtime control-plane data source', () => {
    expect(() =>
      createControlPlaneDataSource({
        host: '127.0.0.1',
        port: 3306,
        database: 'opslog_control_test',
        username: 'root',
        password: 'synthetic-test-only',
      }),
    ).toThrow('restricted runtime account');
  });
});
