import { describe, expect, it } from 'vitest';
import { DataSource, type DataSourceOptions } from 'typeorm';
import {
  type Membership,
  type Session,
  type SubjectId,
  type Tenant,
  type TenantDatabaseLocation,
  type TenantContext,
  type TenantId,
  type SessionId,
  opaqueTenantId,
  subjectId,
} from '@opslog/domain-tenants';
import { TenantAccessDeniedError } from '@opslog/domain-tenants';
import { trustContextForTests } from './testing.js';
import {
  TenantContextResolver,
  TenantDataSourceCapacityError,
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
  databaseName: `opslog_t_${tenantId.replaceAll('-', '')}`,
  credentialRef: `tenant/${tenantId}/runtime`,
  secretVersion: 1,
  migrationVersion: '2026100400020',
  runtimeRoleVerified: true,
  isolationProbeVerified: true,
  verifiedAt: new Date(),
};

function fakeDataSource(options: DataSourceOptions): DataSource {
  let initialized = false;
  const fake = {
    options,
    get isInitialized() {
      return initialized;
    },
    async initialize() {
      initialized = true;
      return fake;
    },
    async destroy() {
      initialized = false;
    },
  } as unknown as DataSource;
  return fake;
}

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
    authorizationVersion: 7,
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

  it('denies a session issued under an older membership version', async () => {
    const { tenant, membership, session } = fixture();
    const resolver = new TenantContextResolver(
      new TestTenantStore(
        tenant,
        { ...membership, version: membership.version + 1 },
        session,
        location,
      ),
    );
    await expect(resolver.resolve({ sessionId: session.id })).rejects.toBeInstanceOf(
      TenantAccessDeniedError,
    );
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
    const created: DataSource[] = [];
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      credentialResolver,
      { maxConnectionsPerDataSource: 2 },
      (options) => {
        const source = fakeDataSource(options);
        created.push(source);
        return source;
      },
    );
    const lease = await factory.acquire(context);
    const source = lease.dataSource;
    expect(source.options.database).toBe(location.databaseName);
    expect(source.options).toMatchObject({
      username: 'opslog_u_synthetic',
      synchronize: false,
      password: 'synthetic-test-only',
      extra: { connectionLimit: 2 },
    });
    expect(source.isInitialized).toBe(true);
    expect(created).toHaveLength(1);
    await lease.release();
    await factory.close();
    expect(source.isInitialized).toBe(false);
  });

  it('shares one data source for simultaneous cold acquires of the same tenant version', async () => {
    const { resolver, session } = fixture();
    const context = await resolver.resolve({ sessionId: session.id });
    let resolveCount = 0;
    let releaseResolvers!: () => void;
    const bothResolversStarted = new Promise<void>((resolve) => {
      releaseResolvers = resolve;
    });
    const created: DataSource[] = [];
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      {
        async resolve(_ref, version) {
          resolveCount += 1;
          if (resolveCount === 2) releaseResolvers();
          await bothResolversStarted;
          return {
            tenantId,
            databaseName: location.databaseName,
            username: 'opslog_u_synthetic',
            password: 'synthetic-test-only',
            secretVersion: version,
          };
        },
      },
      { maxDataSources: 1 },
      (options) => {
        const source = fakeDataSource(options);
        created.push(source);
        return source;
      },
    );

    const [first, second] = await Promise.all([factory.acquire(context), factory.acquire(context)]);
    expect(first.dataSource).toBe(second.dataSource);
    expect(resolveCount).toBe(2);
    expect(created).toHaveLength(1);
    expect(factory.poolSize).toBe(1);
    await Promise.all([first.release(), second.release()]);
    await factory.close();
    expect(created[0]!.isInitialized).toBe(false);
  });

  it('reserves the strict pool cap for simultaneous cold acquires of distinct tenants', async () => {
    const { resolver, session } = fixture();
    const firstContext = await resolver.resolve({ sessionId: session.id });
    const secondTenantId = opaqueTenantId();
    const secondContext = trustContextForTests({
      ...firstContext,
      tenantId: secondTenantId,
      database: {
        ...firstContext.database,
        tenantId: secondTenantId,
        databaseName: `opslog_t_${secondTenantId.replaceAll('-', '')}`,
        credentialRef: `tenant/${secondTenantId}/runtime`,
      },
    } as TenantContext);
    let resolveCount = 0;
    let releaseResolvers!: () => void;
    const bothResolversStarted = new Promise<void>((resolve) => {
      releaseResolvers = resolve;
    });
    const created: DataSource[] = [];
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      {
        async resolve(ref, version) {
          resolveCount += 1;
          if (resolveCount === 2) releaseResolvers();
          await bothResolversStarted;
          const resolvedTenantId = ref === location.credentialRef ? tenantId : secondTenantId;
          const resolvedDatabaseName =
            resolvedTenantId === tenantId
              ? location.databaseName
              : secondContext.database.databaseName;
          return {
            tenantId: resolvedTenantId,
            databaseName: resolvedDatabaseName,
            username: 'opslog_u_synthetic',
            password: 'synthetic-test-only',
            secretVersion: version,
          };
        },
      },
      { maxDataSources: 1 },
      (options) => {
        const source = fakeDataSource(options);
        created.push(source);
        return source;
      },
    );

    const results = await Promise.allSettled([
      factory.acquire(firstContext),
      factory.acquire(secondContext),
    ]);
    const leases = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failures = results.filter((result) => result.status === 'rejected');
    expect(leases).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.status).toBe('rejected');
    if (failures[0]!.status === 'rejected')
      expect(failures[0]!.reason).toBeInstanceOf(TenantDataSourceCapacityError);
    expect(resolveCount).toBe(2);
    expect(factory.poolSize).toBe(1);
    expect(created).toHaveLength(1);
    await leases[0]!.release();
    await factory.close();
    expect(created[0]!.isInitialized).toBe(false);
  });

  it('caches per tenant and secret version, evicts idle pools, and closes its lifecycle', async () => {
    const { resolver, session } = fixture();
    const context = await resolver.resolve({ sessionId: session.id });
    const created: DataSource[] = [];
    const resolvedVersions: number[] = [];
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      {
        async resolve(_ref, version) {
          resolvedVersions.push(version);
          return {
            tenantId,
            databaseName: location.databaseName,
            username: 'opslog_u_synthetic',
            password: `synthetic-test-${version}`,
            secretVersion: version,
          };
        },
      },
      { maxDataSources: 4, maxActiveLeases: 2 },
      (options) => {
        const source = fakeDataSource(options);
        created.push(source);
        return source;
      },
    );

    const first = await factory.acquire(context);
    const shared = await factory.acquire(context);
    expect(shared.dataSource).toBe(first.dataSource);
    expect(resolvedVersions).toEqual([location.secretVersion]);
    await first.release();
    await shared.release();

    const rotatedContext = trustContextForTests({
      ...context,
      database: {
        ...context.database,
        credentialRef: `${context.database.credentialRef}/rotated`,
        secretVersion: context.database.secretVersion + 1,
      },
    } as TenantContext);
    const rotated = await factory.acquire(rotatedContext);
    expect(resolvedVersions).toEqual([location.secretVersion, location.secretVersion + 1]);
    expect(created).toHaveLength(2);
    expect(created[0]!.isInitialized).toBe(false);
    expect(rotated.dataSource).toBe(created[1]);
    expect(factory.poolSize).toBe(1);
    await expect(factory.close()).rejects.toBeInstanceOf(TenantDataSourceCapacityError);
    await rotated.release();
    await factory.close();
    expect(factory.poolSize).toBe(0);
    expect(created[1]!.isInitialized).toBe(false);
    await expect(factory.acquire(context)).rejects.toBeInstanceOf(TenantDataSourceCapacityError);
  });

  it('queues bounded acquire backpressure and rejects overflow', async () => {
    const { resolver, session } = fixture();
    const context = await resolver.resolve({ sessionId: session.id });
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      {
        async resolve() {
          return {
            tenantId,
            databaseName: location.databaseName,
            username: 'opslog_u_synthetic',
            password: 'synthetic-test-only',
            secretVersion: location.secretVersion,
          };
        },
      },
      { maxActiveLeases: 1, maxQueuedAcquires: 1, acquireTimeoutMs: 2_000 },
      fakeDataSource,
    );
    const active = await factory.acquire(context);
    const queued = factory.acquire(context);
    expect(factory.queuedAcquireCount).toBe(1);
    await expect(factory.acquire(context)).rejects.toBeInstanceOf(TenantDataSourceCapacityError);
    await active.release();
    const resumed = await queued;
    expect(resumed.dataSource).toBe(active.dataSource);
    await resumed.release();
    await factory.close();
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

  it('rejects a shape-compatible context that was not issued by the resolver', async () => {
    const { resolver, session } = fixture();
    const issued = await resolver.resolve({ sessionId: session.id });
    const forged = JSON.parse(JSON.stringify(issued)) as TenantContext;
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      {
        async resolve() {
          throw new Error('credentials must not be resolved for an untrusted context');
        },
      },
      {},
      fakeDataSource,
    );
    await expect(factory.acquire(forged)).rejects.toBeInstanceOf(TenantAccessDeniedError);
    expect(factory.activeLeaseCount).toBe(0);
  });

  it('does not hold the pool lock while a stale data source is being destroyed', async () => {
    const { resolver, session } = fixture();
    const context = await resolver.resolve({ sessionId: session.id });
    const otherTenantId = opaqueTenantId();
    const otherContext = trustContextForTests({
      ...context,
      tenantId: otherTenantId,
      database: {
        ...context.database,
        tenantId: otherTenantId,
        databaseName: `opslog_t_${otherTenantId.replaceAll('-', '')}`,
        credentialRef: `tenant/${otherTenantId}/runtime`,
      },
    } as TenantContext);
    const rotatedContext = trustContextForTests({
      ...context,
      database: {
        ...context.database,
        credentialRef: `${context.database.credentialRef}/rotated`,
        secretVersion: context.database.secretVersion + 1,
      },
    } as TenantContext);
    let releaseDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    let created = 0;
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 3306 },
      {
        async resolve(ref, version) {
          const owner = ref === otherContext.database.credentialRef ? otherContext : context;
          return {
            tenantId: owner.tenantId,
            databaseName: owner.database.databaseName,
            username: 'opslog_u_synthetic',
            password: 'synthetic-test-only',
            secretVersion: version,
          };
        },
      },
      { maxDataSources: 4 },
      (options) => {
        created += 1;
        const source = fakeDataSource(options);
        if (created === 1) {
          const destroy = source.destroy.bind(source);
          source.destroy = async () => {
            await destroyGate;
            await destroy();
          };
        }
        return source;
      },
    );
    const first = await factory.acquire(context);
    await first.release();
    const rotation = factory.acquire(rotatedContext);
    await Promise.resolve();
    const other = await factory.acquire(otherContext);
    releaseDestroy();
    await other.release();
    await (await rotation).release();
    await factory.close();
  });
});
