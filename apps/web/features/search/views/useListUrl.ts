import React from 'react';
import { listModuleSpec, type BffListModule, type BffViewSort } from '@opslog/contracts';
import { useRouter } from '../../../app/router';
import { listSearch, readListUrl, type CanUse, type ListFilters, type ListUrl } from './urlState';

export interface ListUrlControl {
  readonly url: ListUrl;
  /** Stable text of the address: changes exactly when the list must be requested again. */
  readonly key: string;
  /** Sets or clears (empty value) one filter; goes back to the first page. */
  readonly setFilter: (key: string, value: string) => void;
  readonly setFilters: (filters: ListFilters) => void;
  readonly setSort: (sort: BffViewSort | null) => void;
  readonly setLimit: (limit: number) => void;
  /** Replaces filters and order at once (applying a saved view). */
  readonly replace: (next: Pick<ListUrl, 'filters' | 'sort'>) => void;
  readonly clear: () => void;
}

/**
 * Filters, order and page size of a list live in the address (replace, so the back button leaves the
 * list). Everything read from it is validated against the module's allowlist and the reader's grants.
 */
export function useListUrl(module: BffListModule, can: CanUse): ListUrlControl {
  const router = useRouter();
  const path = listModuleSpec(module).path;
  const searchText = router.search.toString();
  const url = React.useMemo(
    () => readListUrl(module, new URLSearchParams(searchText), can),
    // `can` is stable for a session; the address is the real input.
    [module, searchText],
  );
  const go = (next: ListUrl) => router.navigate(`${path}${listSearch(next)}`, { replace: true });
  return {
    url,
    key: listSearch(url),
    setFilter: (key, value) => {
      const filters = { ...url.filters };
      if (value) filters[key] = value;
      else delete filters[key];
      go({ ...url, filters });
    },
    setFilters: (filters) => go({ ...url, filters }),
    setSort: (sort) => go({ ...url, sort }),
    setLimit: (limit) => go({ ...url, limit }),
    replace: (next) => go({ ...url, ...next }),
    clear: () => go({ ...url, filters: {} }),
  };
}
