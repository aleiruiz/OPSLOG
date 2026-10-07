import { createHash } from 'node:crypto';
import { TenantAccessDeniedError, type TenantContext, type TenantId } from '@opslog/domain-tenants';
import { DataSource, type DataSourceOptions } from 'typeorm';
import {
  CreateTenantDatabase2026100400020,
  TENANT_DATABASE_MIGRATION_VERSION,
} from './migrations.js';
import { TENANT_DATA_ENTITIES } from './entities.js';
import { isTrustedContext } from './trusted-context.js';

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
