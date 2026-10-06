import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DataSource,
  FindOperator,
  type DataSourceOptions,
  type MigrationInterface,
  type QueryRunner,
  type Table,
} from 'typeorm';
import {
  type Membership,
  type Session,
  type SubjectId,
  type Tenant,
  type TenantDatabaseLocation,
  type TenantContext,
  type TenantId,
  type SessionId,
  IdempotencyConflictError,
  ProvisioningFailedError,
  opaqueId,
  opaqueTenantId,
  payloadHash,
  sessionIdHash,
  subjectId,
} from '@opslog/domain-tenants';
import { TenantAccessDeniedError } from '@opslog/domain-tenants';
import { trustContextForTests } from './testing.js';
import {
  CONTROL_PLANE_MIGRATION_VERSION,
  TENANT_DATABASE_MIGRATION_VERSION,
  TenantContextResolver,
  TenantDataSourceCapacityError,
  TenantDataSourceFactory,
  TenantScopedRepository,
  TypeOrmTenantStore,
  VerifiedTenantProvisioningAdapter,
  createControlPlaneDataSource,
  runControlPlaneMigrations,
  runTenantMigrations,
  tenantScopedRepository,
  type FencedTenantProvisioningTarget,
  type ResolvedTenantCredentials,
  type TenantCredentialResolver,
  type TenantDataSourceLease,
  type TenantProvisioningBackend,
  type TenantStore,
} from './index.js';
import {
  CONTROL_PLANE_ENTITIES,
  MembershipProjectionEntity,
  ProvisioningJobEntity,
  TENANT_DATA_ENTITIES,
  TenantDataRecordEntity,
  TenantDatabaseLocationEntity,
  TenantEntity,
  TenantSessionEntity,
} from './entities.js';
import {
  CreateTenancyControlPlane2026100400010,
  CreateTenantDatabase2026100400020,
} from './migrations.js';

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

describe('membership projection lock contention', () => {
  function storeWithTransaction(transaction: (work: unknown) => Promise<unknown>) {
    const dataSource = {
      options: { type: 'mysql', username: 'opslog_control_synthetic' },
      transaction,
    } as unknown as DataSource;
    return new TypeOrmTenantStore(dataSource);
  }
  const manager = {
    getRepository: () => ({
      findOne: async () => null,
      insert: async () => undefined,
    }),
  };

  it('retries a deadlocked projection and applies it', async () => {
    let calls = 0;
    const store = storeWithTransaction(async (work) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('deadlock'), { errno: 1213 });
      return (work as (m: unknown) => Promise<unknown>)(manager);
    });
    await expect(store.projectMembership(tenantId, actorId, 1, 'active')).resolves.toMatchObject({
      version: 1,
      status: 'active',
    });
    expect(calls).toBe(2);
  });

  it('gives up after bounded lock-contention retries', async () => {
    let calls = 0;
    const store = storeWithTransaction(async () => {
      calls += 1;
      throw Object.assign(new Error('timeout'), { driverError: { code: 'ER_LOCK_WAIT_TIMEOUT' } });
    });
    await expect(store.projectMembership(tenantId, actorId, 1, 'active')).rejects.toThrow(
      'timeout',
    );
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// In-memory fakes of the TypeORM control-plane ports (DataSource, Repository, transaction).
// ---------------------------------------------------------------------------------------------

type Row = Record<string, any>;
type EntityClass = abstract new () => unknown;

const PRIMARY_KEYS = new Map<EntityClass, string[]>([
  [TenantEntity, ['id']],
  [TenantDatabaseLocationEntity, ['tenantId']],
  [MembershipProjectionEntity, ['tenantId', 'subjectId']],
  [TenantSessionEntity, ['sessionIdHash']],
  [ProvisioningJobEntity, ['idempotencyKey']],
  [TenantDataRecordEntity, ['id']],
]);
const UNIQUE_KEYS = new Map<EntityClass, string[][]>([[ProvisioningJobEntity, [['tenantId']]]]);

class FakeRepository {
  constructor(
    private readonly db: FakeControlPlane,
    private readonly entity: EntityClass,
  ) {}

  private get rows(): Row[] {
    return this.db.rows(this.entity);
  }

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (expected instanceof FindOperator) {
        if (expected.type === 'in') return (expected.value as unknown[]).includes(row[key]);
        if (expected.type === 'moreThan') return row[key] > expected.value;
        throw new Error(`unsupported operator ${expected.type}`);
      }
      return row[key] === expected;
    });
  }

  private hook(op: string, criteria?: Row): void {
    this.db.hooks.beforeOp?.(op, this.entity, criteria);
  }

  async findOneBy(where: Row): Promise<Row | null> {
    this.hook('findOneBy', where);
    const found = this.rows.find((row) => this.matches(row, where));
    return found ? { ...found } : null;
  }

  async findOne(options: { where: Row; lock?: { mode: string } }): Promise<Row | null> {
    this.hook('findOne', options.where);
    const found = this.rows.find((row) => this.matches(row, options.where));
    return found ? { ...found } : null;
  }

  async findBy(where: Row): Promise<Row[]> {
    this.hook('findBy', where);
    return this.rows.filter((row) => this.matches(row, where)).map((row) => ({ ...row }));
  }

  async insert(row: Row): Promise<void> {
    this.hook('insert', row);
    const keys = [PRIMARY_KEYS.get(this.entity)!, ...(UNIQUE_KEYS.get(this.entity) ?? [])];
    for (const key of keys)
      if (this.rows.some((existing) => key.every((field) => existing[field] === row[field])))
        throw Object.assign(new Error('duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    this.rows.push({ ...row });
  }

  async update(criteria: Row, patch: Row): Promise<{ affected: number }> {
    this.hook('update', criteria);
    const targets = this.rows.filter((row) => this.matches(row, criteria));
    for (const row of targets) Object.assign(row, patch);
    return { affected: targets.length };
  }

  async save(entity: Row): Promise<Row> {
    this.hook('save', entity);
    const key = PRIMARY_KEYS.get(this.entity)!;
    const index = this.rows.findIndex((row) => key.every((field) => row[field] === entity[field]));
    if (index >= 0) this.rows[index] = { ...entity };
    else this.rows.push({ ...entity });
    return entity;
  }

  async upsert(row: Row, conflictPaths: string[]): Promise<void> {
    this.hook('upsert', row);
    const existing = this.rows.find((candidate) =>
      conflictPaths.every((field) => candidate[field] === row[field]),
    );
    if (existing) Object.assign(existing, row);
    else this.rows.push({ ...row });
  }
}

class FakeControlPlane {
  readonly options = {
    type: 'mysql',
    username: 'opslog_control_synthetic',
    synchronize: false,
  };
  readonly hooks: {
    beforeTransaction?: ((n: number) => void | Promise<void>) | undefined;
    afterCommit?: ((n: number) => void | Promise<void>) | undefined;
    beforeOp?: ((op: string, entity: EntityClass, criteria?: Row) => void) | undefined;
  } = {};
  transactionCount = 0;
  private tables = new Map<EntityClass, Row[]>();

  rows(entity: EntityClass): Row[] {
    let rows = this.tables.get(entity);
    if (!rows) {
      rows = [];
      this.tables.set(entity, rows);
    }
    return rows;
  }

  getRepository(entity: EntityClass): FakeRepository {
    return new FakeRepository(this, entity);
  }

  async transaction<T>(
    work: (manager: { getRepository: FakeControlPlane['getRepository'] }) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const n = this.transactionCount;
    await this.hooks.beforeTransaction?.(n);
    const snapshot = new Map([...this.tables].map(([k, v]) => [k, v.map((row) => ({ ...row }))]));
    let result: T;
    try {
      result = await work({ getRepository: (entity) => this.getRepository(entity) });
    } catch (error) {
      this.tables = snapshot;
      throw error;
    }
    await this.hooks.afterCommit?.(n);
    return result;
  }
}

function newControlPlane(leaseMs?: number, waitMs?: number) {
  const db = new FakeControlPlane();
  const store = new TypeOrmTenantStore(db as unknown as DataSource, leaseMs, waitMs);
  return { db, store };
}

type Call = { step: string; target: FencedTenantProvisioningTarget };

function fakeBackend(overrides: Partial<TenantProvisioningBackend> = {}) {
  const calls: Call[] = [];
  const record =
    (step: string) =>
    async (target: FencedTenantProvisioningTarget): Promise<void> => {
      calls.push({ step, target });
    };
  const backend: TenantProvisioningBackend = {
    createIsolatedDatabase: record('createIsolatedDatabase'),
    createLeastPrivilegeRuntimeCredential: record('createLeastPrivilegeRuntimeCredential'),
    runTenantMigrations: async (target) => {
      calls.push({ step: 'runTenantMigrations', target });
      return TENANT_DATABASE_MIGRATION_VERSION;
    },
    verifyRuntimeRole: async (target) => {
      calls.push({ step: 'verifyRuntimeRole', target });
      return true;
    },
    verifyCrossTenantIsolation: async (target) => {
      calls.push({ step: 'verifyCrossTenantIsolation', target });
      return true;
    },
    rollback: record('rollback'),
    ...overrides,
  };
  return { backend, adapter: new VerifiedTenantProvisioningAdapter(backend), calls };
}

function steps(calls: Call[], step: string): FencedTenantProvisioningTarget[] {
  return calls.filter((call) => call.step === step).map((call) => call.target);
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const jobRow = (db: FakeControlPlane): Row => db.rows(ProvisioningJobEntity)[0]!;
const tenantRow = (db: FakeControlPlane): Row => db.rows(TenantEntity)[0]!;
const locationRow = (db: FakeControlPlane): Row => db.rows(TenantDatabaseLocationEntity)[0]!;

describe('control-plane store constructor and simple accessors', () => {
  it.each([
    ['a non-MySQL driver', { type: 'postgres', username: 'opslog_control_x', synchronize: false }],
    ['schema synchronization', { type: 'mysql', username: 'opslog_control_x', synchronize: true }],
  ])('rejects %s', (_label, options) => {
    expect(() => new TypeOrmTenantStore({ options } as unknown as DataSource)).toThrow(
      'Tenant control plane requires MySQL with synchronize disabled',
    );
  });

  it.each([['root'], ['opslog_u_tenant'], [undefined], [42]])(
    'rejects the non-control-plane account %s',
    (username) => {
      expect(
        () =>
          new TypeOrmTenantStore({
            options: { type: 'mysql', username, synchronize: false },
          } as unknown as DataSource),
      ).toThrow('Tenant control plane requires its restricted runtime account');
    },
  );

  it('round-trips a session by its hash and never stores the raw session identifier', async () => {
    const { db, store } = newControlPlane();
    const session: Session = {
      id: 'raw-session-id' as SessionId,
      tenantId,
      subjectId: actorId,
      authorizationVersion: 4,
      expiresAt: new Date(Date.now() + 1000),
      revoked: false,
    };
    await expect(store.getSession(session.id)).resolves.toBeUndefined();
    await store.saveSession(session);
    expect(JSON.stringify(db.rows(TenantSessionEntity))).not.toContain('raw-session-id');
    const loaded = await store.getSession(session.id);
    expect(loaded).toEqual(session);
    expect(Object.isFrozen(loaded)).toBe(true);

    await store.saveSession({ ...session, revoked: true, authorizationVersion: 5 });
    expect(db.rows(TenantSessionEntity)).toHaveLength(1);
    await expect(store.getSession(session.id)).resolves.toMatchObject({
      revoked: true,
      authorizationVersion: 5,
    });
  });

  it('coerces numeric columns that the driver returns as strings', async () => {
    const { db, store } = newControlPlane();
    db.rows(MembershipProjectionEntity).push({
      tenantId,
      subjectId: actorId,
      status: 'active',
      version: '7',
    });
    db.rows(TenantSessionEntity).push({
      sessionIdHash: sessionIdHash('s' as SessionId),
      tenantId,
      subjectId: actorId,
      authorizationVersion: '9',
      expiresAt: new Date(0),
      revoked: false,
    });
    await expect(store.getMembership(tenantId, actorId)).resolves.toMatchObject({ version: 7 });
    await expect(store.getSession('s' as SessionId)).resolves.toMatchObject({
      authorizationVersion: 9,
    });
  });

  it('returns undefined for unknown tenant, membership and job, and exposes a stored tenant', async () => {
    const { db, store } = newControlPlane();
    await expect(store.getTenant(tenantId)).resolves.toBeUndefined();
    await expect(store.getMembership(tenantId, actorId)).resolves.toBeUndefined();
    await expect(store.getJob(tenantId, 'k')).resolves.toBeUndefined();
    const createdAt = new Date(5);
    db.rows(TenantEntity).push({ id: tenantId, name: 'T', status: 'active', createdAt });
    const loaded = await store.getTenant(tenantId);
    expect(loaded).toEqual({ id: tenantId, name: 'T', status: 'active', createdAt });
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it('exposes a job with its error code only when one was recorded', async () => {
    const { db, store } = newControlPlane();
    const base = {
      id: opaqueId(),
      idempotencyKey: 'k',
      tenantId,
      payloadHash: 'h',
      status: 'failed',
      attempt: '2',
    };
    db.rows(ProvisioningJobEntity).push({ ...base, errorCode: 'BOOM' });
    await expect(store.getJob(tenantId, 'k')).resolves.toEqual({
      id: base.id,
      tenantId,
      idempotencyKey: 'k',
      payloadHash: 'h',
      status: 'failed',
      attempt: 2,
      errorCode: 'BOOM',
    });
    jobRow(db).errorCode = null;
    const withoutError = await store.getJob(tenantId, 'k');
    expect(withoutError).not.toHaveProperty('errorCode');
    await expect(store.getJob(tenantId, 'other-key')).resolves.toBeUndefined();
  });

  it.each([
    ['row missing', undefined],
    ['migration not recorded', { migrationVersion: null }],
    ['runtime role unverified', { runtimeRoleVerified: false }],
    ['isolation unverified', { isolationProbeVerified: false }],
    ['verification time missing', { verifiedAt: null }],
  ])('hides a tenant location that is not fully verified (%s)', async (_label, patch) => {
    const { db, store } = newControlPlane();
    if (patch)
      db.rows(TenantDatabaseLocationEntity).push({
        tenantId,
        databaseName: location.databaseName,
        credentialRef: location.credentialRef,
        secretVersion: '3',
        migrationVersion: '2026100400020',
        runtimeRoleVerified: true,
        isolationProbeVerified: true,
        verifiedAt: new Date(1),
        ...patch,
      });
    await expect(store.getLocation(tenantId)).resolves.toBeUndefined();
  });

  it('returns a frozen, numerically coerced location once it is fully verified', async () => {
    const { db, store } = newControlPlane();
    db.rows(TenantDatabaseLocationEntity).push({
      tenantId,
      databaseName: location.databaseName,
      credentialRef: location.credentialRef,
      secretVersion: '3',
      migrationVersion: '2026100400020',
      runtimeRoleVerified: true,
      isolationProbeVerified: true,
      verifiedAt: new Date(1),
    });
    const loaded = await store.getLocation(tenantId);
    expect(loaded).toMatchObject({ tenantId, secretVersion: 3, verifiedAt: new Date(1) });
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it('refuses to activate a tenant that has no verified location, but allows other statuses', async () => {
    const { db, store } = newControlPlane();
    db.rows(TenantEntity).push({
      id: tenantId,
      name: 'T',
      status: 'provisioning',
      createdAt: new Date(0),
    });
    await expect(store.setTenantStatus(tenantId, 'active')).rejects.toBeInstanceOf(
      ProvisioningFailedError,
    );
    expect(tenantRow(db).status).toBe('provisioning');

    await store.setTenantStatus(tenantId, 'suspended');
    expect(tenantRow(db).status).toBe('suspended');

    db.rows(TenantDatabaseLocationEntity).push({
      tenantId,
      databaseName: 'd',
      credentialRef: 'c',
      secretVersion: 1,
      migrationVersion: '2026100400020',
      runtimeRoleVerified: true,
      isolationProbeVerified: true,
      verifiedAt: new Date(1),
    });
    await store.setTenantStatus(tenantId, 'active');
    expect(tenantRow(db).status).toBe('active');
  });
});

describe('membership projection (in-memory transaction)', () => {
  it('rejects non-positive and non-integer versions before touching the database', async () => {
    const { db, store } = newControlPlane();
    for (const version of [0, -1, 1.5, Number.NaN])
      await expect(store.projectMembership(tenantId, actorId, version, 'active')).rejects.toThrow(
        'membership version must be positive',
      );
    expect(db.transactionCount).toBe(0);
  });

  it('inserts, advances on newer versions and ignores stale or equal ones', async () => {
    const { db, store } = newControlPlane();
    await expect(store.projectMembership(tenantId, actorId, 2, 'active')).resolves.toEqual({
      tenantId,
      subjectId: actorId,
      version: 2,
      status: 'active',
    });
    await expect(store.projectMembership(tenantId, actorId, 3, 'revoked')).resolves.toMatchObject({
      version: 3,
      status: 'revoked',
    });
    for (const stale of [3, 1]) {
      const result = await store.projectMembership(tenantId, actorId, stale, 'active');
      expect(result).toMatchObject({ version: 3, status: 'revoked' });
      expect(Object.isFrozen(result)).toBe(true);
    }
    expect(db.rows(MembershipProjectionEntity)).toEqual([
      { tenantId, subjectId: actorId, version: 3, status: 'revoked' },
    ]);
  });

  it('retries a duplicate-key race once the competing row exists, then applies the newer version', async () => {
    const { db, store } = newControlPlane();
    let raced = false;
    db.hooks.beforeOp = (op) => {
      if (op === 'insert' && !raced) {
        raced = true;
        db.rows(MembershipProjectionEntity).push({
          tenantId,
          subjectId: actorId,
          version: 1,
          status: 'active',
        });
        throw Object.assign(new Error('dup'), { driverError: { errno: 1062 } });
      }
    };
    await expect(store.projectMembership(tenantId, actorId, 2, 'revoked')).resolves.toMatchObject({
      version: 2,
      status: 'revoked',
    });
    expect(db.transactionCount).toBe(2);
  });

  it('does not retry errors that are neither duplicate-key nor lock contention', async () => {
    const { db, store } = newControlPlane();
    db.hooks.beforeTransaction = () => {
      throw new Error('connection reset');
    };
    await expect(store.projectMembership(tenantId, actorId, 1, 'active')).rejects.toThrow(
      'connection reset',
    );
    expect(db.transactionCount).toBe(1);
  });

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['an unrelated object', { code: 'ER_OTHER' }],
  ])('treats %s as non-retryable', async (_label, thrown) => {
    const { db, store } = newControlPlane();
    db.hooks.beforeTransaction = () => {
      throw thrown;
    };
    await expect(store.projectMembership(tenantId, actorId, 1, 'active')).rejects.toBe(thrown);
    expect(db.transactionCount).toBe(1);
  });

  it.each([
    ['top-level code ER_LOCK_DEADLOCK', { code: 'ER_LOCK_DEADLOCK' }],
    ['top-level code ER_LOCK_WAIT_TIMEOUT', { code: 'ER_LOCK_WAIT_TIMEOUT' }],
    ['top-level errno 1213', { errno: 1213 }],
    ['top-level errno 1205', { errno: 1205 }],
    ['driver code ER_LOCK_DEADLOCK', { driverError: { code: 'ER_LOCK_DEADLOCK' } }],
    ['driver code ER_LOCK_WAIT_TIMEOUT', { driverError: { code: 'ER_LOCK_WAIT_TIMEOUT' } }],
    ['driver errno 1213', { driverError: { errno: 1213 } }],
    ['driver errno 1205', { driverError: { errno: 1205 } }],
    ['top-level code ER_DUP_ENTRY', { code: 'ER_DUP_ENTRY' }],
    ['top-level code 23505', { code: '23505' }],
    ['top-level errno 1062', { errno: 1062 }],
    ['driver code ER_DUP_ENTRY', { driverError: { code: 'ER_DUP_ENTRY' } }],
    ['driver errno 1062', { driverError: { errno: 1062 } }],
  ])('retries on %s', async (_label, shape) => {
    const { db, store } = newControlPlane();
    db.hooks.beforeTransaction = (n) => {
      if (n === 1) throw Object.assign(new Error('transient'), shape);
    };
    await expect(store.projectMembership(tenantId, actorId, 1, 'active')).resolves.toMatchObject({
      version: 1,
    });
    expect(db.transactionCount).toBe(2);
  });

  it('succeeds on the third and final attempt but surfaces the error from a fourth', async () => {
    const { db, store } = newControlPlane();
    db.hooks.beforeTransaction = (n) => {
      if (n <= 2) throw Object.assign(new Error('deadlock'), { errno: 1213 });
    };
    await expect(store.projectMembership(tenantId, actorId, 1, 'active')).resolves.toMatchObject({
      version: 1,
    });
    expect(db.transactionCount).toBe(3);
  });
});

describe('provisioning adapter', () => {
  it('runs the backend steps in order and reports verified evidence for the fenced target', async () => {
    const { adapter, calls } = fakeBackend();
    const target: FencedTenantProvisioningTarget = {
      tenantId,
      databaseName: 'db_a1',
      credentialRef: 'ref_a1',
      secretVersion: 1,
      attempt: 1,
      leaseOwner: 'owner',
    };
    const evidence = await adapter.provision(target);
    expect(calls.map((call) => call.step)).toEqual([
      'createIsolatedDatabase',
      'createLeastPrivilegeRuntimeCredential',
      'runTenantMigrations',
      'verifyRuntimeRole',
      'verifyCrossTenantIsolation',
    ]);
    expect(evidence).toMatchObject({
      tenantId,
      databaseName: 'db_a1',
      credentialRef: 'ref_a1',
      migrationVersion: TENANT_DATABASE_MIGRATION_VERSION,
      runtimeRoleVerified: true,
      isolationProbeVerified: true,
    });
    expect(evidence.verifiedAt).toBeInstanceOf(Date);
    await adapter.rollback(target);
    expect(steps(calls, 'rollback')).toEqual([target]);
  });

  it('stops at the first failing step and reports unverified checks as false evidence', async () => {
    const failing = fakeBackend({
      createLeastPrivilegeRuntimeCredential: async () => {
        throw new Error('no grant');
      },
    });
    const target = { tenantId } as FencedTenantProvisioningTarget;
    await expect(failing.adapter.provision(target)).rejects.toThrow('no grant');
    expect(failing.calls.map((call) => call.step)).toEqual(['createIsolatedDatabase']);

    const unverified = fakeBackend({
      verifyRuntimeRole: async () => false,
      verifyCrossTenantIsolation: async () => false,
    });
    await expect(unverified.adapter.provision(target)).resolves.toMatchObject({
      runtimeRoleVerified: false,
      isolationProbeVerified: false,
    });
  });
});

describe('createAndProvision', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['an empty name', '', 'key'],
    ['a blank name', '   ', 'key'],
    ['a name over 160 characters', 'x'.repeat(161), 'key'],
    ['a blank idempotency key', 'Acme', '  '],
    ['an idempotency key over 255 characters', 'Acme', 'k'.repeat(256)],
  ])('rejects %s without touching the database', async (_label, name, key) => {
    const { db, store } = newControlPlane();
    const { adapter, calls } = fakeBackend();
    await expect(store.createAndProvision({ name }, key, adapter)).rejects.toThrow(
      'invalid provisioning request',
    );
    expect(db.transactionCount).toBe(0);
    expect(calls).toEqual([]);
  });

  it('accepts the maximum name and key lengths', async () => {
    const { store } = newControlPlane();
    const { adapter } = fakeBackend();
    const tenant = await store.createAndProvision(
      { name: 'n'.repeat(160) },
      'k'.repeat(255),
      adapter,
    );
    expect(tenant.name).toHaveLength(160);
  });

  it('provisions an attempt-specific database, activates the tenant and persists verified evidence', async () => {
    const { db, store } = newControlPlane();
    const { adapter, calls } = fakeBackend();

    const tenant = await store.createAndProvision({ name: '  Acme  ' }, 'idem-1', adapter);

    expect(tenant).toMatchObject({ name: 'Acme', status: 'active' });
    expect(Object.isFrozen(tenant)).toBe(true);
    const key = tenant.id.replaceAll('-', '');
    const [target] = steps(calls, 'createIsolatedDatabase');
    expect(target).toMatchObject({
      tenantId: tenant.id,
      databaseName: `opslog_t_${key}_a1`,
      credentialRef: `tenant/${tenant.id}/attempt/1/runtime`,
      secretVersion: 1,
      attempt: 1,
    });
    expect(target!.leaseOwner).toMatch(/^[0-9a-f-]{36}$/);
    expect(steps(calls, 'rollback')).toEqual([]);
    expect(locationRow(db)).toMatchObject({
      databaseName: `opslog_t_${key}_a1`,
      credentialRef: `tenant/${tenant.id}/attempt/1/runtime`,
      migrationVersion: TENANT_DATABASE_MIGRATION_VERSION,
      runtimeRoleVerified: true,
      isolationProbeVerified: true,
    });
    expect(jobRow(db)).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
    });
    await expect(store.getLocation(tenant.id)).resolves.toMatchObject({ tenantId: tenant.id });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is idempotent: replaying a succeeded key returns the tenant and provisions nothing', async () => {
    const { db, store } = newControlPlane();
    const first = fakeBackend();
    const tenant = await store.createAndProvision({ name: 'Acme' }, 'idem-1', first.adapter);
    const replay = fakeBackend();
    await expect(
      store.createAndProvision({ name: ' Acme ' }, 'idem-1', replay.adapter),
    ).resolves.toEqual(tenant);
    expect(replay.calls).toEqual([]);
    expect(db.rows(TenantEntity)).toHaveLength(1);
    expect(jobRow(db).attempt).toBe(1);
  });

  it('rejects the same idempotency key with a different payload', async () => {
    const { store } = newControlPlane();
    const { adapter } = fakeBackend();
    await store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter);
    await expect(
      store.createAndProvision({ name: 'Other' }, 'idem-1', adapter),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('fails closed when an existing job points at a missing tenant or location', async () => {
    const { db, store } = newControlPlane();
    const { adapter } = fakeBackend();
    await store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter);

    db.rows(TenantDatabaseLocationEntity).length = 0;
    await expect(
      store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter),
    ).rejects.toBeInstanceOf(ProvisioningFailedError);
    db.rows(TenantEntity).length = 0;
    await expect(
      store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter),
    ).rejects.toBeInstanceOf(ProvisioningFailedError);
  });

  it('fails closed when a succeeded job no longer has an active tenant', async () => {
    const { db, store } = newControlPlane();
    const { adapter } = fakeBackend();
    await store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter);
    tenantRow(db).status = 'suspended';
    await expect(
      store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter),
    ).rejects.toBeInstanceOf(ProvisioningFailedError);
    tenantRow(db).status = 'active';
    db.rows(TenantEntity).length = 0;
    await expect(
      store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter),
    ).rejects.toBeInstanceOf(ProvisioningFailedError);
  });

  describe('concurrent creation of the same idempotency key', () => {
    const seedCompetitor = (db: FakeControlPlane, payloadForName: string, withLocation = true) => {
      const competitorId = opaqueTenantId();
      db.rows(ProvisioningJobEntity).push({
        id: opaqueId(),
        idempotencyKey: 'idem-race',
        tenantId: competitorId,
        payloadHash: payloadHash({ name: payloadForName }),
        status: 'pending',
        attempt: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      if (withLocation)
        db.rows(TenantDatabaseLocationEntity).push({
          tenantId: competitorId,
          databaseName: `opslog_t_${competitorId.replaceAll('-', '')}`,
          credentialRef: `tenant/${opaqueId()}/runtime`,
          secretVersion: 1,
          migrationVersion: null,
          runtimeRoleVerified: false,
          isolationProbeVerified: false,
          verifiedAt: null,
        });
      return competitorId;
    };

    it('adopts the competing record and rolls back its own half-written rows', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend();
      let competitorId!: string;
      db.hooks.beforeTransaction = (n) => {
        if (n === 1) {
          db.hooks.beforeTransaction = undefined;
          competitorId = seedCompetitor(db, 'Acme');
          db.rows(TenantEntity).push({
            id: competitorId,
            name: 'Acme',
            status: 'provisioning',
            createdAt: new Date(),
          });
        }
      };
      const tenant = await store.createAndProvision({ name: 'Acme' }, 'idem-race', adapter);
      expect(tenant.id).toBe(competitorId);
      expect(db.rows(TenantEntity)).toHaveLength(1);
      expect(db.rows(TenantDatabaseLocationEntity)).toHaveLength(1);
      expect(steps(calls, 'createIsolatedDatabase')[0]!.tenantId).toBe(competitorId);
    });

    it('reports a conflict when the competing record has a different payload', async () => {
      const { db, store } = newControlPlane();
      const { adapter } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 1) seedCompetitor(db, 'Different');
      };
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'idem-race', adapter),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('reports a conflict when the duplicate key was not caused by the idempotency key', async () => {
      const { db, store } = newControlPlane();
      const { adapter } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 1) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      };
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'idem-race', adapter),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('fails closed when the competing record has no location', async () => {
      const { db, store } = newControlPlane();
      const { adapter } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 1) seedCompetitor(db, 'Acme', false);
      };
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'idem-race', adapter),
      ).rejects.toBeInstanceOf(ProvisioningFailedError);
    });

    it('rethrows non-duplicate insert failures', async () => {
      const { db, store } = newControlPlane();
      const { adapter } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 1) throw new Error('disk full');
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toThrow(
        'disk full',
      );
    });
  });

  describe('failure handling', () => {
    it('rolls back the attempt, records a sanitized failure and resets the location', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend({ verifyCrossTenantIsolation: async () => false });
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'idem-1', adapter),
      ).rejects.toMatchObject({
        code: 'TENANT_PROVISIONING_FAILED',
        reasonCode: 'PROVISIONING_FAILED',
      });
      expect(steps(calls, 'rollback')).toHaveLength(1);
      expect(steps(calls, 'rollback')[0]!.attempt).toBe(1);
      expect(jobRow(db)).toMatchObject({
        status: 'failed',
        errorCode: 'PROVISIONING_FAILED',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(tenantRow(db).status).toBe('failed');
      expect(locationRow(db)).toMatchObject({
        migrationVersion: null,
        runtimeRoleVerified: false,
        isolationProbeVerified: false,
        verifiedAt: null,
      });
      await expect(store.getLocation(tenantRow(db).id)).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      [
        'a driver error code',
        Object.assign(new Error('x'), { driverError: { code: 'ER_ACCESS_DENIED' } }),
        'ER_ACCESS_DENIED',
      ],
      [
        'a top-level error code',
        Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        'ECONNREFUSED',
      ],
      ['the error name', new TypeError('secret detail'), 'TYPEERROR'],
      ['a normalized code', Object.assign(new Error('x'), { code: 'my-code.v2' }), 'MY_CODE_V2'],
      ['a non-object throw', 'boom', 'PROVISIONING_FAILED'],
      ['a null throw', null, 'PROVISIONING_FAILED'],
      ['a non-string code', { code: 42 }, 'PROVISIONING_FAILED'],
      ['an empty code', { code: '' }, 'PROVISIONING_FAILED'],
      ['an over-long code', { code: 'A'.repeat(65) }, 'PROVISIONING_FAILED'],
      ['a 64-character code', { code: 'A'.repeat(64) }, 'A'.repeat(64)],
      ['a domain failure reason', new ProvisioningFailedError('CUSTOM_REASON'), 'CUSTOM_REASON'],
    ])(
      'derives the persisted failure code from %s without leaking messages',
      async (_l, thrown, expected) => {
        const { db, store } = newControlPlane();
        const { adapter } = fakeBackend({
          createIsolatedDatabase: async () => {
            throw thrown;
          },
        });
        const error = await store
          .createAndProvision({ name: 'Acme' }, 'idem-1', adapter)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ProvisioningFailedError);
        expect((error as ProvisioningFailedError).reasonCode).toBe(expected);
        expect((error as Error).message).toBe('Tenant provisioning failed');
        expect(jobRow(db).errorCode).toBe(expected);
      },
    );

    it('still records the failure when the cleanup itself fails', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend({
        runTenantMigrations: async () => {
          throw new Error('migration failed');
        },
        rollback: async () => {
          throw new Error('cleanup failed');
        },
      });
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toBeInstanceOf(
        ProvisioningFailedError,
      );
      expect(calls.some((call) => call.step === 'verifyRuntimeRole')).toBe(false);
      expect(jobRow(db).status).toBe('failed');
      expect(tenantRow(db).status).toBe('failed');
    });

    it.each([
      ['a foreign tenant id', { tenantId: opaqueTenantId() }],
      ['a different database', { databaseName: 'opslog_t_other' }],
      ['a different credential', { credentialRef: 'tenant/other/runtime' }],
      ['a stale migration version', { migrationVersion: '1' }],
      ['an unverified runtime role', { runtimeRoleVerified: false }],
      ['a failed isolation probe', { isolationProbeVerified: false }],
      ['an invalid verification time', { verifiedAt: new Date(Number.NaN) }],
    ])('refuses to activate on evidence with %s', async (_label, tamper) => {
      const { db, store } = newControlPlane();
      const rollback = vi.fn(async () => undefined);
      const adapter = {
        provision: async (target: FencedTenantProvisioningTarget) => ({
          tenantId: target.tenantId,
          databaseName: target.databaseName,
          credentialRef: target.credentialRef,
          migrationVersion: TENANT_DATABASE_MIGRATION_VERSION,
          runtimeRoleVerified: true,
          isolationProbeVerified: true,
          verifiedAt: new Date(),
          ...tamper,
        }),
        rollback,
      } as unknown as VerifiedTenantProvisioningAdapter;
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toBeInstanceOf(
        ProvisioningFailedError,
      );
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(tenantRow(db).status).toBe('failed');
      expect(locationRow(db).runtimeRoleVerified).toBe(false);
    });

    it('uses a fresh attempt-specific database and credential on retry and then succeeds', async () => {
      const { db, store } = newControlPlane();
      const failing = fakeBackend({
        runTenantMigrations: async () => {
          throw new Error('x');
        },
      });
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'k', failing.adapter),
      ).rejects.toThrow();
      const good = fakeBackend();
      const tenant = await store.createAndProvision({ name: 'Acme' }, 'k', good.adapter);
      const key = tenant.id.replaceAll('-', '');
      expect(steps(good.calls, 'createIsolatedDatabase')[0]).toMatchObject({
        databaseName: `opslog_t_${key}_a2`,
        credentialRef: `tenant/${tenant.id}/attempt/2/runtime`,
        secretVersion: 2,
        attempt: 2,
      });
      expect(steps(failing.calls, 'rollback')[0]!.databaseName).toBe(`opslog_t_${key}_a1`);
      expect(steps(good.calls, 'rollback')).toEqual([]);
      expect(locationRow(db)).toMatchObject({
        databaseName: `opslog_t_${key}_a2`,
        secretVersion: 2,
      });
      expect(jobRow(db)).toMatchObject({ status: 'succeeded', attempt: 2, errorCode: null });
      expect(tenantRow(db).status).toBe('active');
    });

    it('stops after the maximum number of attempts and marks the tenant failed', async () => {
      const { db, store } = newControlPlane();
      const failing = fakeBackend({
        createIsolatedDatabase: async () => {
          throw new Error('x');
        },
      });
      for (let attempt = 1; attempt <= 5; attempt += 1)
        await expect(
          store.createAndProvision({ name: 'Acme' }, 'k', failing.adapter),
        ).rejects.toMatchObject({ reasonCode: 'ERROR' });
      expect(steps(failing.calls, 'rollback').map((t) => t.attempt)).toEqual([1, 2, 3, 4, 5]);
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'k', failing.adapter),
      ).rejects.toMatchObject({ reasonCode: 'ATTEMPTS_EXHAUSTED' });
      expect(steps(failing.calls, 'rollback')).toHaveLength(5);
      expect(jobRow(db)).toMatchObject({
        status: 'failed',
        errorCode: 'ATTEMPTS_EXHAUSTED',
        attempt: 5,
        leaseOwner: null,
      });
      expect(tenantRow(db).status).toBe('failed');
    });

    it('never provisions a tenant that an operator suspended and consumes no attempt', async () => {
      const { db, store } = newControlPlane();
      const failing = fakeBackend({
        createIsolatedDatabase: async () => {
          throw new Error('x');
        },
      });
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'k', failing.adapter),
      ).rejects.toThrow();
      tenantRow(db).status = 'suspended';
      const next = fakeBackend();
      await expect(
        store.createAndProvision({ name: 'Acme' }, 'k', next.adapter),
      ).rejects.toMatchObject({ reasonCode: 'TENANT_NOT_PROVISIONABLE' });
      expect(next.calls).toEqual([]);
      expect(jobRow(db).attempt).toBe(1);
      expect(tenantRow(db).status).toBe('suspended');
    });
  });

  describe('lost commit acknowledgement and unprovable outcomes', () => {
    it('returns the tenant and does not roll back when the activation commit landed but its acknowledgement was lost', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend();
      db.hooks.afterCommit = (n) => {
        // Transactions: 1 record, 2 claim, 3 activation, 4 outcome re-check.
        if (n === 3) throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
      };
      const tenant = await store.createAndProvision({ name: 'Acme' }, 'k', adapter);
      expect(tenant).toMatchObject({ status: 'active', name: 'Acme' });
      expect(steps(calls, 'rollback')).toEqual([]);
      expect(jobRow(db).status).toBe('succeeded');
      expect(locationRow(db).runtimeRoleVerified).toBe(true);
    });

    it('does not roll back live resources when the commit landed but the tenant is no longer active', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend();
      db.hooks.afterCommit = (n) => {
        if (n === 3) {
          tenantRow(db).status = 'suspended';
          throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
        }
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toMatchObject({
        reasonCode: 'ECONNRESET',
      });
      expect(steps(calls, 'rollback')).toEqual([]);
      expect(jobRow(db).status).toBe('succeeded');
      expect(tenantRow(db).status).toBe('suspended');
      expect(locationRow(db).runtimeRoleVerified).toBe(true);
    });

    it('does not roll back when the outcome cannot be determined', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 3) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        if (n === 4) throw new Error('still down');
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toMatchObject({
        reasonCode: 'ETIMEDOUT',
      });
      expect(steps(calls, 'rollback')).toEqual([]);
      expect(jobRow(db).status).toBe('running');
    });

    it('rolls back when the activation provably did not commit', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 3) throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toMatchObject({
        reasonCode: 'ER_LOCK_DEADLOCK',
      });
      expect(steps(calls, 'rollback')).toHaveLength(1);
      expect(jobRow(db)).toMatchObject({ status: 'failed', errorCode: 'ER_LOCK_DEADLOCK' });
    });

    it('treats a missing job at re-check time as not succeeded', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 3) {
          db.rows(ProvisioningJobEntity).length = 0;
        }
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toBeInstanceOf(
        ProvisioningFailedError,
      );
      expect(steps(calls, 'rollback')).toHaveLength(1);
    });
  });

  describe('fencing of the activation commit', () => {
    const mutations: [string, (db: FakeControlPlane) => void][] = [
      ['the lease owner changed', (db) => (jobRow(db).leaseOwner = 'someone-else')],
      ['the attempt changed', (db) => (jobRow(db).attempt = 99)],
      ['the lease is missing', (db) => (jobRow(db).leaseExpiresAt = null)],
      ['the lease has expired', (db) => (jobRow(db).leaseExpiresAt = new Date(Date.now() - 1))],
      ['the payload hash changed', (db) => (jobRow(db).payloadHash = 'different')],
      ['the job is no longer running', (db) => (jobRow(db).status = 'failed')],
      ['the job vanished', (db) => db.rows(ProvisioningJobEntity).splice(0)],
    ];

    it.each(mutations)('refuses to activate when %s', async (_label, mutate) => {
      const { db, store } = newControlPlane();
      const { adapter } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 3) mutate(db);
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toBeInstanceOf(
        ProvisioningFailedError,
      );
      expect(locationRow(db).runtimeRoleVerified).toBe(false);
      expect(tenantRow(db).status).not.toBe('active');
    });

    it('leaves a job owned by a newer lease holder untouched when its own attempt fails', async () => {
      const { db, store } = newControlPlane();
      const { adapter, calls } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 3) {
          jobRow(db).leaseOwner = 'newer-owner';
          jobRow(db).attempt = 2;
        }
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toBeInstanceOf(
        ProvisioningFailedError,
      );
      expect(steps(calls, 'rollback')[0]!.attempt).toBe(1);
      expect(jobRow(db)).toMatchObject({
        status: 'running',
        leaseOwner: 'newer-owner',
        attempt: 2,
      });
    });

    it('refuses to report activation when the tenant row is not active afterwards', async () => {
      const { db, store } = newControlPlane();
      const { adapter } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 3) tenantRow(db).status = 'suspended';
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toBeInstanceOf(
        ProvisioningFailedError,
      );
      expect(tenantRow(db).status).toBe('suspended');
    });

    it('refuses to report activation when the tenant row disappeared', async () => {
      const { db, store } = newControlPlane();
      const { adapter } = fakeBackend();
      db.hooks.beforeTransaction = (n) => {
        if (n === 3) db.rows(TenantEntity).splice(0);
      };
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toBeInstanceOf(
        ProvisioningFailedError,
      );
    });
  });

  describe('lease heartbeat', () => {
    async function startBlocked(store: TypeOrmTenantStore, key = 'k') {
      const migrations = gate();
      const reached = gate();
      const { adapter, calls } = fakeBackend({
        runTenantMigrations: async () => {
          reached.open();
          await migrations.promise;
          return TENANT_DATABASE_MIGRATION_VERSION;
        },
      });
      const promise = store.createAndProvision({ name: 'Acme' }, key, adapter);
      // Attach a handler right away so a rejection is never reported as unhandled.
      const settled = promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await reached.promise;
      return { promise, settled, release: migrations.open, calls };
    }

    it('extends the lease of the running attempt every third of the lease period', async () => {
      const { db, store } = newControlPlane(3_000);
      const run = await startBlocked(store);
      const claimedExpiry = (jobRow(db).leaseExpiresAt as Date).getTime();

      await vi.advanceTimersByTimeAsync(999);
      expect((jobRow(db).leaseExpiresAt as Date).getTime()).toBe(claimedExpiry);
      await vi.advanceTimersByTimeAsync(1);
      expect((jobRow(db).leaseExpiresAt as Date).getTime()).toBe(claimedExpiry + 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((jobRow(db).leaseExpiresAt as Date).getTime()).toBe(claimedExpiry + 2_000);
      expect(jobRow(db).status).toBe('running');

      run.release();
      await expect(run.promise).resolves.toMatchObject({ status: 'active' });
      expect(vi.getTimerCount()).toBe(0);
      // No heartbeat fires after completion.
      const finalState = { ...jobRow(db) };
      await vi.advanceTimersByTimeAsync(10_000);
      expect(jobRow(db)).toEqual(finalState);
    });

    it('never beats faster than once per second even for very short leases', async () => {
      const { db, store } = newControlPlane(300);
      const run = await startBlocked(store);
      const claimedExpiry = (jobRow(db).leaseExpiresAt as Date).getTime();
      await vi.advanceTimersByTimeAsync(999);
      expect((jobRow(db).leaseExpiresAt as Date).getTime()).toBe(claimedExpiry);
      // The lease has already expired by the first beat, so it must not be resurrected.
      await vi.advanceTimersByTimeAsync(1);
      expect((jobRow(db).leaseExpiresAt as Date).getTime()).toBe(claimedExpiry);
      run.release();
      await run.settled;
    });

    it('does not extend a lease that another owner took over', async () => {
      const { db, store } = newControlPlane(3_000);
      const run = await startBlocked(store);
      const expiry = (jobRow(db).leaseExpiresAt as Date).getTime();
      jobRow(db).leaseOwner = 'newer-owner';
      await vi.advanceTimersByTimeAsync(1_000);
      expect((jobRow(db).leaseExpiresAt as Date).getTime()).toBe(expiry);
      run.release();
      await expect(run.promise).rejects.toBeInstanceOf(ProvisioningFailedError);
    });

    it('keeps provisioning when a heartbeat write fails', async () => {
      const { db, store } = newControlPlane(3_000);
      const run = await startBlocked(store);
      let beats = 0;
      db.hooks.beforeOp = (op, entity) => {
        if (op === 'update' && entity === ProvisioningJobEntity) {
          beats += 1;
          throw new Error('heartbeat write failed');
        }
      };
      await vi.advanceTimersByTimeAsync(1_000);
      expect(beats).toBe(1);
      db.hooks.beforeOp = undefined;
      run.release();
      await expect(run.promise).resolves.toMatchObject({ status: 'active' });
    });

    it('stops the heartbeat when the attempt fails', async () => {
      const { store } = newControlPlane(3_000);
      const { adapter } = fakeBackend({
        verifyRuntimeRole: async () => {
          throw new Error('x');
        },
      });
      await expect(store.createAndProvision({ name: 'Acme' }, 'k', adapter)).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('waiting on another process that holds the lease', () => {
    async function holder(store: TypeOrmTenantStore) {
      const migrations = gate();
      const reached = gate();
      const { adapter, calls } = fakeBackend({
        runTenantMigrations: async () => {
          reached.open();
          await migrations.promise;
          return TENANT_DATABASE_MIGRATION_VERSION;
        },
      });
      const promise = store.createAndProvision({ name: 'Acme' }, 'k', adapter);
      const settled = promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await reached.promise;
      return { promise, settled, release: migrations.open, calls };
    }

    it('returns the tenant once the lease holder succeeds', async () => {
      const { db, store } = newControlPlane(60_000, 5_000);
      const first = await holder(store);
      const waiter = fakeBackend();
      const waiting = store.createAndProvision({ name: 'Acme' }, 'k', waiter.adapter);
      await vi.advanceTimersByTimeAsync(50);
      expect(jobRow(db).status).toBe('running');
      first.release();
      const [tenant] = await Promise.all([waiting, vi.advanceTimersByTimeAsync(100)]);
      expect(tenant).toMatchObject({ status: 'active', name: 'Acme' });
      expect(waiter.calls).toEqual([]);
      expect(jobRow(db).attempt).toBe(1);
    });

    it('takes over an expired lease with a higher attempt and fences the stale holder', async () => {
      const { db, store } = newControlPlane(100, 5_000);
      const stale = await holder(store);
      const takeover = fakeBackend();
      const waiting = store.createAndProvision({ name: 'Acme' }, 'k', takeover.adapter);
      await vi.advanceTimersByTimeAsync(49);
      expect(takeover.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(51);
      const tenant = await waiting;
      expect(tenant.status).toBe('active');
      expect(steps(takeover.calls, 'createIsolatedDatabase')[0]!.attempt).toBe(2);
      const winner = { ...locationRow(db) };

      stale.release();
      await expect(stale.promise).rejects.toBeInstanceOf(ProvisioningFailedError);
      // The stale holder only ever rolls back its own attempt-1 resources.
      expect(steps(stale.calls, 'rollback').map((t) => t.attempt)).toEqual([1]);
      expect(steps(takeover.calls, 'rollback')).toEqual([]);
      expect(locationRow(db)).toEqual(winner);
      expect(jobRow(db)).toMatchObject({ status: 'succeeded', attempt: 2 });
      expect(tenantRow(db).status).toBe('active');
    });

    it('gives up once the wait budget is spent', async () => {
      const { store } = newControlPlane(600_000, 120);
      const first = await holder(store);
      const waiting = store.createAndProvision({ name: 'Acme' }, 'k', fakeBackend().adapter);
      const assertion = expect(waiting).rejects.toMatchObject({
        code: 'TENANT_PROVISIONING_FAILED',
        reasonCode: 'PROVISIONING_FAILED',
      });
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      first.release();
      await first.settled;
    });

    it('fails when the job disappears or its payload changes while waiting', async () => {
      for (const mutate of [
        (db: FakeControlPlane) => db.rows(ProvisioningJobEntity).splice(0),
        (db: FakeControlPlane) => (jobRow(db).payloadHash = 'changed'),
      ]) {
        const { db, store } = newControlPlane(600_000, 5_000);
        const first = await holder(store);
        const waiting = store.createAndProvision({ name: 'Acme' }, 'k', fakeBackend().adapter);
        const assertion = expect(waiting).rejects.toBeInstanceOf(IdempotencyConflictError);
        mutate(db);
        await vi.advanceTimersByTimeAsync(60);
        await assertion;
        first.release();
        await first.settled;
      }
    });

    it('reports exhaustion and non-provisionable tenants discovered while waiting', async () => {
      const exhausted = newControlPlane(600_000, 5_000);
      const first = await holder(exhausted.store);
      const waitingExhausted = exhausted.store.createAndProvision(
        { name: 'Acme' },
        'k',
        fakeBackend().adapter,
      );
      const exhaustedAssertion = expect(waitingExhausted).rejects.toMatchObject({
        reasonCode: 'ATTEMPTS_EXHAUSTED',
      });
      jobRow(exhausted.db).attempt = 5;
      jobRow(exhausted.db).leaseExpiresAt = new Date(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(60);
      await exhaustedAssertion;
      expect(jobRow(exhausted.db).status).toBe('failed');

      const suspended = newControlPlane(600_000, 5_000);
      const second = await holder(suspended.store);
      const waitingSuspended = suspended.store.createAndProvision(
        { name: 'Acme' },
        'k',
        fakeBackend().adapter,
      );
      const suspendedAssertion = expect(waitingSuspended).rejects.toMatchObject({
        reasonCode: 'TENANT_NOT_PROVISIONABLE',
      });
      tenantRow(suspended.db).status = 'suspended';
      jobRow(suspended.db).leaseExpiresAt = new Date(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(60);
      await suspendedAssertion;

      first.release();
      second.release();
      await Promise.all([first.settled, second.settled]);
    });

    it('returns the tenant when the job completes between the poll and the claim', async () => {
      const { db, store } = newControlPlane(600_000, 5_000);
      const first = await holder(store);
      const waiting = store.createAndProvision({ name: 'Acme' }, 'k', fakeBackend().adapter);
      // The waiter is now sleeping inside its poll loop; the job finishes only once it takes the row lock.
      await vi.advanceTimersByTimeAsync(10);
      db.hooks.beforeOp = (op, entity) => {
        if (op === 'findOne' && entity === ProvisioningJobEntity) {
          db.hooks.beforeOp = undefined;
          jobRow(db).status = 'succeeded';
          jobRow(db).leaseOwner = null;
          jobRow(db).leaseExpiresAt = null;
          tenantRow(db).status = 'active';
        }
      };
      await vi.advanceTimersByTimeAsync(60);
      await expect(waiting).resolves.toMatchObject({ status: 'active' });
      first.release();
      await first.settled;
    });

    it('falls through to the claim when a succeeded job has no active tenant, and fails closed', async () => {
      const { db, store } = newControlPlane(600_000, 5_000);
      const first = await holder(store);
      const waiting = store.createAndProvision({ name: 'Acme' }, 'k', fakeBackend().adapter);
      const assertion = expect(waiting).rejects.toBeInstanceOf(ProvisioningFailedError);
      jobRow(db).status = 'succeeded';
      tenantRow(db).status = 'suspended';
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      first.release();
      await first.settled;
    });
  });
});

describe('TenantContextResolver denial paths', () => {
  const denied = async (patch: Partial<TenantStore>, sessionPatch: Partial<Session> = {}) => {
    const { tenant, membership, session } = fixture();
    const store = Object.assign(
      new TestTenantStore(tenant, membership, { ...session, ...sessionPatch }, location),
      patch,
    );
    await expect(
      new TenantContextResolver(store).resolve({ sessionId: session.id }),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);
  };

  it.each([
    ['an unknown session', { getSession: async () => undefined }, {}],
    ['a revoked session', {}, { revoked: true }],
    ['an unknown tenant', { getTenant: async () => undefined }, {}],
    [
      'a provisioning tenant',
      {
        getTenant: async (id: TenantId) => ({
          id,
          name: 't',
          status: 'provisioning' as const,
          createdAt: new Date(),
        }),
      },
      {},
    ],
    ['a missing membership', { getMembership: async () => undefined }, {}],
    [
      'a pending membership',
      {
        getMembership: async () => ({
          tenantId,
          subjectId: actorId,
          status: 'pending' as const,
          version: 7,
        }),
      },
      {},
    ],
    ['a missing location', { getLocation: async () => undefined }, {}],
    [
      'a location for another tenant',
      { getLocation: async () => ({ ...location, tenantId: opaqueTenantId() }) },
      {},
    ],
    [
      'an unverified runtime role',
      { getLocation: async () => ({ ...location, runtimeRoleVerified: false }) },
      {},
    ],
    [
      'a stale tenant migration',
      { getLocation: async () => ({ ...location, migrationVersion: '1' }) },
      {},
    ],
  ])('denies %s uniformly', async (_label, patch, sessionPatch) => {
    await denied(patch as Partial<TenantStore>, sessionPatch);
  });

  it('issues an immutable context with a fresh UUIDv7 correlation id and the membership version', async () => {
    const { resolver, session } = fixture();
    const first = await resolver.resolve({ sessionId: session.id });
    const second = await resolver.resolve({ sessionId: session.id });
    expect(first.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
    expect(first.correlationId).not.toBe(second.correlationId);
    expect(first.actor).toEqual({ subjectId: actorId, membershipVersion: 7 });
    expect(first.authorizationVersion).toBe(7);
    expect(Object.isFrozen(first.actor)).toBe(true);
  });
});

describe('tenant-scoped repository', () => {
  const makeRepository = () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const repository = {
      findOneBy: async (...args: unknown[]) => {
        calls.push({ method: 'findOneBy', args });
        return null;
      },
      findBy: async (...args: unknown[]) => {
        calls.push({ method: 'findBy', args });
        return [];
      },
      insert: async (...args: unknown[]) => {
        calls.push({ method: 'insert', args });
      },
    };
    const dataSource = {
      options: { database: location.databaseName },
      getRepository: (entity: unknown) => {
        calls.push({ method: 'getRepository', args: [entity] });
        return repository;
      },
    } as unknown as DataSource;
    return { calls, dataSource };
  };

  it('scopes every read and write to the tenant of the trusted context', async () => {
    const { resolver, session } = fixture();
    const context = await resolver.resolve({ sessionId: session.id });
    const { calls, dataSource } = makeRepository();
    const scoped = tenantScopedRepository(context, dataSource);
    expect(scoped).toBeInstanceOf(TenantScopedRepository);
    expect(calls[0]).toEqual({ method: 'getRepository', args: [TenantDataRecordEntity] });

    await expect(scoped.findById('record-1')).resolves.toBeNull();
    await expect(scoped.findAll()).resolves.toEqual([]);
    await scoped.insert({ id: 'record-2', value: 'v', tenantId: 'forged-tenant' } as {
      id: string;
      value: string;
    });

    expect(calls.slice(1)).toEqual([
      { method: 'findOneBy', args: [{ id: 'record-1', tenantId }] },
      { method: 'findBy', args: [{ tenantId }] },
      { method: 'insert', args: [{ id: 'record-2', value: 'v', tenantId, version: 1 }] },
    ]);
  });

  it('refuses a data source that points at another tenant database', async () => {
    const { resolver, session } = fixture();
    const context = await resolver.resolve({ sessionId: session.id });
    const { dataSource } = makeRepository();
    (dataSource.options as { database: string }).database = 'opslog_t_other';
    expect(() => tenantScopedRepository(context, dataSource)).toThrow(TenantAccessDeniedError);
  });
});

describe('migration runners and control-plane data source', () => {
  const dataSourceWith = (options: Partial<DataSourceOptions>) => {
    const runMigrations = vi.fn(async () => []);
    return { source: { options, runMigrations } as unknown as DataSource, runMigrations };
  };

  it.each([
    ['control-plane', runControlPlaneMigrations],
    ['tenant', runTenantMigrations],
  ])('runs %s migrations in one transaction on a safe data source', async (_label, run) => {
    const { source, runMigrations } = dataSourceWith({ type: 'mysql', synchronize: false });
    await run(source);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
  });

  it.each([
    ['control-plane', runControlPlaneMigrations],
    ['tenant', runTenantMigrations],
  ])(
    'refuses %s migrations when synchronization or startup migrations are enabled',
    async (_label, run) => {
      for (const unsafe of [{ synchronize: true }, { migrationsRun: true }]) {
        const { source, runMigrations } = dataSourceWith({
          type: 'mysql',
          ...unsafe,
        } as Partial<DataSourceOptions>);
        await expect(run(source)).rejects.toThrow('forbidden');
        expect(runMigrations).not.toHaveBeenCalled();
      }
    },
  );

  it('builds an uninitialized, migration-only control-plane data source for a restricted account', () => {
    const source = createControlPlaneDataSource({
      host: '127.0.0.1',
      port: 3306,
      database: 'opslog_control_test',
      username: 'opslog_control_runtime',
      password: 'synthetic-test-only',
    });
    expect(source.isInitialized).toBe(false);
    expect(source.options).toMatchObject({
      type: 'mysql',
      database: 'opslog_control_test',
      synchronize: false,
      migrationsRun: false,
      migrationsTransactionMode: 'all',
      timezone: 'Z',
      charset: 'utf8mb4',
    });
    expect(source.entityMetadatas).toEqual([]);
    expect((source.options.entities as unknown[]).length).toBe(CONTROL_PLANE_ENTITIES.length);
    expect(new TypeOrmTenantStore(source)).toBeInstanceOf(TypeOrmTenantStore);
  });

  it.each(['root', 'opslog_control_', 'opslog_control_x; DROP', 'OPSLOG_CONTROL', ''])(
    'rejects the account name %j',
    (username) => {
      expect(() =>
        createControlPlaneDataSource({
          host: 'h',
          port: 1,
          database: 'd',
          username,
          password: 'p',
        }),
      ).toThrow('restricted runtime account');
    },
  );
});

describe('schema definitions', () => {
  type Created = { name: string; columns: string[]; foreignKeys: string[]; indices: string[] };
  const collect = async (migration: MigrationInterface): Promise<Created[]> => {
    const created: Created[] = [];
    await migration.up({
      createTable: async (table: Table) => {
        created.push({
          name: table.name,
          columns: table.columns.map((column) => column.name),
          foreignKeys: table.foreignKeys.map(
            (fk) => `${fk.columnNames.join()}->${fk.referencedTableName}`,
          ),
          indices: table.indices.map((index) => index.name!),
        });
      },
    } as unknown as QueryRunner);
    return created;
  };

  it('creates the control-plane tables with tenant foreign keys and drops them in reverse order', async () => {
    const migration = new CreateTenancyControlPlane2026100400010();
    const created = await collect(migration);
    expect(migration.name).toBe('CreateTenancyControlPlane2026100400010');
    expect(CONTROL_PLANE_MIGRATION_VERSION).toBe('2026100400010');
    expect(created.map((table) => table.name)).toEqual([
      'opslog_control_tenants',
      'opslog_control_tenant_locations',
      'opslog_control_memberships',
      'opslog_control_sessions',
      'opslog_control_provisioning_jobs',
    ]);
    for (const table of created.slice(1))
      expect(table.foreignKeys).toEqual(['tenant_id->opslog_control_tenants']);
    expect(created[4]!.indices).toEqual(['ix_provisioning_status_lease']);

    const dropped: string[] = [];
    await migration.down({
      dropTable: async (name: string) => void dropped.push(name),
    } as unknown as QueryRunner);
    expect(dropped).toEqual([...created.map((table) => table.name)].reverse());
  });

  it('creates and drops the per-tenant records table with a tenant-scoped unique index', async () => {
    const migration = new CreateTenantDatabase2026100400020();
    const created = await collect(migration);
    expect(migration.name).toBe('CreateTenantDatabase2026100400020');
    expect(TENANT_DATABASE_MIGRATION_VERSION).toBe('2026100400020');
    expect(created).toEqual([
      {
        name: 'opslog_tenant_records',
        columns: ['id', 'tenant_id', 'value', 'version'],
        foreignKeys: [],
        indices: ['uq_tenant_record_tenant_id'],
      },
    ]);
    const dropped: string[] = [];
    await migration.down({
      dropTable: async (name: string) => void dropped.push(name),
    } as unknown as QueryRunner);
    expect(dropped).toEqual(['opslog_tenant_records']);
  });

  it('keeps the entity mappings aligned with the migrations that create their tables', async () => {
    const migrated = new Map<string, string[]>();
    for (const migration of [
      new CreateTenancyControlPlane2026100400010(),
      new CreateTenantDatabase2026100400020(),
    ])
      for (const table of await collect(migration)) migrated.set(table.name, table.columns.sort());
    const schemas = [...CONTROL_PLANE_ENTITIES, ...TENANT_DATA_ENTITIES];
    expect(schemas).toHaveLength(migrated.size);
    for (const schema of schemas) {
      const mapped = Object.entries(schema.options.columns)
        .map(([property, column]) => (column as { name?: string }).name ?? property)
        .sort();
      expect(mapped, schema.options.name).toEqual(migrated.get(schema.options.tableName!));
    }
  });

  it('builds TypeORM metadata for every entity and hydrates the declared classes and primary keys', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'opslog_metadata_only',
      entities: [...CONTROL_PLANE_ENTITIES, ...TENANT_DATA_ENTITIES],
    });
    // Metadata validation (unknown column types, duplicate primary keys, bad indices) needs no connection.
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const expectedPrimaryKeys = new Map<unknown, string[]>([
      [TenantEntity, ['id']],
      [TenantDatabaseLocationEntity, ['tenantId']],
      [MembershipProjectionEntity, ['tenantId', 'subjectId']],
      [TenantSessionEntity, ['sessionIdHash']],
      [ProvisioningJobEntity, ['idempotencyKey']],
      [TenantDataRecordEntity, ['id']],
    ]);
    expect(dataSource.entityMetadatas).toHaveLength(expectedPrimaryKeys.size);
    for (const metadata of dataSource.entityMetadatas) {
      expect(metadata.create(), metadata.tableName).toBeInstanceOf(metadata.target);
      expect(
        metadata.primaryColumns.map((column) => column.propertyName),
        metadata.tableName,
      ).toEqual(expectedPrimaryKeys.get(metadata.target));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// TenantDataSourceFactory: remaining validation, failure and lifecycle paths.
// ---------------------------------------------------------------------------------------------

describe('TenantDataSourceFactory validation and failure paths', () => {
  const host = { host: '127.0.0.1', port: 3306 };
  const contextFor = (patch: Partial<TenantDatabaseLocation> = {}, id: TenantId = tenantId) => {
    const database: TenantDatabaseLocation = {
      ...location,
      tenantId: id,
      databaseName: `opslog_t_${id.replaceAll('-', '')}`,
      credentialRef: `tenant/${id}/runtime`,
      ...patch,
    };
    return trustContextForTests({
      tenantId: id,
      actor: { subjectId: actorId, membershipVersion: 1 },
      authorizationVersion: 1,
      correlationId: opaqueId() as TenantContext['correlationId'],
      database,
    });
  };
  // Resolver that answers exactly what the directory says, optionally tampered with.
  const credentialsFor = (
    context: TenantContext,
    patch: Partial<ResolvedTenantCredentials> = {},
  ): TenantCredentialResolver => ({
    async resolve(_ref, version) {
      return {
        tenantId: context.tenantId,
        databaseName: context.database.databaseName,
        username: 'opslog_u_synthetic',
        password: 'synthetic-test-only',
        secretVersion: version,
        ...patch,
      };
    },
  });
  const directory = (...contexts: TenantContext[]): TenantCredentialResolver => ({
    async resolve(ref, version) {
      const owner = contexts.find((candidate) => candidate.database.credentialRef === ref)!;
      return {
        tenantId: owner.tenantId,
        databaseName: owner.database.databaseName,
        username: 'opslog_u_synthetic',
        password: 'synthetic-test-only',
        secretVersion: version,
      };
    },
  });

  it.each([
    ['maxDataSources', 0],
    ['maxDataSources', 1.5],
    ['maxActiveLeases', 0],
    ['maxActiveLeases', Number.NaN],
    ['maxQueuedAcquires', -1],
    ['maxQueuedAcquires', Number.POSITIVE_INFINITY],
    ['acquireTimeoutMs', 0],
    ['maxConnectionsPerDataSource', 0],
  ])('rejects the pool limit %s=%s', (name, value) => {
    expect(
      () =>
        new TenantDataSourceFactory(
          host,
          credentialsFor(contextFor()),
          { [name]: value },
          fakeDataSource,
        ),
    ).toThrow('invalid tenant data source pool limits');
  });

  it('uses a real TypeORM data source by default and discards it when the connection fails', async () => {
    const context = contextFor();
    // Port 1 on loopback refuses connections, so the default creator is exercised without a server.
    const factory = new TenantDataSourceFactory(
      { host: '127.0.0.1', port: 1 },
      credentialsFor(context),
    );
    await expect(factory.acquire(context)).rejects.toThrow();
    expect(factory.poolSize).toBe(0);
    expect(factory.activeLeaseCount).toBe(0);
    await factory.close();
  });

  it('accepts a zero-length queue', () => {
    expect(
      () =>
        new TenantDataSourceFactory(
          host,
          credentialsFor(contextFor()),
          { maxQueuedAcquires: 0 },
          fakeDataSource,
        ),
    ).not.toThrow();
  });

  it.each([
    ['a location for another tenant', { tenantId: opaqueTenantId() }],
    ['a secret version below 1', { secretVersion: 0 }],
    ['an unverified runtime role', { runtimeRoleVerified: false }],
    ['a failed isolation probe', { isolationProbeVerified: false }],
    ['a stale tenant migration', { migrationVersion: '1' }],
  ])('denies a trusted context with %s before resolving credentials', async (_label, patch) => {
    const resolve = vi.fn();
    const factory = new TenantDataSourceFactory(host, { resolve }, {}, fakeDataSource);
    await expect(factory.acquire(contextFor(patch))).rejects.toBeInstanceOf(
      TenantAccessDeniedError,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(factory.activeLeaseCount).toBe(0);
  });

  it.each([
    ['another tenant', { tenantId: opaqueTenantId() }],
    ['another database', { databaseName: 'opslog_t_other' }],
    ['another secret version', { secretVersion: 99 }],
    ['an empty username', { username: '' }],
    ['a master account', { username: 'root' }],
    ['a control-plane account', { username: 'opslog_control_runtime' }],
    ['an empty password', { password: '' }],
  ])('denies resolved credentials for %s and creates no data source', async (_label, patch) => {
    const context = contextFor();
    const create = vi.fn(fakeDataSource);
    const factory = new TenantDataSourceFactory(host, credentialsFor(context, patch), {}, create);
    await expect(factory.acquire(context)).rejects.toBeInstanceOf(TenantAccessDeniedError);
    expect(create).not.toHaveBeenCalled();
    expect(factory.activeLeaseCount).toBe(0);
    expect(factory.poolSize).toBe(0);
  });

  it('propagates credential resolution failures and frees the lease slot', async () => {
    const factory = new TenantDataSourceFactory(
      host,
      {
        async resolve() {
          throw new Error('secret store unavailable');
        },
      },
      { maxActiveLeases: 1 },
      fakeDataSource,
    );
    await expect(factory.acquire(contextFor())).rejects.toThrow('secret store unavailable');
    expect(factory.activeLeaseCount).toBe(0);
  });

  it('denies a cached entry whose directory data no longer matches the same tenant and version', async () => {
    const context = contextFor();
    const factory = new TenantDataSourceFactory(host, credentialsFor(context), {}, fakeDataSource);
    const lease = await factory.acquire(context);
    for (const patch of [
      { databaseName: 'opslog_t_moved' },
      { credentialRef: 'tenant/other/runtime' },
    ])
      await expect(factory.acquire(contextFor(patch))).rejects.toBeInstanceOf(
        TenantAccessDeniedError,
      );
    expect(factory.activeLeaseCount).toBe(1);
    await lease.release();
    await factory.close();
  });

  it('denies a concurrent cold acquire whose resolved password or directory entry differs', async () => {
    const context = contextFor();
    let calls = 0;
    const factory = new TenantDataSourceFactory(
      host,
      {
        async resolve(_ref, version) {
          calls += 1;
          return {
            tenantId,
            databaseName: context.database.databaseName,
            username: 'opslog_u_synthetic',
            password: calls === 1 ? 'password-one' : 'password-two',
            secretVersion: version,
          };
        },
      },
      {},
      fakeDataSource,
    );
    const results = await Promise.allSettled([factory.acquire(context), factory.acquire(context)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    const rejected = results[1] as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(TenantAccessDeniedError);
    expect(factory.activeLeaseCount).toBe(1);
    await (results[0] as PromiseFulfilledResult<TenantDataSourceLease>).value.release();
    await factory.close();
  });

  it('denies a concurrent cold acquire that resolves a different directory entry for the same key', async () => {
    const first = contextFor();
    const moved = contextFor({ credentialRef: 'tenant/moved/runtime' });
    const factory = new TenantDataSourceFactory(
      host,
      {
        async resolve(_ref, version) {
          return {
            tenantId,
            databaseName: first.database.databaseName,
            username: 'opslog_u_synthetic',
            password: 'synthetic-test-only',
            secretVersion: version,
          };
        },
      },
      {},
      fakeDataSource,
    );
    const results = await Promise.allSettled([factory.acquire(first), factory.acquire(moved)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await (results[0] as PromiseFulfilledResult<TenantDataSourceLease>).value.release();
    await factory.close();
  });

  it('removes a pool entry whose initialization fails and lets a later acquire retry', async () => {
    const context = contextFor();
    let attempts = 0;
    const destroyed: string[] = [];
    const factory = new TenantDataSourceFactory(host, credentialsFor(context), {}, (options) => {
      attempts += 1;
      const failing = attempts === 1;
      const source = fakeDataSource(options);
      if (failing) {
        source.initialize = async () => {
          throw new Error('connect refused');
        };
        source.destroy = async () => void destroyed.push('failing');
      }
      return source;
    });
    await expect(factory.acquire(context)).rejects.toThrow('connect refused');
    expect(factory.poolSize).toBe(0);
    expect(factory.activeLeaseCount).toBe(0);
    expect(destroyed).toEqual([]);
    const lease = await factory.acquire(context);
    expect(lease.dataSource.isInitialized).toBe(true);
    await lease.release();
    await factory.close();
  });

  it('shares an in-flight failing initialization and removes the entry after the last waiter', async () => {
    const context = contextFor();
    const factory = new TenantDataSourceFactory(host, credentialsFor(context), {}, (options) => {
      const source = fakeDataSource(options);
      source.initialize = async () => {
        throw new Error('connect refused');
      };
      return source;
    });
    const results = await Promise.allSettled([factory.acquire(context), factory.acquire(context)]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(factory.poolSize).toBe(0);
    expect(factory.activeLeaseCount).toBe(0);
  });

  it('disposes a data source whose initialize throws synchronously and reports the error', async () => {
    const context = contextFor();
    let destroyCalls = 0;
    const factory = new TenantDataSourceFactory(host, credentialsFor(context), {}, (options) => {
      const source = fakeDataSource(options);
      source.initialize = () => {
        throw new Error('driver exploded');
      };
      Object.defineProperty(source, 'isInitialized', { get: () => true });
      source.destroy = async () => void (destroyCalls += 1);
      return source;
    });
    await expect(factory.acquire(context)).rejects.toThrow('driver exploded');
    expect(destroyCalls).toBe(1);
    expect(factory.poolSize).toBe(0);
    expect(factory.activeLeaseCount).toBe(0);
  });

  it('does not let a failing destroy break release, eviction or close', async () => {
    const context = contextFor();
    const factory = new TenantDataSourceFactory(host, credentialsFor(context), {}, (options) => {
      const source = fakeDataSource(options);
      source.destroy = async () => {
        throw new Error('destroy failed');
      };
      return source;
    });
    const lease = await factory.acquire(context);
    await lease.release();
    await expect(factory.evictTenant(tenantId)).resolves.toBeUndefined();
    expect(factory.poolSize).toBe(0);
    await expect(factory.close()).resolves.toBeUndefined();
  });

  it('makes release idempotent and returns a frozen lease', async () => {
    const context = contextFor();
    const factory = new TenantDataSourceFactory(
      host,
      credentialsFor(context),
      { maxActiveLeases: 2 },
      fakeDataSource,
    );
    const first = await factory.acquire(context);
    const second = await factory.acquire(context);
    expect(Object.isFrozen(first)).toBe(true);
    expect(factory.activeLeaseCount).toBe(2);
    await first.release();
    await first.release();
    expect(factory.activeLeaseCount).toBe(1);
    await expect(factory.close()).rejects.toBeInstanceOf(TenantDataSourceCapacityError);
    await second.release();
    expect(factory.activeLeaseCount).toBe(0);
    await factory.close();
  });

  it('evicts only idle sources of the requested tenant and refuses while it is leased', async () => {
    const a = contextFor();
    const otherId = opaqueTenantId();
    const b = contextFor({}, otherId);
    const sources = new Map<string, DataSource>();
    const factory = new TenantDataSourceFactory(host, directory(a, b), {}, (options) => {
      const source = fakeDataSource(options);
      sources.set(String(options.database), source);
      return source;
    });
    const leaseA = await factory.acquire(a);
    const leaseB = await factory.acquire(b);
    await expect(factory.evictTenant(tenantId)).rejects.toBeInstanceOf(
      TenantDataSourceCapacityError,
    );
    expect(factory.poolSize).toBe(2);
    await leaseA.release();
    await factory.evictTenant(tenantId);
    expect(factory.poolSize).toBe(1);
    expect(sources.get(a.database.databaseName)!.isInitialized).toBe(false);
    expect(sources.get(b.database.databaseName)!.isInitialized).toBe(true);
    await leaseB.release();
    await factory.evictTenant(opaqueTenantId());
    expect(factory.poolSize).toBe(1);
    await factory.close();
  });

  it('evicts the least recently used idle source and refuses when every source is leased', async () => {
    const [a, b, c] = [
      contextFor(),
      contextFor({}, opaqueTenantId()),
      contextFor({}, opaqueTenantId()),
    ];
    let clock = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10));
    try {
      const sources = new Map<string, DataSource>();
      const factory = new TenantDataSourceFactory(
        host,
        directory(a, b, c),
        { maxDataSources: 2 },
        (options) => {
          const source = fakeDataSource(options);
          sources.set(String(options.database), source);
          return source;
        },
      );
      await (await factory.acquire(a)).release();
      await (await factory.acquire(b)).release();
      await (await factory.acquire(a)).release();
      const leaseC = await factory.acquire(c);
      expect(sources.get(b.database.databaseName)!.isInitialized).toBe(false);
      expect(sources.get(a.database.databaseName)!.isInitialized).toBe(true);
      expect(factory.poolSize).toBe(2);

      const leaseA = await factory.acquire(a);
      await expect(factory.acquire(b)).rejects.toBeInstanceOf(TenantDataSourceCapacityError);
      expect(factory.poolSize).toBe(2);
      expect(factory.activeLeaseCount).toBe(2);
      await leaseA.release();
      await leaseC.release();
      await factory.close();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps an older secret version while it is leased and drops it on release once a newer one exists', async () => {
    const v1 = contextFor();
    const v2 = contextFor({ secretVersion: 2, credentialRef: `tenant/${tenantId}/runtime/v2` });
    const sources: DataSource[] = [];
    const factory = new TenantDataSourceFactory(host, directory(v1, v2), {}, (options) => {
      const source = fakeDataSource(options);
      sources.push(source);
      return source;
    });
    const old = await factory.acquire(v1);
    const rotated = await factory.acquire(v2);
    expect(factory.poolSize).toBe(2);
    expect(sources[0]!.isInitialized).toBe(true);
    await old.release();
    expect(sources[0]!.isInitialized).toBe(false);
    expect(factory.poolSize).toBe(1);
    await rotated.release();
    expect(sources[1]!.isInitialized).toBe(true);
    await factory.close();
  });

  describe('bounded acquire queue', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects a queued acquire after its timeout and frees its queue position', async () => {
      const context = contextFor();
      const factory = new TenantDataSourceFactory(
        host,
        credentialsFor(context),
        { maxActiveLeases: 1, maxQueuedAcquires: 1, acquireTimeoutMs: 500 },
        fakeDataSource,
      );
      const active = await factory.acquire(context);
      const queued = factory.acquire(context);
      const assertion = expect(queued).rejects.toBeInstanceOf(TenantDataSourceCapacityError);
      expect(factory.queuedAcquireCount).toBe(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(factory.queuedAcquireCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(factory.queuedAcquireCount).toBe(0);
      expect(factory.activeLeaseCount).toBe(1);
      await active.release();
      expect(factory.activeLeaseCount).toBe(0);
      await factory.close();
    });

    it('rejects immediately when no queue is allowed and the lease cap is reached', async () => {
      const context = contextFor();
      const factory = new TenantDataSourceFactory(
        host,
        credentialsFor(context),
        { maxActiveLeases: 1, maxQueuedAcquires: 0 },
        fakeDataSource,
      );
      const active = await factory.acquire(context);
      await expect(factory.acquire(context)).rejects.toBeInstanceOf(TenantDataSourceCapacityError);
      expect(factory.queuedAcquireCount).toBe(0);
      await active.release();
      await factory.close();
    });
  });
});
