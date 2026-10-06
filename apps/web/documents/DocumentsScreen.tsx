import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { Document, DocumentListQuery } from '../app/types';
import { loadVehicleOptions, type VehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import {
  DocumentListView,
  noFilters,
  type DocumentFilters,
  type DocumentListData,
} from './DocumentListView';

const PAGE_SIZE = 25;

/** Document list screen. Requires `view`; "Nuevo documento", "Editar" and "Renovar" depend on `create` and `edit`. */
export function DocumentsScreen() {
  const { ports, can, markExpired } = useSession();
  const [filters, setFilters] = React.useState<DocumentFilters>(noFilters);
  const queryKey = JSON.stringify(filters);
  const query = (cursor?: string): DocumentListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.ownerType === '' ? {} : { ownerType: filters.ownerType }),
    ...(filters.ownerType === 'vehicle' && filters.vehicleId !== ''
      ? { ownerId: filters.vehicleId }
      : {}),
    ...(filters.typeCode === '' ? {} : { typeCode: filters.typeCode }),
    ...(filters.includeArchived ? { includeArchived: 'true' as const } : {}),
  });

  const first = useResource(() => ports.documents.list(query()), [ports, queryKey]);
  // Vehicle names and the owner filter: best effort, the list works without them.
  const [vehicles, setVehicles] = React.useState<VehicleOptions | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void loadVehicleOptions(ports.vehicles).then((result) => {
      if (!cancelled && result.ok) setVehicles(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [ports]);

  const [extra, setExtra] = React.useState<{ items: Document[]; cursor: string | null } | null>(
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
    const result = await ports.documents.list(query(cursor));
    setLoadingMore(false);
    // The list was reloaded or its filters changed while this page was loading: it belongs to an older list.
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más documentos.', severity: 'error' });
  };

  const state: ResourceState<DocumentListData> =
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
    <DocumentListView
      state={state}
      filters={filters}
      vehicles={vehicles}
      can={can}
      filtersActive={queryKey !== JSON.stringify(noFilters)}
      loadingMore={loadingMore}
      notice={notice}
      onFiltersChange={setFilters}
      onClear={() => setFilters(noFilters)}
      onRetry={first.reload}
      onLoadMore={(cursor) => void loadMore(cursor)}
    />
  );
}
