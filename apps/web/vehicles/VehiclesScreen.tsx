import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { Vehicle, VehicleListQuery } from '../app/types';
import { useSession } from '../auth/session';
import { OPAQUE_ID } from './rules';
import {
  noFilters,
  VehicleListView,
  type VehicleFilters,
  type VehicleListData,
} from './VehicleListView';

const PAGE_SIZE = 25;

/** Vehicle list screen. Requires `view`; "Nuevo vehículo" and "Editar" depend on `create` and `edit`. */
export function VehiclesScreen() {
  const { ports, can, markExpired } = useSession();
  const [filters, setFilters] = React.useState<VehicleFilters>(noFilters);
  const area = filters.areaId.trim();
  const areaValid = area === '' || OPAQUE_ID.test(area);
  const appliedArea = areaValid ? area : '';
  const queryKey = JSON.stringify([filters.status, appliedArea, filters.includeArchived]);
  const query = (cursor?: string): VehicleListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(appliedArea === '' ? {} : { areaId: appliedArea }),
    ...(filters.includeArchived ? { includeArchived: 'true' as const } : {}),
  });

  const first = useResource(() => ports.vehicles.list(query()), [ports, queryKey]);
  const [extra, setExtra] = React.useState<{ items: Vehicle[]; cursor: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; severity: 'error' } | null>(null);
  // Bumped whenever the first page or the filters change: a page requested before that is stale.
  const generation = React.useRef(0);
  React.useEffect(() => {
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
      areaError={
        areaValid
          ? undefined
          : 'Usa letras, números, guion o guion bajo (hasta 64). El filtro no se aplica hasta que sea válido.'
      }
      can={can}
      filtersActive={filters.status !== '' || appliedArea !== '' || filters.includeArchived}
      loadingMore={loadingMore}
      notice={notice}
      onFiltersChange={setFilters}
      onClear={() => setFilters(noFilters)}
      onRetry={first.reload}
      onLoadMore={(cursor) => void loadMore(cursor)}
    />
  );
}
