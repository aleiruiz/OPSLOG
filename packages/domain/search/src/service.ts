import { SearchError } from './errors.js';
import { searchTerm } from './normalize.js';
import type { SearchStore } from './ports.js';
import {
  DEFAULT_PER_TYPE_LIMIT,
  SEARCH_ENTITY_TYPES,
  isSearchEntityType,
  type SearchEntityType,
  type SearchGroup,
  type SearchPermission,
  type SearchResult,
  type Searcher,
  type SearchTypeQuery,
} from './types.js';

/** Where the detail of each entity opens in the web app. */
export function searchHref(type: SearchEntityType, id: string): string {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case 'vehicle':
      return `/flota/vehiculos/${encoded}`;
    case 'driver':
    case 'dispatcher':
      return `/plantilla/empleados/${encoded}`;
    case 'incident':
      return `/incidents/${encoded}`;
    case 'policy':
      return `/flota/seguros/${encoded}`;
  }
}

/** Blind indexes of a typed value as an identification or a license of the company. */
export type ExactKeys = (tenantId: string, raw: string) => Promise<readonly string[]>;

/** The rows of a type the reader may see, or `null` when the type is closed to them. */
export function typeAccess(type: SearchEntityType, who: Searcher): SearchTypeQuery | null {
  const can = (permission: string) => who.permissions.has(permission);
  // Same rule as the incidents module (`canView`): a mechanic scope narrows to nothing, except for
  // a member who manages cases (`incidents:edit`).
  if (type === 'incident')
    return can('incidents:view') && !(who.mechanicLinked && !can('incidents:edit'))
      ? { entityType: type, permissions: ['incidents:view'] }
      : null;
  if (!can('view')) return null;
  const permissions: SearchPermission[] = ['view'];
  if ((type === 'driver' || type === 'dispatcher') && can('view_pii')) permissions.push('view_pii');
  return { entityType: type, permissions };
}

export class SearchService {
  public constructor(
    private readonly store: SearchStore,
    private readonly exactKeys: ExactKeys,
  ) {}

  /**
   * Finds what the reader may see. A type they cannot see is absent from the answer, with no count,
   * so nothing tells them it exists. Personal identification only matches exactly.
   */
  public async search(
    tenantId: string,
    who: Searcher,
    q: unknown,
    types?: readonly unknown[],
  ): Promise<SearchResult> {
    if (typeof q !== 'string') throw new SearchError('invalid_input');
    if (types !== undefined && !types.every(isSearchEntityType))
      throw new SearchError('invalid_input');
    const wanted = new Set<SearchEntityType>(types ?? SEARCH_ENTITY_TYPES);
    const allowed = SEARCH_ENTITY_TYPES.filter((type) => wanted.has(type))
      .map((type) => typeAccess(type, who))
      .filter((access): access is SearchTypeQuery => access !== null);
    const term = searchTerm(q);
    if (term === null || allowed.length === 0)
      return { groups: allowed.map((a) => ({ type: a.entityType, total: 0, items: [] })) };
    const exactKeys = who.permissions.has('view_pii') ? await this.exactKeys(tenantId, q) : [];
    const found = await this.store.search({
      tenantId,
      term,
      exactKeys,
      types: allowed,
      limit: DEFAULT_PER_TYPE_LIMIT,
    });
    const byType = new Map(found.map((group) => [group.entityType, group]));
    const groups: SearchGroup[] = allowed.map(({ entityType }) => {
      const group = byType.get(entityType);
      return {
        type: entityType,
        total: group?.total ?? 0,
        items: (group?.hits ?? []).map((hit) => ({
          id: hit.entityId,
          label: hit.display,
          href: searchHref(entityType, hit.entityId),
        })),
      };
    });
    return { groups };
  }
}
