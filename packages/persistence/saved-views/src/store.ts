import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { QueryFailedError, type DataSource } from 'typeorm';
import type {
  CreateResult,
  ReplaceResult,
  SavedViewRecord,
  SavedViewStore,
} from '../../../domain/saved-views/src/index.js';
import { SAVED_VIEWS_RUNTIME_ACCOUNT } from './data-source.js';
import { ListColumnsEntity, SavedViewEntity } from './entities.js';

const isDuplicate = (error: unknown): boolean =>
  error instanceof QueryFailedError &&
  (error.driverError as { code?: unknown } | undefined)?.code === 'ER_DUP_ENTRY';

const parseObject = (text: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, string>)
    : {};
};

const parseList = (text: string | null): string[] | null => {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : null;
};

function toRecord(row: SavedViewEntity): SavedViewRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    module: row.module,
    name: row.name,
    nameKey: row.nameKey,
    filters: parseObject(row.filters),
    sort:
      row.sortField !== null && (row.sortDirection === 'asc' || row.sortDirection === 'desc')
        ? { field: row.sortField, direction: row.sortDirection }
        : null,
    columns: parseList(row.columns),
    shared: row.shared,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRow(view: SavedViewRecord): SavedViewEntity {
  return {
    tenantId: view.tenantId,
    id: view.id,
    ownerId: view.ownerId,
    module: view.module,
    name: view.name,
    nameKey: view.nameKey,
    filters: JSON.stringify(view.filters),
    sortField: view.sort?.field ?? null,
    sortDirection: view.sort?.direction ?? null,
    columns: view.columns === null ? null : JSON.stringify(view.columns),
    shared: view.shared,
    version: view.version,
    createdAt: new Date(view.createdAt),
    updatedAt: new Date(view.updatedAt),
  };
}

/** TypeORM adapter of the saved views. Every statement names the company; none crosses it. */
export class TypeOrmSavedViewStore implements SavedViewStore {
  public constructor(private readonly dataSource: DataSource) {
    const username = (dataSource.options as { username?: string }).username ?? '';
    if (!SAVED_VIEWS_RUNTIME_ACCOUNT.test(username))
      throw new Error('Saved views store requires its restricted runtime account');
  }

  public async list(tenantId: string, module: string, memberId: string) {
    const repository = this.dataSource.getRepository(SavedViewEntity);
    const rows = await repository.find({
      where: [
        { tenantId, module, ownerId: memberId },
        { tenantId, module, shared: true },
      ],
      order: { nameKey: 'ASC', id: 'ASC' },
    });
    return rows.map(toRecord);
  }

  public async get(tenantId: string, id: string) {
    const row = await this.dataSource.getRepository(SavedViewEntity).findOneBy({ tenantId, id });
    return row ? toRecord(row) : null;
  }

  /**
   * Creates the view unless the owner already has `max` in the list. Creations of one owner and list
   * are serialized with a named lock held on the transaction's own connection (a gap lock would
   * deadlock concurrent creations), so two requests cannot both pass the limit.
   */
  public async create(view: SavedViewRecord, max: number): Promise<CreateResult> {
    const lock = `opslog:views:${createHash('sha256')
      .update([view.tenantId, view.ownerId, view.module].join('\u0000'))
      .digest('hex')
      .slice(0, 40)}`;
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      const [granted] = (await runner.query('SELECT GET_LOCK(?, 10) AS granted', [lock])) as {
        granted: number | string | null;
      }[];
      if (Number(granted?.granted) !== 1) throw new Error('saved view creation is busy');
      locked = true;
      await runner.startTransaction();
      try {
        const owned = await runner.manager.count(SavedViewEntity, {
          where: { tenantId: view.tenantId, ownerId: view.ownerId, module: view.module },
        });
        if (owned >= max) {
          await runner.rollbackTransaction();
          return 'limit';
        }
        await runner.manager.insert(SavedViewEntity, toRow(view));
        await runner.commitTransaction();
        return 'created';
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        if (isDuplicate(error)) return 'duplicate';
        throw error;
      }
    } finally {
      // The lock belongs to this connection: it must be released before the connection goes back to the pool.
      if (locked) await runner.query('SELECT RELEASE_LOCK(?)', [lock]);
      await runner.release();
    }
  }

  public async replace(next: SavedViewRecord, expectedVersion: number): Promise<ReplaceResult> {
    const { tenantId, id, ...row } = toRow(next);
    // Owner, module and creation date never change.
    const changes: Partial<typeof row> = { ...row };
    delete changes.ownerId;
    delete changes.module;
    delete changes.createdAt;
    try {
      const result = await this.dataSource
        .getRepository(SavedViewEntity)
        .update({ tenantId, id, version: expectedVersion }, changes);
      return result.affected === 1 ? 'replaced' : 'stale';
    } catch (error) {
      if (isDuplicate(error)) return 'duplicate';
      throw error;
    }
  }

  public async remove(tenantId: string, id: string) {
    const result = await this.dataSource.getRepository(SavedViewEntity).delete({ tenantId, id });
    return result.affected === 1;
  }

  public async getColumns(tenantId: string, memberId: string, module: string) {
    const row = await this.dataSource
      .getRepository(ListColumnsEntity)
      .findOneBy({ tenantId, memberId, module });
    return row ? parseList(row.columns) : null;
  }

  public async saveColumns(
    tenantId: string,
    memberId: string,
    module: string,
    columns: readonly string[] | null,
    at: string,
  ): Promise<void> {
    await this.dataSource.getRepository(ListColumnsEntity).upsert(
      {
        tenantId,
        memberId,
        module,
        columns: columns === null ? null : JSON.stringify(columns),
        updatedAt: new Date(at),
      },
      ['tenantId', 'memberId', 'module'],
    );
  }
}
