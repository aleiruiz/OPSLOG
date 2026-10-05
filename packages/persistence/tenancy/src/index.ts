import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  IdempotencyConflictError,
  immutableContext,
  opaqueId,
  opaqueTenantId,
  payloadHash,
  ProvisioningFailedError,
  sessionIdHash,
  TenantAccessDeniedError,
  type Membership,
  type ProvisioningJob,
  type Session,
  type SubjectId,
  type Tenant,
  type TenantContext,
  type TenantDatabaseLocation,
  type TenantId,
  type TenantProvisioningTarget,
  type TenantStatus,
  type SessionId,
} from '@opslog/domain-tenants';
import { DataSource, MoreThan, type DataSourceOptions, type Repository } from 'typeorm';
import {
  CONTROL_PLANE_MIGRATION_VERSION,
  CreateTenancyControlPlane2026100400010,
  CreateTenantDatabase2026100400020,
  TENANT_DATABASE_MIGRATION_VERSION,
} from './migrations.js';
import {
  CONTROL_PLANE_ENTITIES,
  MembershipProjectionEntity,
  ProvisioningJobEntity,
  TenantDataRecordEntity,
  TenantDatabaseLocationEntity,
  TenantEntity,
  TenantSessionEntity,
  TENANT_DATA_ENTITIES,
} from './entities.js';
import { isTrustedContext, markTrustedContext } from './trusted-context.js';

export interface ControlPlaneDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export interface TenantDatabaseHost {
  readonly host: string;
  readonly port: number;
}

export interface ResolvedTenantCredentials {
  readonly tenantId: TenantId;
  readonly databaseName: string;
  readonly username: string;
  readonly password: string;
  readonly secretVersion: number;
}

export interface TenantCredentialResolver {
  resolve(credentialRef: string, secretVersion: number): Promise<ResolvedTenantCredentials>;
}

export interface ProvisioningEvidence {
  readonly tenantId: TenantId;
  readonly databaseName: string;
  readonly credentialRef: string;
  readonly migrationVersion: string;
  readonly runtimeRoleVerified: boolean;
  readonly isolationProbeVerified: boolean;
  readonly verifiedAt: Date;
}

export interface FencedTenantProvisioningTarget extends TenantProvisioningTarget {
  readonly attempt: number;
  readonly leaseOwner: string;
}

export interface TenantProvisioningBackend {
  createIsolatedDatabase(target: FencedTenantProvisioningTarget): Promise<void>;
  createLeastPrivilegeRuntimeCredential(target: FencedTenantProvisioningTarget): Promise<void>;
  runTenantMigrations(target: FencedTenantProvisioningTarget): Promise<string>;
  verifyRuntimeRole(target: FencedTenantProvisioningTarget): Promise<boolean>;
  verifyCrossTenantIsolation(target: FencedTenantProvisioningTarget): Promise<boolean>;
  rollback(target: FencedTenantProvisioningTarget): Promise<void>;
}

export class VerifiedTenantProvisioningAdapter {
  constructor(private readonly backend: TenantProvisioningBackend) {}

  async provision(target: FencedTenantProvisioningTarget): Promise<ProvisioningEvidence> {
    await this.backend.createIsolatedDatabase(target);
    await this.backend.createLeastPrivilegeRuntimeCredential(target);
    const migrationVersion = await this.backend.runTenantMigrations(target);
    const runtimeRoleVerified = await this.backend.verifyRuntimeRole(target);
    const isolationProbeVerified = await this.backend.verifyCrossTenantIsolation(target);
    return {
      tenantId: target.tenantId,
      databaseName: target.databaseName,
      credentialRef: target.credentialRef,
      migrationVersion,
      runtimeRoleVerified,
      isolationProbeVerified,
      verifiedAt: new Date(),
    };
  }

  rollback(target: FencedTenantProvisioningTarget): Promise<void> {
    return this.backend.rollback(target);
  }
}

export interface TenantStore {
  getTenant(id: TenantId): Promise<Tenant | undefined>;
  getMembership(tenantId: TenantId, subject: SubjectId): Promise<Membership | undefined>;
  getSession(id: SessionId): Promise<Session | undefined>;
  getLocation(id: TenantId): Promise<TenantDatabaseLocation | undefined>;
  getJob(tenantId: TenantId, idempotencyKey: string): Promise<ProvisioningJob | undefined>;
  projectMembership(
    tenantId: TenantId,
    subjectId: SubjectId,
    version: number,
    status: Membership['status'],
  ): Promise<Membership>;
  saveSession(session: Session): Promise<void>;
  setTenantStatus(tenantId: TenantId, status: TenantStatus): Promise<void>;
}

export interface TenantProvisioner {
  createAndProvision(
    request: { readonly name: string },
    idempotencyKey: string,
    adapter: VerifiedTenantProvisioningAdapter,
  ): Promise<Tenant>;
}

export interface UntrustedRequest {
  readonly sessionId: SessionId;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly query?: unknown;
}

export function createControlPlaneDataSource(config: ControlPlaneDatabaseConfig): DataSource {
  if (!/^opslog_control_[a-z0-9_]+$/i.test(config.username))
    throw new Error('Control-plane DataSource requires its restricted runtime account');
  return new DataSource({
    type: 'mysql',
    ...config,
    entities: [...CONTROL_PLANE_ENTITIES],
    migrations: [CreateTenancyControlPlane2026100400010],
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'all',
    logging: false,
    timezone: 'Z',
    charset: 'utf8mb4',
  });
}

export interface TenantDataSourcePoolOptions {
  readonly maxDataSources?: number;
  readonly maxActiveLeases?: number;
  readonly maxQueuedAcquires?: number;
  readonly acquireTimeoutMs?: number;
  readonly maxConnectionsPerDataSource?: number;
}

export interface TenantDataSourceLease {
  readonly dataSource: DataSource;
  release(): Promise<void>;
}

export class TenantDataSourceCapacityError extends Error {
  constructor() {
    super('tenant data source capacity is temporarily exhausted');
    this.name = 'TenantDataSourceCapacityError';
  }
}

type TenantDataSourceEntry = {
  readonly key: string;
  readonly tenantId: TenantId;
  readonly secretVersion: number;
  readonly databaseName: string;
  readonly credentialRef: string;
  readonly passwordFingerprint: string;
  readonly dataSource: DataSource;
  readonly ready: Promise<DataSource>;
  leases: number;
  lastUsedAt: number;
};

type DisposableEntry = Pick<TenantDataSourceEntry, 'dataSource' | 'ready'>;

type LeaseWaiter = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_PROVISIONING_ATTEMPTS = 5;

type TenantDataSourceCreator = (options: DataSourceOptions) => DataSource;

const DEFAULT_TENANT_DATA_SOURCE_POOL: Required<TenantDataSourcePoolOptions> = {
  maxDataSources: 16,
  maxActiveLeases: 64,
  maxQueuedAcquires: 128,
  acquireTimeoutMs: 5_000,
  maxConnectionsPerDataSource: 4,
};

export class TenantDataSourceFactory {
  private readonly entries = new Map<string, TenantDataSourceEntry>();
  private readonly waiters: LeaseWaiter[] = [];
  private readonly limits: Required<TenantDataSourcePoolOptions>;
  private poolLock: Promise<void> = Promise.resolve();
  private activeLeases = 0;
  private closed = false;

  constructor(
    private readonly host: TenantDatabaseHost,
    private readonly credentials: TenantCredentialResolver,
    options: TenantDataSourcePoolOptions = {},
    private readonly createDataSource: TenantDataSourceCreator = (dataSourceOptions) =>
      new DataSource(dataSourceOptions),
  ) {
    this.limits = { ...DEFAULT_TENANT_DATA_SOURCE_POOL, ...options };
    if (
      !Number.isSafeInteger(this.limits.maxDataSources) ||
      this.limits.maxDataSources < 1 ||
      !Number.isSafeInteger(this.limits.maxActiveLeases) ||
      this.limits.maxActiveLeases < 1 ||
      !Number.isSafeInteger(this.limits.maxQueuedAcquires) ||
      this.limits.maxQueuedAcquires < 0 ||
      !Number.isSafeInteger(this.limits.acquireTimeoutMs) ||
      this.limits.acquireTimeoutMs < 1 ||
      !Number.isSafeInteger(this.limits.maxConnectionsPerDataSource) ||
      this.limits.maxConnectionsPerDataSource < 1
    )
      throw new Error('invalid tenant data source pool limits');
  }

  get poolSize(): number {
    return this.entries.size;
  }

  get activeLeaseCount(): number {
    return this.activeLeases;
  }

  get queuedAcquireCount(): number {
    return this.waiters.length;
  }

  private async withPoolLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.poolLock;
    let unlock!: () => void;
    this.poolLock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }

  /**
   * Runs `operation` under the pool lock and disposes any entries it unlinked only after the lock is
   * released, so a slow or hung `destroy()` never blocks acquires and releases of other tenants.
   */
  private async withPoolLockDisposing<T>(
    operation: (doomed: DisposableEntry[]) => T | Promise<T>,
  ): Promise<T> {
    const doomed: DisposableEntry[] = [];
    try {
      return await this.withPoolLock(() => operation(doomed));
    } finally {
      await Promise.allSettled(doomed.map((entry) => this.disposeEntry(entry)));
    }
  }

  private assertEntryMatches(
    entry: TenantDataSourceEntry,
    context: TenantContext,
    databaseName: string,
    credentialRef: string,
  ): void {
    if (
      entry.tenantId !== context.tenantId ||
      entry.secretVersion !== context.database.secretVersion ||
      entry.databaseName !== databaseName ||
      entry.credentialRef !== credentialRef
    )
      throw new TenantAccessDeniedError();
  }

  async acquire(context: TenantContext): Promise<TenantDataSourceLease> {
    // Only contexts issued by TenantContextResolver are accepted; a shape-compatible object is not enough.
    if (!isTrustedContext(context)) throw new TenantAccessDeniedError();
    await this.reserveLeaseSlot();
    try {
      const location = context.database;
      if (
        location.tenantId !== context.tenantId ||
        location.secretVersion < 1 ||
        !location.runtimeRoleVerified ||
        !location.isolationProbeVerified ||
        location.migrationVersion !== TENANT_DATABASE_MIGRATION_VERSION
      )
        throw new TenantAccessDeniedError();

      const key = `${context.tenantId}:${location.secretVersion}`;
      let entry = await this.withPoolLock(() => {
        if (this.closed) throw new TenantDataSourceCapacityError();
        const cached = this.entries.get(key);
        if (!cached) return undefined;
        this.assertEntryMatches(cached, context, location.databaseName, location.credentialRef);
        cached.leases += 1;
        cached.lastUsedAt = Date.now();
        return cached;
      });

      if (!entry) {
        const resolved = await this.credentials.resolve(
          location.credentialRef,
          location.secretVersion,
        );
        if (
          resolved.tenantId !== context.tenantId ||
          resolved.databaseName !== location.databaseName ||
          resolved.secretVersion !== location.secretVersion ||
          !resolved.username ||
          !/^opslog_u_[a-z0-9_]+$/i.test(resolved.username) ||
          !resolved.password
        )
          throw new TenantAccessDeniedError();

        entry = await this.withPoolLockDisposing((doomed) => {
          if (this.closed) throw new TenantDataSourceCapacityError();

          // The entry is inserted under the lock before initialize() is awaited, so
          // same-key cold acquires share its in-flight promise and count toward capacity.
          const concurrent = this.entries.get(key);
          if (concurrent) {
            this.assertEntryMatches(
              concurrent,
              context,
              location.databaseName,
              location.credentialRef,
            );
            if (concurrent.passwordFingerprint !== fingerprintPassword(resolved.password))
              throw new TenantAccessDeniedError();
            concurrent.leases += 1;
            concurrent.lastUsedAt = Date.now();
            return concurrent;
          }

          this.evictOlderTenantVersions(context.tenantId, location.secretVersion, doomed);
          this.makeRoom(doomed);
          const dataSource = this.createDataSource({
            type: 'mysql',
            host: this.host.host,
            port: this.host.port,
            database: location.databaseName,
            username: resolved.username,
            password: resolved.password,
            entities: [...TENANT_DATA_ENTITIES],
            migrations: [CreateTenantDatabase2026100400020],
            synchronize: false,
            migrationsRun: false,
            logging: false,
            timezone: 'Z',
            charset: 'utf8mb4',
            extra: { connectionLimit: this.limits.maxConnectionsPerDataSource },
          });
          let ready: Promise<DataSource>;
          try {
            ready = dataSource.initialize();
          } catch (error) {
            doomed.push({ dataSource, ready: Promise.resolve(dataSource) });
            throw error;
          }
          const created: TenantDataSourceEntry = {
            key,
            tenantId: context.tenantId,
            secretVersion: location.secretVersion,
            databaseName: location.databaseName,
            credentialRef: location.credentialRef,
            passwordFingerprint: fingerprintPassword(resolved.password),
            dataSource,
            ready,
            leases: 1,
            lastUsedAt: Date.now(),
          };
          this.entries.set(key, created);
          return created;
        });
      }

      try {
        await entry.ready;
      } catch (error) {
        await this.withPoolLockDisposing((doomed) => {
          entry!.leases = Math.max(0, entry!.leases - 1);
          if (entry!.leases === 0) {
            if (this.entries.get(entry!.key) === entry) this.entries.delete(entry!.key);
            doomed.push(entry!);
          }
        });
        throw error;
      }
      return this.createLease(entry);
    } catch (error) {
      this.releaseLeaseSlot();
      throw error;
    }
  }

  async evictTenant(tenantId: TenantId): Promise<void> {
    await this.withPoolLockDisposing((doomed) => {
      const tenantEntries = [...this.entries.values()].filter(
        (entry) => entry.tenantId === tenantId,
      );
      if (tenantEntries.some((entry) => entry.leases > 0))
        throw new TenantDataSourceCapacityError();
      for (const entry of tenantEntries) this.unlinkEntry(entry, doomed);
    });
  }

  async close(): Promise<void> {
    await this.withPoolLockDisposing((doomed) => {
      if (this.activeLeases > 0) throw new TenantDataSourceCapacityError();
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new TenantDataSourceCapacityError());
      }
      for (const entry of [...this.entries.values()]) this.unlinkEntry(entry, doomed);
    });
  }

  private async reserveLeaseSlot(): Promise<void> {
    if (this.closed) throw new TenantDataSourceCapacityError();
    if (this.activeLeases < this.limits.maxActiveLeases) {
      this.activeLeases += 1;
      return;
    }
    if (this.waiters.length >= this.limits.maxQueuedAcquires)
      throw new TenantDataSourceCapacityError();
    await new Promise<void>((resolve, reject) => {
      const waiter: LeaseWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new TenantDataSourceCapacityError());
        }, this.limits.acquireTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private releaseLeaseSlot(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }
    this.activeLeases = Math.max(0, this.activeLeases - 1);
  }

  private makeRoom(doomed: DisposableEntry[]): void {
    if (this.entries.size < this.limits.maxDataSources) return;
    const idle = [...this.entries.values()]
      .filter((entry) => entry.leases === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!idle) throw new TenantDataSourceCapacityError();
    this.unlinkEntry(idle, doomed);
  }

  private evictOlderTenantVersions(
    tenantId: TenantId,
    secretVersion: number,
    doomed: DisposableEntry[],
  ): void {
    for (const entry of [...this.entries.values()])
      if (entry.tenantId === tenantId && entry.secretVersion < secretVersion && entry.leases === 0)
        this.unlinkEntry(entry, doomed);
  }

  /** Removes the entry from the pool synchronously (under the lock); disposal happens after unlock. */
  private unlinkEntry(entry: TenantDataSourceEntry, doomed: DisposableEntry[]): void {
    if (entry.leases > 0) throw new TenantDataSourceCapacityError();
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    doomed.push(entry);
  }

  private async disposeEntry(entry: DisposableEntry): Promise<void> {
    await entry.ready.catch(() => undefined);
    if (entry.dataSource.isInitialized) await entry.dataSource.destroy();
  }

  private createLease(entry: TenantDataSourceEntry): TenantDataSourceLease {
    let released = false;
    return Object.freeze({
      dataSource: entry.dataSource,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await this.withPoolLockDisposing((doomed) => {
            entry.leases = Math.max(0, entry.leases - 1);
            entry.lastUsedAt = Date.now();
            const hasNewerVersion = [...this.entries.values()].some(
              (candidate) =>
                candidate.tenantId === entry.tenantId &&
                candidate.secretVersion > entry.secretVersion,
            );
            if (entry.leases === 0 && hasNewerVersion) this.unlinkEntry(entry, doomed);
          });
        } finally {
          this.releaseLeaseSlot();
        }
      },
    });
  }
}

function fingerprintPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

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
          if (status === 'revoked' && current?.status !== 'revoked') {
            await manager
              .getRepository(TenantEntity)
              .increment({ id: tenantId }, 'authorizationVersion', 1);
          }
          return { tenantId, subjectId, version, status };
        });
      } catch (error) {
        if (!isDuplicateKey(error) || attempt === 2) throw error;
      }
    }
    throw new Error('membership projection retry exhausted');
  }

  async createAndProvision(
    request: { readonly name: string },
    idempotencyKey: string,
    adapter: VerifiedTenantProvisioningAdapter,
  ): Promise<Tenant> {
    const name = request.name.trim();
    if (!name || name.length > 160 || !idempotencyKey.trim() || idempotencyKey.length > 255)
      throw new Error('invalid provisioning request');
    const hash = payloadHash({ name });
    const target = await this.ensureProvisioningRecord(name, idempotencyKey, hash);
    const owner = opaqueId();
    const claim = await this.claimJob(target, hash, owner);
    if (claim.kind === 'succeeded') return claim.tenant;
    if (claim.kind === 'exhausted') throw new ProvisioningFailedError('ATTEMPTS_EXHAUSTED');
    if (claim.kind === 'busy') return this.waitForProvisioning(target, hash, adapter);
    return this.runProvisioning(this.fencedTarget(target, claim.attempt, owner), hash, adapter);
  }

  private async ensureProvisioningRecord(
    name: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<TenantProvisioningTarget> {
    const jobs = this.dataSource.getRepository(ProvisioningJobEntity);
    const existing = await jobs.findOneBy({ idempotencyKey });
    if (existing) {
      if (existing.payloadHash !== hash) throw new IdempotencyConflictError();
      const tenant = await this.dataSource
        .getRepository(TenantEntity)
        .findOneBy({ id: existing.tenantId });
      if (!tenant) throw new ProvisioningFailedError();
      return this.target(existing.tenantId);
    }
    const id = opaqueTenantId();
    const now = new Date();
    const location: TenantProvisioningTarget = {
      tenantId: id,
      databaseName: `opslog_t_${id.replaceAll('-', '')}`,
      credentialRef: `tenant/${opaqueId()}/runtime`,
      secretVersion: 1,
    };
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(TenantEntity).insert({
          id,
          name,
          status: 'provisioning',
          authorizationVersion: 1,
          createdAt: now,
        });
        await manager.getRepository(TenantDatabaseLocationEntity).insert({
          ...location,
          migrationVersion: null,
          runtimeRoleVerified: false,
          isolationProbeVerified: false,
          verifiedAt: null,
        });
        await manager.getRepository(ProvisioningJobEntity).insert({
          id: opaqueId(),
          idempotencyKey,
          tenantId: id,
          payloadHash: hash,
          status: 'pending',
          attempt: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
        });
      });
      return location;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const raced = await jobs.findOneBy({ idempotencyKey });
      if (!raced || raced.payloadHash !== hash) throw new IdempotencyConflictError();
      return this.target(raced.tenantId);
    }
  }

  private async target(tenantId: string): Promise<TenantProvisioningTarget> {
    const location = await this.dataSource
      .getRepository(TenantDatabaseLocationEntity)
      .findOneBy({ tenantId });
    if (!location) throw new ProvisioningFailedError();
    return {
      tenantId: tenantId as TenantId,
      databaseName: location.databaseName,
      credentialRef: location.credentialRef,
      secretVersion: location.secretVersion,
    };
  }

  private fencedTarget(
    target: TenantProvisioningTarget,
    attempt: number,
    leaseOwner: string,
  ): FencedTenantProvisioningTarget {
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new ProvisioningFailedError();
    const tenantKey = target.tenantId.replaceAll('-', '');
    return {
      ...target,
      databaseName: `opslog_t_${tenantKey}_a${attempt}`,
      credentialRef: `tenant/${target.tenantId}/attempt/${attempt}/runtime`,
      secretVersion: attempt,
      attempt,
      leaseOwner,
    };
  }

  private async claimJob(
    target: TenantProvisioningTarget,
    hash: string,
    owner: string,
  ): Promise<
    | { kind: 'claimed'; attempt: number }
    | { kind: 'busy' }
    | { kind: 'exhausted' }
    | { kind: 'succeeded'; tenant: Tenant }
  > {
    return this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(ProvisioningJobEntity);
      const job = await jobs.findOne({
        where: { tenantId: target.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job || job.payloadHash !== hash) throw new IdempotencyConflictError();
      if (job.status === 'succeeded') {
        const row = await manager.getRepository(TenantEntity).findOneBy({ id: target.tenantId });
        if (row?.status === 'active') return { kind: 'succeeded', tenant: toTenant(row) };
        throw new ProvisioningFailedError();
      }
      const now = new Date();
      if (job.leaseOwner && job.leaseExpiresAt && job.leaseExpiresAt > now) return { kind: 'busy' };
      // Every attempt provisions its own database and credential; cap them so a persistent failure
      // cannot create unbounded orphaned resources.
      if (job.attempt >= MAX_PROVISIONING_ATTEMPTS) {
        job.status = 'failed';
        job.errorCode = 'ATTEMPTS_EXHAUSTED';
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.updatedAt = now;
        await jobs.save(job);
        await manager
          .getRepository(TenantEntity)
          .update({ id: target.tenantId }, { status: 'failed' });
        return { kind: 'exhausted' };
      }
      job.status = 'running';
      job.attempt += 1;
      job.leaseOwner = owner;
      job.leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
      job.errorCode = null;
      job.updatedAt = now;
      await jobs.save(job);
      await manager
        .getRepository(TenantEntity)
        .update({ id: target.tenantId }, { status: 'provisioning' });
      return { kind: 'claimed', attempt: job.attempt };
    });
  }

  private async waitForProvisioning(
    target: TenantProvisioningTarget,
    hash: string,
    adapter: VerifiedTenantProvisioningAdapter,
  ): Promise<Tenant> {
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline) {
      await delay(50);
      const job = await this.dataSource
        .getRepository(ProvisioningJobEntity)
        .findOneBy({ tenantId: target.tenantId });
      if (!job || job.payloadHash !== hash) throw new IdempotencyConflictError();
      if (job.status === 'succeeded') {
        const tenant = await this.getTenant(target.tenantId);
        if (tenant?.status === 'active') return tenant;
      }
      const owner = opaqueId();
      const result = await this.claimJob(target, hash, owner);
      if (result.kind === 'succeeded') return result.tenant;
      if (result.kind === 'exhausted') throw new ProvisioningFailedError('ATTEMPTS_EXHAUSTED');
      if (result.kind === 'claimed') {
        return this.runProvisioning(
          this.fencedTarget(target, result.attempt, owner),
          hash,
          adapter,
        );
      }
    }
    throw new ProvisioningFailedError();
  }

  private async attemptOutcome(
    target: TenantProvisioningTarget,
    attempt: number,
  ): Promise<
    { kind: 'succeeded'; tenant: Tenant } | { kind: 'not_succeeded' } | { kind: 'unknown' }
  > {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const job = await manager.getRepository(ProvisioningJobEntity).findOne({
          where: { tenantId: target.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (job?.attempt !== attempt || job.status !== 'succeeded')
          return { kind: 'not_succeeded' } as const;
        // This attempt's commit landed. Decide on job state alone: even if an operator has since
        // changed the tenant status, its database and credential are live and must not be dropped.
        const row = await manager.getRepository(TenantEntity).findOneBy({ id: target.tenantId });
        return row?.status === 'active'
          ? ({ kind: 'succeeded', tenant: toTenant(row) } as const)
          : ({ kind: 'unknown' } as const);
      });
    } catch {
      return { kind: 'unknown' };
    }
  }

  private async runProvisioning(
    target: FencedTenantProvisioningTarget,
    hash: string,
    adapter: VerifiedTenantProvisioningAdapter,
  ): Promise<Tenant> {
    const { leaseOwner: owner, attempt } = target;
    const timer = setInterval(
      () => {
        void this.dataSource
          .getRepository(ProvisioningJobEntity)
          .update(
            {
              tenantId: target.tenantId,
              leaseOwner: owner,
              attempt,
              status: 'running',
              leaseExpiresAt: MoreThan(new Date()),
            },
            { leaseExpiresAt: new Date(Date.now() + this.leaseMs), updatedAt: new Date() },
          )
          .catch(() => undefined);
      },
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    );
    timer.unref();
    try {
      const evidence = await adapter.provision(target);
      if (!isVerifiableEvidence(target, evidence)) throw new ProvisioningFailedError();
      const tenant = await this.dataSource.transaction(async (manager) => {
        const jobs = manager.getRepository(ProvisioningJobEntity);
        const job = await jobs.findOne({
          where: { tenantId: target.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !job ||
          job.leaseOwner !== owner ||
          job.attempt !== attempt ||
          !job.leaseExpiresAt ||
          job.leaseExpiresAt.getTime() <= Date.now() ||
          job.payloadHash !== hash ||
          job.status !== 'running'
        )
          throw new ProvisioningFailedError();
        const location = manager.getRepository(TenantDatabaseLocationEntity);
        await location.update(
          { tenantId: target.tenantId },
          {
            databaseName: target.databaseName,
            credentialRef: target.credentialRef,
            secretVersion: target.secretVersion,
            migrationVersion: evidence.migrationVersion,
            runtimeRoleVerified: evidence.runtimeRoleVerified,
            isolationProbeVerified: evidence.isolationProbeVerified,
            verifiedAt: evidence.verifiedAt,
          },
        );
        await manager
          .getRepository(TenantEntity)
          .update({ id: target.tenantId, status: 'provisioning' }, { status: 'active' });
        job.status = 'succeeded';
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.updatedAt = new Date();
        await jobs.save(job);
        const row = await manager.getRepository(TenantEntity).findOneBy({ id: target.tenantId });
        if (!row || row.status !== 'active') throw new ProvisioningFailedError();
        return toTenant(row);
      });
      return tenant;
    } catch (error) {
      const failureCode = safeFailureCode(error);
      // The commit may have succeeded with a lost acknowledgement. Never roll back an attempt that is
      // already `succeeded`, and never roll back when its state cannot be proven.
      const outcome = await this.attemptOutcome(target, attempt);
      if (outcome.kind === 'succeeded') return outcome.tenant;
      if (outcome.kind === 'unknown') throw new ProvisioningFailedError(failureCode);
      try {
        await adapter.rollback(target);
      } catch {
        // Failed cleanup leaves the tenant inaccessible; each attempt uses its own opaque database and
        // credential names, so a retry never reuses or deletes these resources.
      }
      await this.dataSource.transaction(async (manager) => {
        const jobs = manager.getRepository(ProvisioningJobEntity);
        const job = await jobs.findOne({
          where: { tenantId: target.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (job?.leaseOwner === owner && job.attempt === attempt && job.status === 'running') {
          job.status = 'failed';
          job.errorCode = failureCode;
          job.leaseOwner = null;
          job.leaseExpiresAt = null;
          job.updatedAt = new Date();
          await jobs.save(job);
          await manager
            .getRepository(TenantEntity)
            .update({ id: target.tenantId }, { status: 'failed' });
          await manager.getRepository(TenantDatabaseLocationEntity).update(
            { tenantId: target.tenantId },
            {
              migrationVersion: null,
              runtimeRoleVerified: false,
              isolationProbeVerified: false,
              verifiedAt: null,
            },
          );
        }
      });
      throw new ProvisioningFailedError(failureCode);
    } finally {
      clearInterval(timer);
    }
  }
}

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
      session.authorizationVersion !== tenant.authorizationVersion ||
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
        authorizationVersion: tenant.authorizationVersion,
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

export async function runControlPlaneMigrations(dataSource: DataSource): Promise<void> {
  assertSafeMigrations(dataSource.options);
  await dataSource.runMigrations({ transaction: 'all' });
}

export async function runTenantMigrations(dataSource: DataSource): Promise<void> {
  assertSafeMigrations(dataSource.options);
  await dataSource.runMigrations({ transaction: 'all' });
}

function assertSafeMigrations(options: DataSourceOptions): void {
  if (options.synchronize === true || options.migrationsRun === true)
    throw new Error('Automatic schema synchronization and startup migrations are forbidden');
}

function toTenant(row: TenantEntity): Tenant {
  return Object.freeze({
    id: row.id as TenantId,
    name: row.name,
    status: row.status,
    authorizationVersion: Number(row.authorizationVersion),
    createdAt: row.createdAt,
  });
}
function toMembership(row: MembershipProjectionEntity): Membership {
  return Object.freeze({
    tenantId: row.tenantId as TenantId,
    subjectId: row.subjectId as SubjectId,
    status: row.status,
    version: Number(row.version),
  });
}
function toSession(row: TenantSessionEntity, id: SessionId): Session {
  return Object.freeze({
    id,
    tenantId: row.tenantId as TenantId,
    subjectId: row.subjectId as SubjectId,
    authorizationVersion: Number(row.authorizationVersion),
    expiresAt: row.expiresAt,
    revoked: row.revoked,
  });
}
function toLocation(row: TenantDatabaseLocationEntity): TenantDatabaseLocation {
  if (
    !row.migrationVersion ||
    !row.verifiedAt ||
    !row.runtimeRoleVerified ||
    !row.isolationProbeVerified
  )
    throw new TenantAccessDeniedError();
  return Object.freeze({
    tenantId: row.tenantId as TenantId,
    databaseName: row.databaseName,
    credentialRef: row.credentialRef,
    secretVersion: Number(row.secretVersion),
    migrationVersion: row.migrationVersion,
    runtimeRoleVerified: row.runtimeRoleVerified,
    isolationProbeVerified: row.isolationProbeVerified,
    verifiedAt: row.verifiedAt,
  });
}
function toJob(row: ProvisioningJobEntity): ProvisioningJob {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenantId as TenantId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    status: row.status,
    attempt: Number(row.attempt),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  });
}
function isDuplicateKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    driverError?: { code?: unknown; errno?: unknown };
  };
  return (
    candidate.code === 'ER_DUP_ENTRY' ||
    candidate.code === '23505' ||
    candidate.errno === 1062 ||
    candidate.driverError?.code === 'ER_DUP_ENTRY' ||
    candidate.driverError?.errno === 1062
  );
}
function safeFailureCode(error: unknown): string {
  if (error instanceof ProvisioningFailedError) return error.reasonCode;
  if (typeof error !== 'object' || error === null) return 'PROVISIONING_FAILED';
  const candidate = error as { name?: unknown; driverError?: { code?: unknown }; code?: unknown };
  const raw = candidate.driverError?.code ?? candidate.code ?? candidate.name;
  if (typeof raw !== 'string') return 'PROVISIONING_FAILED';
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return normalized.length > 0 && normalized.length <= 64 ? normalized : 'PROVISIONING_FAILED';
}
function isVerifiableEvidence(
  target: TenantProvisioningTarget,
  evidence: ProvisioningEvidence,
): boolean {
  return (
    evidence.tenantId === target.tenantId &&
    evidence.databaseName === target.databaseName &&
    evidence.credentialRef === target.credentialRef &&
    evidence.migrationVersion === TENANT_DATABASE_MIGRATION_VERSION &&
    evidence.runtimeRoleVerified &&
    evidence.isolationProbeVerified &&
    Number.isFinite(evidence.verifiedAt.getTime())
  );
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { CONTROL_PLANE_MIGRATION_VERSION, TENANT_DATABASE_MIGRATION_VERSION };
