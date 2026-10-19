import type { BffRouteDefinition } from './shared.js';

/** Entities the global search finds (FR-160), in the order the groups are shown. */
export const BFF_SEARCH_TYPES = ['vehicle', 'driver', 'dispatcher', 'incident', 'policy'] as const;
export type BffSearchType = (typeof BFF_SEARCH_TYPES)[number];

/** Most hits the server returns for each type; the total counts all of them. */
export const BFF_SEARCH_PER_TYPE = 10;
export const BFF_SEARCH_MAX_TERM = 64;

/** One result: the text to show and the app path of the detail of that entity. */
export interface BffSearchHit {
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

/**
 * The hits of one type. A type the reader cannot see is absent from the answer, with no count.
 */
export interface BffSearchGroup {
  readonly type: BffSearchType;
  readonly total: number;
  readonly items: readonly BffSearchHit[];
}

export interface BffSearchResult {
  readonly groups: readonly BffSearchGroup[];
}

/** `types` is a comma-separated subset of `BFF_SEARCH_TYPES`; omitted means every type. */
export interface BffSearchQuery {
  readonly q: string;
  readonly types?: string;
}

export interface SearchRouteTypes {
  'search.query': { query: BffSearchQuery; response: BffSearchResult };
}

export const SEARCH_ROUTES = {
  'search.query': { method: 'GET', path: ['api', 'v1', 'search'], kind: 'session', status: 200 },
} as const satisfies Record<keyof SearchRouteTypes, BffRouteDefinition>;
