import 'reflect-metadata';
import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  opaqueId,
  subjectId,
  IdempotencyConflictError,
  ProvisioningFailedError,
  TenantAccessDeniedError,
  type Session,
  type SessionId,
  type Tenant,
  type TenantProvisioningTarget,
} from '@opslog/domain-tenants';
import { DataSource, QueryFailedError, Table } from 'typeorm';
import {
  createControlPlaneDataSource,
  type FencedTenantProvisioningTarget,
  TenantContextResolver,
  TenantDataSourceFactory,
  TypeOrmTenantStore,
  tenantScopedRepository,
  type ResolvedTenantCredentials,
  type TenantCredentialResolver,
  type TenantProvisioningBackend,
  VerifiedTenantProvisioningAdapter,
} from './index.js';
import {
  CreateTenancyControlPlane2026100400010,
  CreateTenantDatabase2026100400020,
  TENANT_DATABASE_MIGRATION_VERSION,
} from './migrations.js';
import {
  CONTROL_PLANE_ENTITIES,
  ProvisioningJobEntity,
  TenantDataRecordEntity,
  TENANT_DATA_ENTITIES,
} from './entities.js';
import { trustContextForTests } from './testing.js';

const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrlValue)
  throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required; MySQL integration must not be skipped');

function withLoopbackAdminConfig<T>(
  value: string,
  action: (config: { host: string; port: number; user: string; password: string }) => T,
): T {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '::1'].includes(host))
    throw new Error('synthetic MySQL admin URL must use a loopback host');
  return action({
    host,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
}

const adminConfig = withLoopbackAdminConfig(adminUrlValue, (config) => config);
const typeormAdminConfig = {
  host: adminConfig.host,
  port: adminConfig.port,
  username: adminConfig.user,
  password: adminConfig.password,
};
const suffix = `${Date.now()}_${process.pid}`;
const controlDatabase = `opslog_cp_${suffix}`;
const controlUsername = `opslog_control_${createHash('sha256').update(suffix).digest('hex').slice(0, 16)}`;
const adminDatabase = mysql.createConnection({ ...adminConfig, database: 'mysql' });
const createdDatabases = new Set<string>([controlDatabase]);
const createdAccounts = new Set<string>();
const credentialDirectory = new Map<string, ResolvedTenantCredentials>();
let controlSource: DataSource;
let secondControlSource: DataSource;
let firstStore: TypeOrmTenantStore;
let secondStore: TypeOrmTenantStore;

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('test generated an invalid identifier');
  return `\`${value}\``;
}

function account(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('test generated an invalid account');
  return `'${value}'@'%'`;
}

function runtimeUsername(target: TenantProvisioningTarget): string {
  return `opslog_u_${createHash('sha256').update(target.credentialRef).digest('hex').slice(0, 20)}`;
}

class SyntheticMySqlBackend implements TenantProvisioningBackend {
  calls = 0;
  readonly steps: string[] = [];
  constructor(
    private readonly failAfterMigration = false,
    private readonly delayMs = 0,
    private readonly omitIsolationEvidence = false,
    private readonly omitRoleEvidence = false,
  ) {}

  async createIsolatedDatabase(target: TenantProvisioningTarget): Promise<void> {
    this.calls += 1;
    this.steps.push('database');
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const admin = await adminDatabase;
    const database = quoteIdentifier(target.databaseName);
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${database} CHARACTER SET utf8mb4`);
    createdDatabases.add(target.databaseName);
  }

  async createLeastPrivilegeRuntimeCredential(target: TenantProvisioningTarget): Promise<void> {
    this.steps.push('runtime-credential');
    const admin = await adminDatabase;
    const username = runtimeUsername(target);
    const password = randomBytes(30).toString('base64url');
    const database = quoteIdentifier(target.databaseName);
    await admin.query(`CREATE USER IF NOT EXISTS ${account(username)} IDENTIFIED BY ?`, [password]);
    await admin.query(`ALTER USER ${account(username)} IDENTIFIED BY ?`, [password]);
    createdAccounts.add(username);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${database}.* TO ${account(username)}`,
    );
    credentialDirectory.set(target.credentialRef, {
      tenantId: target.tenantId,
      databaseName: target.databaseName,
      username,
      password,
      secretVersion: target.secretVersion,
    });
  }

  async runTenantMigrations(target: TenantProvisioningTarget): Promise<string> {
    this.steps.push('migrations');
    const migrationSource = new DataSource({
      type: 'mysql',
      ...typeormAdminConfig,
      database: target.databaseName,
      entities: [...TENANT_DATA_ENTITIES],
      migrations: [CreateTenantDatabase2026100400020],
      migrationsTransactionMode: 'all',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
    });
    await migrationSource.initialize();
    try {
      await migrationSource.runMigrations({ transaction: 'all' });
      expect(await migrationSource.showMigrations()).toBe(false);
      await migrationSource.undoLastMigration({ transaction: 'all' });
      expect(await migrationSource.showMigrations()).toBe(true);
      await migrationSource.runMigrations({ transaction: 'all' });
      expect(await migrationSource.showMigrations()).toBe(false);
    } finally {
      await migrationSource.destroy();
    }
    if (this.failAfterMigration) throw new Error('synthetic post-migration failure');
    return TENANT_DATABASE_MIGRATION_VERSION;
  }

  async verifyRuntimeRole(target: TenantProvisioningTarget): Promise<boolean> {
    this.steps.push('runtime-role');
    const runtime = await this.openRuntimeDataSource(target);
    try {
      await runtime.getRepository(TenantDataRecordEntity).count();
      const runner = runtime.createQueryRunner();
      await runner.connect();
      try {
        await expectAccessDenied(
          runner.createTable(
            new Table({
              name: `forbidden_ddl_${suffix}`,
              columns: [{ name: 'id', type: 'int', isPrimary: true }],
            }),
          ),
        );
        return !this.omitRoleEvidence;
      } finally {
        await runner.release();
      }
    } finally {
      await runtime.destroy();
    }
  }

  async verifyCrossTenantIsolation(target: TenantProvisioningTarget): Promise<boolean> {
    this.steps.push('cross-tenant-isolation');
    if (this.omitIsolationEvidence) return false;
    const runtime = await this.openRuntimeDataSource(target);
    try {
      try {
        await runtime.query(
          `SELECT id FROM ${quoteIdentifier(controlDatabase)}.opslog_control_tenants LIMIT 1`,
        );
        return false;
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
        return true;
      }
    } finally {
      await runtime.destroy();
    }
  }

  private async openRuntimeDataSource(target: TenantProvisioningTarget): Promise<DataSource> {
    const credential = credentialDirectory.get(target.credentialRef);
    if (!credential) throw new Error('synthetic runtime credential is unavailable');
    const runtime = new DataSource({
      type: 'mysql',
      host: adminConfig.host,
      port: adminConfig.port,
      username: credential.username,
      password: credential.password,
      database: target.databaseName,
      entities: [...TENANT_DATA_ENTITIES],
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
    });
    await runtime.initialize();
    return runtime;
  }

  async rollback(target: TenantProvisioningTarget): Promise<void> {
    const admin = await adminDatabase;
    const credentials = credentialDirectory.get(target.credentialRef);
    if (credentials) {
      await admin.query(`DROP USER IF EXISTS ${account(credentials.username)}`);
      createdAccounts.delete(credentials.username);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(target.databaseName)}`);
    createdDatabases.delete(target.databaseName);
    credentialDirectory.delete(target.credentialRef);
  }
}

class SyntheticMySqlProvisioner extends VerifiedTenantProvisioningAdapter {
  readonly steps: string[];
  readonly targets: FencedTenantProvisioningTarget[] = [];
  calls = 0;

  constructor(
    failAfterMigration = false,
    delayMs = 0,
    omitIsolationEvidence = false,
    omitRoleEvidence = false,
  ) {
    const backend = new SyntheticMySqlBackend(
      failAfterMigration,
      delayMs,
      omitIsolationEvidence,
      omitRoleEvidence,
    );
    super(backend);
    this.steps = backend.steps;
  }

  override provision(target: FencedTenantProvisioningTarget) {
    this.calls += 1;
    this.targets.push(target);
    return super.provision(target);
  }
}

class PausedAfterProvisioningAdapter extends SyntheticMySqlProvisioner {
  private signalStarted!: () => void;
  private resumeProvisioning!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.signalStarted = resolve;
  });
  private readonly resumed = new Promise<void>((resolve) => {
    this.resumeProvisioning = resolve;
  });

  release(): void {
    this.resumeProvisioning();
  }

  override async provision(target: FencedTenantProvisioningTarget) {
    const evidence = await super.provision(target);
    this.signalStarted();
    await this.resumed;
    return evidence;
  }
}

const credentialResolver: TenantCredentialResolver = {
  async resolve(credentialRef, secretVersion) {
    const resolved = credentialDirectory.get(credentialRef);
    if (!resolved || resolved.secretVersion !== secretVersion)
      throw new Error('synthetic credential missing');
    return resolved;
  },
};

function isAccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    driverError?: { code?: string; errno?: number };
    code?: string;
    errno?: number;
  };
  const code = candidate.driverError?.code ?? candidate.code;
  const errno = candidate.driverError?.errno ?? candidate.errno;
  return (
    errno === 1044 ||
    errno === 1142 ||
    code === 'ER_DBACCESS_DENIED_ERROR' ||
    code === 'ER_TABLEACCESS_DENIED_ERROR'
  );
}

async function expectAccessDenied(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const candidate = error as {
      driverError?: { code?: string; errno?: number };
      code?: string;
      errno?: number;
      name?: string;
    };
    const code = candidate.driverError?.code ?? candidate.code ?? 'NO_CODE';
    const errno = candidate.driverError?.errno ?? candidate.errno ?? 0;
    if (!(error instanceof QueryFailedError) || !isAccessDenied(error)) {
      throw Object.assign(new Error('MySQL access-denial probe returned an unexpected error'), {
        code: `UNEXPECTED_PROBE_${code}_${errno}_${candidate.name ?? 'UNKNOWN'}`
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, '_')
          .slice(0, 64),
      });
    }
    return;
  }
  throw new Error('expected MySQL to deny the operation');
}

async function makeContext(store: TypeOrmTenantStore, tenant: Tenant) {
  const subject = subjectId('synthetic-concurrent-operator');
  const membership = await store.projectMembership(tenant.id, subject, 1, 'active');
  const location = await store.getLocation(tenant.id);
  if (!location) throw new Error('provisioning evidence was not persisted');
  const session: Session = {
    id: opaqueId() as SessionId,
    tenantId: tenant.id,
    subjectId: subject,
    authorizationVersion: tenant.authorizationVersion,
    expiresAt: new Date(Date.now() + 60_000),
    revoked: false,
  };
  await store.saveSession(session);
  return {
    context: await new TenantContextResolver(store).resolve({ sessionId: session.id }),
    membership,
    session,
  };
}

describe('synthetic MySQL admin URL guard', () => {
  it('rejects non-loopback hosts before the connection or DDL callback can run', () => {
    let ddlCalls = 0;
    expect(() =>
      withLoopbackAdminConfig('mysql://fixture@db.example.invalid/mysql', () => {
        ddlCalls += 1;
      }),
    ).toThrow('loopback host');
    expect(ddlCalls).toBe(0);
    expect(withLoopbackAdminConfig('mysql://fixture@127.0.0.1/mysql', ({ host }) => host)).toBe(
      '127.0.0.1',
    );
  });
});

describe('TypeORM tenancy against synthetic MySQL 8', () => {
  beforeAll(async () => {
    const admin = await adminDatabase;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(controlDatabase)} CHARACTER SET utf8mb4`);
    const migrationSource = new DataSource({
      type: 'mysql',
      ...typeormAdminConfig,
      database: controlDatabase,
      entities: [...CONTROL_PLANE_ENTITIES],
      migrations: [CreateTenancyControlPlane2026100400010],
      migrationsTransactionMode: 'all',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
    });
    await migrationSource.initialize();
    try {
      await migrationSource.runMigrations({ transaction: 'all' });
      expect(await migrationSource.showMigrations()).toBe(false);
    } finally {
      await migrationSource.destroy();
    }
    const controlPassword = randomBytes(30).toString('base64url');
    await admin.query(`CREATE USER ${account(controlUsername)} IDENTIFIED BY ?`, [controlPassword]);
    createdAccounts.add(controlUsername);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdentifier(controlDatabase)}.* TO ${account(controlUsername)}`,
    );
    const config = {
      host: adminConfig.host,
      port: adminConfig.port,
      database: controlDatabase,
      username: controlUsername,
      password: controlPassword,
    };
    controlSource = createControlPlaneDataSource(config);
    secondControlSource = createControlPlaneDataSource(config);
    await controlSource.initialize();
    await controlSource.runMigrations({ transaction: 'all' });
    await secondControlSource.initialize();
    firstStore = new TypeOrmTenantStore(controlSource, 5_000, 30_000);
    secondStore = new TypeOrmTenantStore(secondControlSource, 5_000, 30_000);
  }, 30_000);

  afterAll(async () => {
    if (secondControlSource?.isInitialized) await secondControlSource.destroy();
    if (controlSource?.isInitialized) await controlSource.destroy();
    const admin = await adminDatabase;
    for (const user of createdAccounts) await admin.query(`DROP USER IF EXISTS ${account(user)}`);
    for (const database of createdDatabases)
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
    await admin.end();
  }, 30_000);

  it('persists provisioning leases, migrations, role evidence, rollback and retry across store instances', async () => {
    const failing = new SyntheticMySqlProvisioner(true);
    await expect(
      firstStore.createAndProvision({ name: 'Rollback tenant' }, `rollback-${suffix}`, failing),
    ).rejects.toBeInstanceOf(ProvisioningFailedError);
    const failedJob = await controlSource
      .getRepository(ProvisioningJobEntity)
      .findOneBy({ idempotencyKey: `rollback-${suffix}` });
    expect(failedJob?.status).toBe('failed');
    expect(failedJob?.attempt).toBe(1);
    expect(await firstStore.getTenant(failedJob!.tenantId as Tenant['id'])).toMatchObject({
      status: 'failed',
    });
    expect(await firstStore.getLocation(failedJob!.tenantId as Tenant['id'])).toBeUndefined();
    const failedTenant = await firstStore.getTenant(failedJob!.tenantId as Tenant['id']);
    const failedDatabaseName = `opslog_t_${failedTenant!.id.replaceAll('-', '')}_a1`;
    const [failedDatabaseRows] = await (
      await adminDatabase
    ).execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [
      failedDatabaseName,
    ]);
    expect((failedDatabaseRows as unknown[]).length).toBe(0);

    const retryAdapter = new SyntheticMySqlProvisioner();
    let retried: Tenant;
    try {
      retried = await secondStore.createAndProvision(
        { name: 'Rollback tenant' },
        `rollback-${suffix}`,
        retryAdapter,
      );
    } catch (error) {
      const diagnostic = error as { reasonCode?: string };
      const job = await secondStore.getJob(
        failedJob!.tenantId as Tenant['id'],
        `rollback-${suffix}`,
      );
      throw new Error(
        `synthetic retry failed: ${diagnostic.reasonCode ?? 'unknown'}; stored=${job?.errorCode ?? 'none'}`,
      );
    }
    expect(retried.status).toBe('active');
    expect(retryAdapter.calls).toBe(1);
    expect(await secondStore.getLocation(retried.id)).toMatchObject({
      migrationVersion: TENANT_DATABASE_MIGRATION_VERSION,
      runtimeRoleVerified: true,
      isolationProbeVerified: true,
    });
    expect(retryAdapter.steps).toEqual([
      'database',
      'runtime-credential',
      'migrations',
      'runtime-role',
      'cross-tenant-isolation',
    ]);
    await expect(
      firstStore.createAndProvision(
        { name: 'Different tenant' },
        `rollback-${suffix}`,
        retryAdapter,
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const incomplete = new SyntheticMySqlProvisioner(false, 0, true);
    await expect(
      firstStore.createAndProvision(
        { name: 'Unverified tenant' },
        `unverified-${suffix}`,
        incomplete,
      ),
    ).rejects.toBeInstanceOf(ProvisioningFailedError);
    const incompleteJob = await controlSource
      .getRepository(ProvisioningJobEntity)
      .findOneByOrFail({ idempotencyKey: `unverified-${suffix}` });
    expect(incompleteJob.status).toBe('failed');
    expect((await firstStore.getTenant(incompleteJob.tenantId as Tenant['id']))?.status).toBe(
      'failed',
    );
    expect(await firstStore.getLocation(incompleteJob.tenantId as Tenant['id'])).toBeUndefined();
    const roleMissing = new SyntheticMySqlProvisioner(false, 0, false, true);
    await expect(
      firstStore.createAndProvision(
        { name: 'Role evidence missing' },
        `role-missing-${suffix}`,
        roleMissing,
      ),
    ).rejects.toBeInstanceOf(ProvisioningFailedError);
    const roleJob = await controlSource
      .getRepository(ProvisioningJobEntity)
      .findOneByOrFail({ idempotencyKey: `role-missing-${suffix}` });
    expect(roleJob.status).toBe('failed');
    expect((await firstStore.getTenant(roleJob.tenantId as Tenant['id']))?.status).toBe('failed');
    expect(await firstStore.getLocation(roleJob.tenantId as Tenant['id'])).toBeUndefined();
  }, 60_000);

  it('uses cross-instance leases for concurrent provisioning and durable idempotent retries', async () => {
    const slowAdapter = new SyntheticMySqlProvisioner(false, 350);
    const unusedAdapter = new SyntheticMySqlProvisioner();
    const key = `concurrent-${suffix}`;
    const [tenantA, tenantB] = await Promise.all([
      firstStore.createAndProvision({ name: 'Tenant A' }, key, slowAdapter),
      secondStore.createAndProvision({ name: 'Tenant A' }, key, unusedAdapter),
    ]);
    expect(tenantA.id).toBe(tenantB.id);
    expect(slowAdapter.calls + unusedAdapter.calls).toBe(1);
    expect((await secondStore.getJob(tenantA.id, key))?.status).toBe('succeeded');
    const retry = await secondStore.createAndProvision({ name: 'Tenant A' }, key, unusedAdapter);
    expect(retry.id).toBe(tenantA.id);
    expect(unusedAdapter.calls).toBe(0);

    const tenantBResult = await firstStore.createAndProvision(
      { name: 'Tenant B' },
      `tenant-b-${suffix}`,
      new SyntheticMySqlProvisioner(),
    );
    const ctxA = await makeContext(firstStore, tenantA);
    const ctxB = await makeContext(secondStore, tenantBResult);
    const factory = new TenantDataSourceFactory(
      { host: adminConfig.host, port: adminConfig.port },
      credentialResolver,
    );
    const leaseA = await factory.acquire(ctxA.context);
    const leaseB = await factory.acquire(ctxB.context);
    const dataSourceA = leaseA.dataSource;
    const dataSourceB = leaseB.dataSource;
    try {
      const repoA = tenantScopedRepository(ctxA.context, dataSourceA);
      const repoB = tenantScopedRepository(ctxB.context, dataSourceB);
      const sameLocalId = opaqueId();
      await repoA.insert({ id: sameLocalId, value: 'A-only' });
      await repoB.insert({ id: sameLocalId, value: 'B-only' });
      expect((await repoA.findById(sameLocalId))?.value).toBe('A-only');
      expect((await repoB.findById(sameLocalId))?.value).toBe('B-only');
      await expectAccessDenied(
        dataSourceA.query(
          `SELECT id FROM ${quoteIdentifier(ctxB.context.database.databaseName)}.opslog_tenant_records WHERE id = ?`,
          [sameLocalId],
        ),
      );
      await expectAccessDenied(
        dataSourceB.query(
          `SELECT id FROM ${quoteIdentifier(ctxA.context.database.databaseName)}.opslog_tenant_records WHERE id = ?`,
          [sameLocalId],
        ),
      );

      const runnerA = dataSourceA.createQueryRunner();
      await runnerA.connect();
      await runnerA.startTransaction();
      try {
        await runnerA.manager
          .getRepository(TenantDataRecordEntity)
          .update({ tenantId: tenantA.id, id: sameLocalId }, { value: 'rolled-back' });
      } finally {
        await runnerA.rollbackTransaction();
        await runnerA.release();
      }
      expect((await repoA.findById(sameLocalId))?.value).toBe('A-only');
      expect((await repoB.findById(sameLocalId))?.value).toBe('B-only');
    } finally {
      await leaseA.release();
      await leaseB.release();
      await factory.close();
    }

    const boundedFactory = new TenantDataSourceFactory(
      { host: adminConfig.host, port: adminConfig.port },
      credentialResolver,
      {
        maxDataSources: 1,
        maxActiveLeases: 1,
        maxQueuedAcquires: 1,
        acquireTimeoutMs: 2_000,
        maxConnectionsPerDataSource: 2,
      },
    );
    const boundedLeaseA = await boundedFactory.acquire(ctxA.context);
    const queuedLeaseBPromise = boundedFactory.acquire(ctxB.context);
    expect(boundedFactory.queuedAcquireCount).toBe(1);
    await expect(boundedFactory.acquire(ctxA.context)).rejects.toThrow(
      'capacity is temporarily exhausted',
    );
    await boundedLeaseA.release();
    const boundedLeaseB = await queuedLeaseBPromise;
    expect(boundedLeaseA.dataSource.isInitialized).toBe(false);
    expect(boundedLeaseB.dataSource.options.extra).toMatchObject({ connectionLimit: 2 });
    await boundedLeaseB.release();
    await boundedFactory.close();

    const sourceForVersionCheck = new TenantDataSourceFactory(
      { host: adminConfig.host, port: adminConfig.port },
      credentialResolver,
      { maxDataSources: 1 },
    );
    const versionOne = await sourceForVersionCheck.acquire(ctxA.context);
    const versionOneShared = await sourceForVersionCheck.acquire(ctxA.context);
    expect(versionOne.dataSource).toBe(versionOneShared.dataSource);
    await versionOne.release();
    await versionOneShared.release();
    const currentCredential = credentialDirectory.get(ctxA.context.database.credentialRef)!;
    const rotatedRef = `${ctxA.context.database.credentialRef}/version-check`;
    credentialDirectory.set(rotatedRef, {
      ...currentCredential,
      secretVersion: ctxA.context.database.secretVersion + 1,
    });
    const rotatedContext = trustContextForTests({
      ...ctxA.context,
      database: {
        ...ctxA.context.database,
        credentialRef: rotatedRef,
        secretVersion: ctxA.context.database.secretVersion + 1,
      },
    } as typeof ctxA.context);
    const versionTwo = await sourceForVersionCheck.acquire(rotatedContext);
    expect(versionTwo.dataSource).not.toBe(versionOne.dataSource);
    expect(versionOne.dataSource.isInitialized).toBe(false);
    expect(versionTwo.dataSource.isInitialized).toBe(true);
    await versionTwo.release();
    await sourceForVersionCheck.evictTenant(tenantA.id);
    expect(sourceForVersionCheck.poolSize).toBe(0);
    await sourceForVersionCheck.close();

    const subject = ctxA.membership.subjectId;
    await Promise.all([
      firstStore.projectMembership(tenantA.id, subject, 3, 'active'),
      secondStore.projectMembership(tenantA.id, subject, 2, 'revoked'),
    ]);
    expect(await secondStore.getMembership(tenantA.id, subject)).toMatchObject({
      version: 3,
      status: 'active',
    });
    const beforeRevocation = (await secondStore.getTenant(tenantA.id))!.authorizationVersion;
    await firstStore.projectMembership(tenantA.id, subject, 4, 'revoked');
    await secondStore.projectMembership(tenantA.id, subject, 4, 'active');
    expect(await firstStore.getMembership(tenantA.id, subject)).toMatchObject({
      version: 4,
      status: 'revoked',
    });
    expect((await secondStore.getTenant(tenantA.id))?.authorizationVersion).toBe(
      beforeRevocation + 1,
    );
    await expect(
      new TenantContextResolver(secondStore).resolve({ sessionId: ctxA.session.id }),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);
  }, 90_000);

  it('fences expired lease attempts so stale rollback cannot delete the active winner', async () => {
    const key = `fenced-reassign-${suffix}`;
    const slowStore = new TypeOrmTenantStore(controlSource, 60_000, 5_000);
    const winningStore = new TypeOrmTenantStore(secondControlSource, 60_000, 5_000);
    const staleAdapter = new PausedAfterProvisioningAdapter();
    const staleAttempt = slowStore.createAndProvision({ name: 'Fenced tenant' }, key, staleAdapter);

    await staleAdapter.started;
    await controlSource
      .getRepository(ProvisioningJobEntity)
      .update({ idempotencyKey: key }, { leaseExpiresAt: new Date(0) });

    const winningAdapter = new SyntheticMySqlProvisioner();
    const winner = await winningStore.createAndProvision(
      { name: 'Fenced tenant' },
      key,
      winningAdapter,
    );
    const winningTarget = winningAdapter.targets[0];
    const staleTarget = staleAdapter.targets[0];
    if (!winningTarget || !staleTarget)
      throw new Error('synthetic attempt targets were not recorded');
    expect(winner.status).toBe('active');
    expect(staleTarget.attempt).toBe(1);
    expect(winningTarget.attempt).toBe(2);
    expect(staleTarget.databaseName).not.toBe(winningTarget.databaseName);
    expect(await winningStore.getLocation(winner.id)).toMatchObject({
      databaseName: winningTarget.databaseName,
      credentialRef: winningTarget.credentialRef,
      secretVersion: winningTarget.secretVersion,
    });

    staleAdapter.release();
    await expect(staleAttempt).rejects.toBeInstanceOf(ProvisioningFailedError);
    expect((await winningStore.getTenant(winner.id))?.status).toBe('active');
    expect(await winningStore.getJob(winner.id, key)).toMatchObject({ status: 'succeeded' });
    expect(await winningStore.getLocation(winner.id)).toMatchObject({
      databaseName: winningTarget.databaseName,
      credentialRef: winningTarget.credentialRef,
    });
    expect(credentialDirectory.has(winningTarget.credentialRef)).toBe(true);

    const admin = await adminDatabase;
    const [staleRows] = await admin.execute(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [staleTarget.databaseName],
    );
    const [winnerRows] = await admin.execute(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [winningTarget.databaseName],
    );
    expect((staleRows as unknown[]).length).toBe(0);
    expect((winnerRows as unknown[]).length).toBe(1);
  }, 90_000);
});
