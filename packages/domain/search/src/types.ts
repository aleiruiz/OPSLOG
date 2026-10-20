/** Entities the global search finds (FR-160). Work orders have no folio yet and wait for a decision. */
export const SEARCH_ENTITY_TYPES = [
  'vehicle',
  'driver',
  'dispatcher',
  'incident',
  'policy',
] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const isSearchEntityType = (value: unknown): value is SearchEntityType =>
  typeof value === 'string' && (SEARCH_ENTITY_TYPES as readonly string[]).includes(value);

/**
 * What a projection row is keyed by. `identification_hmac` and `license` hold the blind index of the
 * encrypted value (SPECS D23), never the value: they only match exactly.
 */
export const SEARCH_KEY_KINDS = [
  'economic_number',
  'plate',
  'vin',
  'name',
  'employee_number',
  'license',
  'folio',
  'claim_number',
  'policy_number',
  'identification_hmac',
] as const;
export type SearchKeyKind = (typeof SEARCH_KEY_KINDS)[number];

/** Key kinds that hold a blind index and are matched only exactly, and only with `view_pii`. */
export const EXACT_KEY_KINDS: readonly SearchKeyKind[] = ['license', 'identification_hmac'];

/** Permissions a projection row can require from the reader. */
export type SearchPermission = 'view' | 'view_pii' | 'incidents:view';

export const MAX_TERM_LENGTH = 64;
export const MIN_CONTAINS_LENGTH = 3;
export const DEFAULT_PER_TYPE_LIMIT = 10;

export interface SearchEntry {
  readonly tenantId: string;
  readonly entityType: SearchEntityType;
  readonly entityId: string;
  readonly areaId: string | null;
  readonly keyKind: SearchKeyKind;
  /** The key after `normalizeKey`; for the exact kinds, the blind index. */
  readonly normalized: string;
  /** Text shown for the hit. It never carries sensitive personal data. */
  readonly display: string;
  readonly requiredPermission: SearchPermission;
  readonly updatedAt: string;
}

/** Every row of one entity and the fingerprint that tells whether it changed since it was written. */
export interface EntityProjection {
  readonly entityType: SearchEntityType;
  readonly entityId: string;
  readonly fingerprint: string;
  readonly entries: readonly SearchEntry[];
}

export interface EntityRef {
  readonly entityType: SearchEntityType;
  readonly entityId: string;
}

/** What the store is asked for one type. The store never sees what the reader may not search. */
export interface SearchTypeQuery {
  readonly entityType: SearchEntityType;
  readonly permissions: readonly SearchPermission[];
}

export interface SearchStoreQuery {
  readonly tenantId: string;
  /** Normalized term: prefix always, contains from `MIN_CONTAINS_LENGTH` characters. */
  readonly term: string;
  /** Blind indexes of the term as an identification or license; empty without `view_pii`. */
  readonly exactKeys: readonly string[];
  readonly types: readonly SearchTypeQuery[];
  readonly limit: number;
}

export interface SearchStoreHit {
  readonly entityId: string;
  readonly areaId: string | null;
  readonly display: string;
}
export interface SearchStoreGroup {
  readonly entityType: SearchEntityType;
  readonly total: number;
  readonly hits: readonly SearchStoreHit[];
}

export interface SearchHit {
  readonly id: string;
  readonly label: string;
  /** Path of the detail screen of the entity. */
  readonly href: string;
}
export interface SearchGroup {
  readonly type: SearchEntityType;
  readonly total: number;
  readonly items: readonly SearchHit[];
}
export interface SearchResult {
  readonly groups: readonly SearchGroup[];
}

export interface Searcher {
  readonly permissions: ReadonlySet<string>;
  /** A member linked to a mechanic never searches incidents (SPECS D9, fails closed). */
  readonly mechanicLinked: boolean;
}
