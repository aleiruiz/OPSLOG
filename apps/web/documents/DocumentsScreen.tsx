import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { Document, DocumentListQuery } from '../app/types';
import { loadVehicleOptions, type VehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import { pickFilters } from '../features/search/views/urlState';
import { useListState } from '../features/search/views/useListState';
import { DocumentListView, type DocumentFilters, type DocumentListData } from './DocumentListView';

const RANGE_KEYS = ['expiresFrom', 'expiresTo'] as const;

/** Document list screen. Requires `view`; "Nuevo documento", "Editar" and "Renovar" depend on `create` and `edit`. */
export function DocumentsScreen() {
  const { ports, can, markExpired } = useSession();
  const list = useListState('documents', { views: ports.views, can, onExpired: markExpired });
  const url = list.url.filters;
  // Filters, order and size live in the address (keys of BFF_LIST_CATALOG), so a link reproduces the list.
  const filters: DocumentFilters = {
    status: (url.status ?? '') as DocumentFilters['status'],
    ownerType: (url.ownerType ?? '') as DocumentFilters['ownerType'],
    vehicleId: url.ownerType === 'vehicle' ? (url.ownerId ?? '') : '',
    typeCode: url.typeCode ?? '',
    includeArchived: url.includeArchived === 'true',
  };
  const setFilters = (next: DocumentFilters) => {
    // The owner filter of another kind (an employee, from a link) survives changes to the other filters.
    const ownerId =
      next.ownerType === 'vehicle'
        ? next.vehicleId
        : next.ownerType === url.ownerType
          ? (url.ownerId ?? '')
          : '';
    list.setFilters({
      ...pickFilters(url, RANGE_KEYS),
      ...(next.status === '' ? {} : { status: next.status }),
      ...(next.ownerType === '' ? {} : { ownerType: next.ownerType }),
      ...(next.ownerType !== '' && ownerId !== '' ? { ownerId } : {}),
      ...(next.typeCode === '' ? {} : { typeCode: next.typeCode }),
      ...(next.includeArchived ? { includeArchived: 'true' } : {}),
    });
  };
  const queryKey = list.key;
  const query = (cursor?: string): DocumentListQuery => ({
    limit: list.url.limit as 25 | 50 | 100,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(url.ownerType ? { ownerType: url.ownerType as 'vehicle' | 'employee' } : {}),
    ...(url.ownerType && url.ownerId ? { ownerId: url.ownerId } : {}),
    ...(url.typeCode ? { typeCode: url.typeCode } : {}),
    ...(url.includeArchived ? { includeArchived: 'true' as const } : {}),
    ...pickFilters(url, RANGE_KEYS),
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
