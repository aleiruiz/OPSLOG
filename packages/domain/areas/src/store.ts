import type { Area, AreaHistoryEntry } from './types.js';
import { AreaError } from './errors.js';
import type { AreaConflictField } from './errors.js';
import { nameKey } from './validation.js';
import type {
  AreaFilter,
  AreaHistorySlice,
  AreaSlice,
  AreaStore,
  AreaTx,
  AreaWindow,
} from './ports.js';

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/**
 * In-memory double of the port. Transactions of one tenant run one after another and are rolled
 * back on failure, like the MySQL adapter; the other methods are synchronous inside.
 */
export class InMemoryAreaStore implements AreaStore {
  private areas = new Map<string, Area>();
  private entries: AreaHistoryEntry[] = [];
  private readonly tails = new Map<string, Promise<unknown>>();

  private conflict(candidate: Area): AreaConflictField | null {
    for (const other of this.areas.values()) {
      if (other.tenantId !== candidate.tenantId || other.id === candidate.id) continue;
      if (other.parentId === candidate.parentId && nameKey(other.name) === nameKey(candidate.name))
        return 'name';
      if (candidate.code !== null && other.code === candidate.code) return 'code';
    }
    return null;
  }

  public async transaction<T>(tenantId: string, work: (tx: AreaTx) => Promise<T>): Promise<T> {
    const previous = this.tails.get(tenantId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const snapshot = { areas: new Map(this.areas), entries: [...this.entries] };
        try {
          return await work(this.tx(tenantId));
        } catch (error) {
          this.areas = snapshot.areas;
          this.entries = snapshot.entries;
          throw error;
        }
      });
    const tail = run.catch(() => undefined);
    this.tails.set(tenantId, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(tenantId) === tail) this.tails.delete(tenantId);
    }
  }

  private tx(tenantId: string): AreaTx {
    return {
      find: async (id) => this.find(tenantId, id),
      children: async (parentId) =>
        [...this.areas.values()]
          .filter((area) => area.tenantId === tenantId && area.parentId === parentId)
          .map(({ id, depth, active }) => ({ id, depth, active })),
      insert: async (area, entry) => {
        if (area.tenantId !== tenantId || this.areas.has(storeKey(tenantId, area.id)))
          throw new AreaError('duplicate');
        const field = this.conflict(area);
        if (field) throw new AreaError('duplicate', field);
        this.areas.set(storeKey(tenantId, area.id), structuredClone(area));
        this.entries.push(structuredClone(entry));
      },
      replace: async (next, expectedVersion, entry) => {
        const key = storeKey(tenantId, next.id);
        const current = this.areas.get(key);
        if (next.tenantId !== tenantId || current?.version !== expectedVersion) return false;
        const field = this.conflict(next);
        if (field) throw new AreaError('duplicate', field);
        this.areas.set(key, structuredClone(next));
        this.entries.push(structuredClone(entry));
        return true;
      },
      setDepth: async (id, depth) => {
        const key = storeKey(tenantId, id);
        const current = this.areas.get(key);
        if (current) this.areas.set(key, { ...current, depth });
      },
    };
  }

  public async find(tenantId: string, id: string): Promise<Area | null> {
    const found = this.areas.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async list(tenantId: string, filter: AreaFilter, window: AreaWindow): Promise<AreaSlice> {
    const matching = [...this.areas.values()]
      .filter(
        (area) =>
          area.tenantId === tenantId &&
          (filter.includeInactive || area.active) &&
          (filter.parentId === undefined || area.parentId === filter.parentId),
      )
      .sort((a, b) => compareKeys(nameKey(a.name), nameKey(b.name)) || compareKeys(a.id, b.id));
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((a) => structuredClone(a)),
      total: matching.length,
    };
  }

  public async history(
    tenantId: string,
    areaId: string,
    window: AreaWindow,
  ): Promise<AreaHistorySlice> {
    const matching = this.entries
      .filter((entry) => entry.tenantId === tenantId && entry.areaId === areaId)
      .sort((a, b) => b.version - a.version);
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((e) => structuredClone(e)),
      total: matching.length,
    };
  }
}
