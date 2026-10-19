import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { Vehicle, VehicleListQuery } from '../app/types';
import { loadAllAreas } from '../areas/loadAreas';
import { useSession } from '../auth/session';
import { pickFilters } from '../features/search/views/urlState';
import { useListState } from '../features/search/views/useListState';
import { VehicleListView, type VehicleFilters, type VehicleListData } from './VehicleListView';

const RANGE_KEYS = ['yearFrom', 'yearTo', 'kmFrom', 'kmTo'] as const;

/** Vehicle list screen. Requires `view`; "Nuevo vehículo" and "Editar" depend on `create` and `edit`. */
export function VehiclesScreen() {
  const { ports, can, markExpired } = useSession();
  const list = useListState('vehicles', { views: ports.views, can, onExpired: markExpired });
  const url = list.url.filters;
  // Filters, order and size live in the address (keys of BFF_LIST_CATALOG), so a link reproduces the list.
  const filters: VehicleFilters = {
    status: (url.status ?? '') as VehicleFilters['status'],
    areaId: url.areaId ?? '',
    includeArchived: url.includeArchived === 'true',
  };
  const setFilters = (next: VehicleFilters) =>
    list.setFilters({
      ...pickFilters(url, RANGE_KEYS),
      ...(next.status === '' ? {} : { status: next.status }),
      ...(next.areaId === '' ? {} : { areaId: next.areaId }),
      ...(next.includeArchived ? { includeArchived: 'true' } : {}),
    });
  const queryKey = list.key;
  const query = (cursor?: string): VehicleListQuery => ({
    limit: list.url.limit as 25 | 50 | 100,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.areaId === '' ? {} : { areaId: filters.areaId }),
    ...(filters.includeArchived ? { includeArchived: 'true' as const } : {}),
    ...Object.fromEntries(RANGE_KEYS.flatMap((key) => (url[key] ? [[key, Number(url[key])]] : []))),
  });

  const first = useResource(() => ports.vehicles.list(query()), [ports, queryKey]);
  // The structure only names the areas and fills the filter: the list works without it (ids are shown instead).
  const catalog = useResource(() => loadAllAreas(ports.areas, true), [ports]);
  const [extra, setExtra] = React.useState<{ items: Vehicle[]; cursor: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; severity: 'error' } | null>(null);
  // Bumped whenever the first page or the filters change: a page requested before that is stale.
  const generation = React.useRef(0);
  // A layout effect: the reset must land before the page can be clicked, or a "load more"
  // started right after the first page arrives is discarded as stale.
  React.useLayoutEffect(() => {
    generation.current += 1;
    setExtra(null);
    setNotice(null);
  }, [queryKey, first.state]);

  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setNotice(null);
    const requested = generation.current;
    const result = await ports.vehicles.list(query(cursor));
    setLoadingMore(false);
    // The list was reloaded or its filters changed while this page was loading: it belongs to an older list.
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más vehículos.', severity: 'error' });
  };

  const state: ResourceState<VehicleListData> =
    first.state.status === 'ready'
      ? {
          status: 'ready',
          data: {
            items: [...first.state.data.items, ...(extra?.items ?? [])],
            total: first.state.data.total,
            nextCursor: extra ? extra.cursor : first.state.data.nextCursor,
          },
        }
      : first.state;

  return (
    <VehicleListView
      state={state}
      filters={filters}
      areas={catalog.state.status === 'ready' ? catalog.state.data.areas : []}
      can={can}
      list={list}
      filtersActive={Object.keys(url).length > 0}
      loadingMore={loadingMore}
      notice={notice}
      onFiltersChange={setFilters}
      onClear={list.clear}
      onRetry={first.reload}
      onLoadMore={(cursor) => void loadMore(cursor)}
    />
  );
}
