import 'reflect-metadata';
import { type DataSource, type EntityManager } from 'typeorm';
import { MembershipEntity, TenantLockEntity } from './entities.js';
import {
  IdentityStoreError,
  LastAdministratorError,
  isDuplicateKey,
  isLockContention,
  sanitizeStoreError,
} from './errors.js';
import { ADMIN_ROLE } from './role-model.js';
import type { StoreErrorEvent } from './store-types.js';
import { lock } from './store-support.js';

/**
 * Dependencies and shared transaction plumbing of `TypeOrmIdentityStore`. The operation modules
 * (`*-ops.ts`) receive it as an explicit parameter instead of reading `this`.
 */
export class IdentityStoreCore {
  public constructor(
    public readonly dataSource: DataSource,
    public readonly now: () => Date,
    private readonly maxAttempts: number,
    private readonly onError: ((event: StoreErrorEvent) => void) | undefined,
  ) {}

  public fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof IdentityStoreError)
      this.onError?.({
        operation,
        code: safe.code,
        errno: safe.errno,
        origin: safe.origin,
        frames: safe.frames,
      });
    return safe;
  }

  /** Single-statement (autocommit) work with sanitized errors. */
  public async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.fail(operation, error);
    }
  }

  /** One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. */
  public async transaction<T>(
    operation: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        throw this.fail(operation, error);
      }
    }
  }

  /** Creates the tenant's lock row if missing (autocommit, outside the transaction that will lock it). */
  public async ensureTenantLock(operation: string, tenantId: string): Promise<void> {
    await this.single(operation, async () => {
      const locks = this.dataSource.getRepository(TenantLockEntity);
      if (await locks.findOneBy({ tenantId })) return;
      try {
        await locks.insert({ tenantId, createdAt: this.now() });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    });
  }

  public async lockTenant(manager: EntityManager, tenantId: string): Promise<void> {
    const row = await manager
      .getRepository(TenantLockEntity)
      .findOne({ where: { tenantId }, lock });
    if (!row) throw new IdentityStoreError('integrity');
  }

  /** Counts active administrators under row locks; throws unless the tenant keeps at least one other. */
  public async assertAnotherAdmin(manager: EntityManager, tenantId: string): Promise<void> {
    const admins = await manager
      .getRepository(MembershipEntity)
      .find({ where: { tenantId, role: ADMIN_ROLE, status: 'active' }, lock });
    if (admins.length <= 1) throw new LastAdministratorError();
  }
}
