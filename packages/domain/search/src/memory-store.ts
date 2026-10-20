import { entityKey, type SearchStore } from './ports.js';
import {
  EXACT_KEY_KINDS,
  MIN_CONTAINS_LENGTH,
  type EntityProjection,
  type EntityRef,
  type SearchEntry,
  type SearchStoreGroup,
  type SearchStoreHit,
  type SearchStoreQuery,
} from './types.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** In-memory double of the projection: the same matching, ranking and grouping as the MySQL store. */
export class InMemorySearchStore implements SearchStore {
  private readonly byTenant = new Map<string, Map<string, EntityProjection>>();

  private rows(tenantId: string): Map<string, EntityProjection> {
    let rows = this.byTenant.get(tenantId);
    if (!rows) {
      rows = new Map();
      this.byTenant.set(tenantId, rows);
    }
    return rows;
  }

  public async fingerprints(tenantId: string): Promise<ReadonlyMap<string, string>> {
    return new Map(
      [...this.rows(tenantId)].map(([key, projection]) => [key, projection.fingerprint]),
    );
  }

  public async apply(
    tenantId: string,
    changes: {
      readonly upserts: readonly EntityProjection[];
      readonly removals: readonly EntityRef[];
    },
  ): Promise<void> {
    const rows = this.rows(tenantId);
    for (const removal of changes.removals)
      rows.delete(entityKey(removal.entityType, removal.entityId));
    for (const upsert of changes.upserts) {
      if (upsert.entries.some((entry) => entry.tenantId !== tenantId))
        throw new Error('search entry of another company');
      rows.set(entityKey(upsert.entityType, upsert.entityId), structuredClone(upsert));
    }
  }

  /** Rank 0 exact, 1 prefix, 2 contains; `null` when the row does not match. */
  private rank(entry: SearchEntry, query: SearchStoreQuery): number | null {
    if (EXACT_KEY_KINDS.includes(entry.keyKind))
      return query.exactKeys.includes(entry.normalized) ? 0 : null;
    if (entry.normalized === query.term) return 0;
    if (entry.normalized.startsWith(query.term)) return 1;
    return query.term.length >= MIN_CONTAINS_LENGTH && entry.normalized.includes(query.term)
      ? 2
      : null;
  }

  public async search(query: SearchStoreQuery): Promise<readonly SearchStoreGroup[]> {
    const rows = this.rows(query.tenantId);
    return query.types.map((type) => {
      const best = new Map<string, { rank: number; hit: SearchStoreHit }>();
      for (const projection of rows.values()) {
        if (projection.entityType !== type.entityType) continue;
        for (const entry of projection.entries) {
          if (!type.permissions.includes(entry.requiredPermission)) continue;
          const rank = this.rank(entry, query);
          if (rank === null) continue;
          const current = best.get(entry.entityId);
          if (!current || rank < current.rank)
            best.set(entry.entityId, {
              rank,
              hit: { entityId: entry.entityId, areaId: entry.areaId, display: entry.display },
            });
        }
      }
      const ordered = [...best.values()].sort(
        (a, b) =>
          a.rank - b.rank ||
          compare(a.hit.display, b.hit.display) ||
          compare(a.hit.entityId, b.hit.entityId),
      );
      return {
        entityType: type.entityType,
        total: ordered.length,
        hits: ordered.slice(0, query.limit).map((item) => item.hit),
      };
    });
  }
}
