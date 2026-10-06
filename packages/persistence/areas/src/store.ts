import 'reflect-metadata';
import { In, IsNull, type DataSource, type EntityManager } from 'typeorm';
import {
  AreaError,
  isAreaAction,
  isAreaField,
  nameKey,
  type Area,
  type AreaConflictField,
  type AreaFilter,
  type AreaHistoryEntry,
  type AreaHistorySlice,
  type AreaNode,
  type AreaSlice,
  type AreaStore,
  type AreaTx,
  type AreaWindow,
} from '../../../domain/areas/src/index.js';
import { AREAS_RUNTIME_ACCOUNT } from './data-source.js';
import {
  AreaEntity,
  AreaHistoryEntity,
  AreaLockEntity,
  AreaResponsibleEntity,
} from './entities.js';
import {
  AreaStoreError,
  isDuplicateKey,
  isLockContention,
  sanitizeStoreError,
  type AreaStoreErrorCode,
} from './errors.js';

/** Structured, PII-free report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: AreaStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmAreaStoreOptions {
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}

const toArea = (row: AreaEntity, responsibles: readonly AreaResponsibleEntity[]): Area => ({
  id: row.id,
  tenantId: row.tenantId,
  name: row.name,
  code: row.code,
  parentId: row.parentId,
  depth: row.depth,
  active: row.active === true,
  responsibleIds: responsibles.map((responsible) => responsible.userId).sort(),
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deactivatedAt: row.deactivatedAt === null ? null : row.deactivatedAt.toISOString(),
});

const toEntry = (row: AreaHistoryEntity): AreaHistoryEntry => {
  const fields = row.changedFields === '' ? [] : row.changedFields.split(',');
  if (!isAreaAction(row.action) || !fields.every(isAreaField))
    throw new AreaStoreError('integrity');
  return {
    id: row.id,
    tenantId: row.tenantId,
    areaId: row.areaId,
    action: row.action,
    fields,
    fromParentId: row.fromParentId,
    toParentId: row.toParentId,
    actorId: row.actorId,
    version: row.version,
    at: row.at.toISOString(),
  };
};

/** Columns that can change after creation (never the tenant, the id or `createdAt`). */
const mutableColumns = (area: Area) => ({
  name: area.name,
  nameKey: nameKey(area.name),
  code: area.code,
  parentId: area.parentId,
  parentKey: area.parentId ?? '',
  depth: area.depth,
  active: area.active,
  version: area.version,
  updatedAt: new Date(area.updatedAt),
  deactivatedAt: area.deactivatedAt === null ? null : new Date(area.deactivatedAt),
});

const toAreaRow = (area: Area): AreaEntity => ({
  tenantId: area.tenantId,
  id: area.id,
  createdAt: new Date(area.createdAt),
  ...mutableColumns(area),
});

const toEntryRow = (entry: AreaHistoryEntry): AreaHistoryEntity => ({
  tenantId: entry.tenantId,
  id: entry.id,
  areaId: entry.areaId,
  version: entry.version,
  action: entry.action,
  changedFields: entry.fields.join(','),
  fromParentId: entry.fromParentId,
  toParentId: entry.toParentId,
  actorId: entry.actorId,
  at: new Date(entry.at),
});

const parentCondition = (parentId: string | null) => (parentId === null ? IsNull() : parentId);

/**
 * Persistent TypeORM/MySQL implementation of the `AreaStore` port.
 *
 * - Every statement names `company_id`: the primary key, every unique key and every filter start
 *   with it, so a row of another company is unreachable, not merely hidden.
 * - Hierarchy changes run in one READ COMMITTED transaction that first takes the company's lock row
 *   (`SELECT ... FOR UPDATE` on `opslog_area_locks`). The cycle and depth rules span several rows,
 *   so two writers that are each valid alone are serialized and the second one re-reads the first
 *   one's result. The lock is per company: other companies are never blocked.
 * - A change and its history row are written together; `replace` is a conditional UPDATE on
 *   `(company_id, id, version)`.
 * - Driver errors never leave this class: duplicates become `AreaError('duplicate', field)`,
 *   everything else the sanitized `AreaStoreError` (no SQL, parameters, names or codes).
 */
export class TypeOrmAreaStore implements AreaStore {
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmAreaStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Area store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !AREAS_RUNTIME_ACCOUNT.test(username))
      throw new Error('Area store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof AreaStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  /** Statements outside a transaction (autocommit). */
  private async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.fail(operation, error);
    }
  }

  /** Takes the company's lock row, creating it on first use. Must run inside the transaction. */
  private async lockTenant(manager: EntityManager, tenantId: string): Promise<void> {
    const locks = manager.getRepository(AreaLockEntity);
    const lock = () => locks.findOne({ where: { tenantId }, lock: { mode: 'pessimistic_write' } });
    if (await lock()) return;
    try {
      await locks.insert({ tenantId });
      return;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    // Another writer created it first: wait for its transaction and lock the committed row.
    if (!(await lock())) throw new AreaStoreError('internal');
  }

  public async transaction<T>(tenantId: string, work: (tx: AreaTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', async (manager) => {
          await this.lockTenant(manager, tenantId);
          return work(this.tx(manager, tenantId));
        });
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        throw this.fail('transaction', error);
      }
    }
  }

  /** Names the unique key that was hit. Safe under the tenant lock: nobody else is writing. */
  private async conflictField(
    manager: EntityManager,
    candidate: Area,
  ): Promise<AreaConflictField | undefined> {
    const repository = manager.getRepository(AreaEntity);
    const taken = async (where: { parentKey: string; nameKey: string } | { code: string }) =>
      (await repository.find({ where: { tenantId: candidate.tenantId, ...where } })).some(
        (row) => row.id !== candidate.id,
      );
    if (await taken({ parentKey: candidate.parentId ?? '', nameKey: nameKey(candidate.name) }))
      return 'name';
    if (candidate.code !== null && (await taken({ code: candidate.code }))) return 'code';
    return undefined;
  }

  private async responsiblesOf(
    manager: EntityManager,
    tenantId: string,
    areaId: string,
  ): Promise<AreaResponsibleEntity[]> {
    return manager.getRepository(AreaResponsibleEntity).find({ where: { tenantId, areaId } });
  }

  private tx(manager: EntityManager, tenantId: string): AreaTx {
    const areas = manager.getRepository(AreaEntity);
    const rowsFor = (area: Area, userIds: readonly string[]): AreaResponsibleEntity[] =>
      userIds.map((userId) => ({ tenantId: area.tenantId, areaId: area.id, userId }));
    return {
      find: async (id) => {
        const row = await areas.findOneBy({ tenantId, id });
        return row ? toArea(row, await this.responsiblesOf(manager, tenantId, id)) : null;
      },
      children: async (parentId): Promise<readonly AreaNode[]> =>
        (await areas.find({ where: { tenantId, parentId: parentCondition(parentId) } })).map(
          (row) => ({ id: row.id, depth: row.depth, active: row.active === true }),
        ),
      insert: async (area, entry) => {
        try {
          await areas.insert(toAreaRow(area));
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          throw new AreaError('duplicate', await this.conflictField(manager, area));
        }
        const responsibles = manager.getRepository(AreaResponsibleEntity);
        for (const row of rowsFor(area, area.responsibleIds)) await responsibles.insert(row);
        await manager.getRepository(AreaHistoryEntity).insert(toEntryRow(entry));
      },
      replace: async (next, expectedVersion, entry) => {
        let affected: number | undefined;
        try {
          ({ affected } = await areas.update(
            { tenantId: next.tenantId, id: next.id, version: expectedVersion },
            mutableColumns(next),
          ));
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          throw new AreaError('duplicate', await this.conflictField(manager, next));
        }
        if (affected !== 1) return false;
        const responsibles = manager.getRepository(AreaResponsibleEntity);
        const stored = await this.responsiblesOf(manager, next.tenantId, next.id);
        for (const row of stored)
          if (!next.responsibleIds.includes(row.userId)) await responsibles.delete(row);
        const kept = new Set(stored.map((row) => row.userId));
        for (const row of rowsFor(
          next,
          next.responsibleIds.filter((userId) => !kept.has(userId)),
        ))
          await responsibles.insert(row);
        await manager.getRepository(AreaHistoryEntity).insert(toEntryRow(entry));
        return true;
      },
      setDepth: async (id, depth) => {
        await areas.update({ tenantId, id }, { depth });
      },
    };
  }

  public async find(tenantId: string, id: string): Promise<Area | null> {
    return this.single('find', async () => {
      const row = await this.dataSource.getRepository(AreaEntity).findOneBy({ tenantId, id });
      if (!row) return null;
      const responsibles = await this.dataSource
        .getRepository(AreaResponsibleEntity)
        .find({ where: { tenantId, areaId: id } });
      return toArea(row, responsibles);
    });
  }

  public async list(tenantId: string, filter: AreaFilter, window: AreaWindow): Promise<AreaSlice> {
    return this.single('list', async () => {
      const [rows, total] = await this.dataSource.getRepository(AreaEntity).findAndCount({
        where: {
          tenantId,
          ...(filter.parentId === undefined ? {} : { parentId: parentCondition(filter.parentId) }),
          ...(filter.includeInactive ? {} : { active: true }),
        },
        order: { nameKey: 'ASC', id: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      const responsibles =
        rows.length === 0
          ? []
          : await this.dataSource.getRepository(AreaResponsibleEntity).find({
              where: { tenantId, areaId: In(rows.map((row) => row.id)) },
            });
      return {
        items: rows.map((row) =>
          toArea(
            row,
            responsibles.filter((responsible) => responsible.areaId === row.id),
          ),
        ),
        total,
      };
    });
  }

  public async history(
    tenantId: string,
    areaId: string,
    window: AreaWindow,
  ): Promise<AreaHistorySlice> {
    return this.single('history', async () => {
      const [rows, total] = await this.dataSource.getRepository(AreaHistoryEntity).findAndCount({
        where: { tenantId, areaId },
        order: { version: 'DESC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toEntry), total };
    });
  }
}
