import {
  BFF_LIST_DEFAULT_LIMIT,
  BFF_LIST_LIMITS,
  isValidFilterValue,
  listModuleSpec,
  type BffListModule,
  type Permission,
  type BffViewSort,
} from '@opslog/contracts';

/**
 * The address of a list (MVP-SEARCH PR 2): the filters of `BFF_LIST_CATALOG` under their own key, plus
 * `limit` (page size) and `sort` (`campo` ascending, `-campo` descending). These keys are stable and
 * documented in docs/traceability/search.md: dashboards and links build the same addresses with `listLink`.
 */
export type ListFilters = Readonly<Record<string, string>>;

export interface ListUrl {
  readonly filters: ListFilters;
  readonly sort: BffViewSort | null;
  readonly limit: number;
}

export const NO_LIST_URL: ListUrl = { filters: {}, sort: null, limit: BFF_LIST_DEFAULT_LIMIT };

/** The reader's grants decide which gated filters (`view_costs`) the address may carry. */
export type CanUse = (permission: Permission) => boolean;

const allowed = (module: BffListModule, key: string, can: CanUse): boolean => {
  const filter = listModuleSpec(module).filters[key];
  return filter !== undefined && (filter.permission === undefined || can(filter.permission));
};

export function parseSort(module: BffListModule, text: string | null): BffViewSort | null {
  if (!text) return null;
  const direction = text.startsWith('-') ? 'desc' : 'asc';
  const field = text.replace(/^-/, '');
  return listModuleSpec(module).sorts.includes(field) ? { field, direction } : null;
}

export const sortText = (sort: BffViewSort | null): string =>
  sort ? `${sort.direction === 'desc' ? '-' : ''}${sort.field}` : '';

/** Reads an address defensively: unknown keys, invalid values and gated filters are ignored, never executed. */
export function readListUrl(module: BffListModule, search: URLSearchParams, can: CanUse): ListUrl {
  const spec = listModuleSpec(module).filters;
  const filters: Record<string, string> = {};
  for (const key of Object.keys(spec)) {
    const value = search.get(key);
    if (value && allowed(module, key, can) && isValidFilterValue(spec[key]!.spec, value))
      filters[key] = value;
  }
  const limit = Number(search.get('limit'));
  return {
    filters,
    sort: parseSort(module, search.get('sort')),
    limit: BFF_LIST_LIMITS.find((size) => size === limit) ?? BFF_LIST_DEFAULT_LIMIT,
  };
}

/** `?clave=valor`, without the defaults (empty filters, default size and order), or an empty string. */
export function listSearch(url: ListUrl): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(url.filters).sort()) params.set(key, url.filters[key]!);
  if (url.sort) params.set('sort', sortText(url.sort));
  if (url.limit !== BFF_LIST_DEFAULT_LIMIT) params.set('limit', String(url.limit));
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Link to a list with filters applied (drill-down from the dashboards). Keys outside the catalog and
 * values it would reject are left out, so a link never carries something the list ignores.
 */
export function listLink(
  module: BffListModule,
  filters: ListFilters,
  options: { readonly sort?: BffViewSort; readonly limit?: number } = {},
): string {
  const url = readListUrl(
    module,
    new URLSearchParams({
      ...filters,
      ...(options.sort ? { sort: sortText(options.sort) } : {}),
      ...(options.limit ? { limit: String(options.limit) } : {}),
    }),
    () => true,
  );
  return `${listModuleSpec(module).path}${listSearch(url)}`;
}

/** Whether the filters of the address differ from "no filter" (sort and size do not count). */
export const hasFilters = (url: ListUrl): boolean => Object.keys(url.filters).length > 0;

/** The filters whose keys are listed (the range filters a screen keeps apart from its select filters). */
export function pickFilters(filters: ListFilters, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => (filters[key] ? [[key, filters[key]]] : [])));
}
