import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { ImportJob, ImportListQuery } from '../app/types';
import { useSession } from '../auth/session';
import {
  ImportListView,
  noFilters,
  type ImportFilters,
  type ImportListData,
} from './ImportListView';

const PAGE_SIZE = 25;

/** Import history screen. Requires `view`; "Nueva importación" needs `create`. */
export function ImportsScreen() {
  const { ports, can, markExpired } = useSession();
  const [filters, setFilters] = React.useState<ImportFilters>(noFilters);
  const queryKey = JSON.stringify([filters.entity, filters.status]);
  const query = (cursor?: string): ImportListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.entity === '' ? {} : { entity: filters.entity }),
    ...(filters.status === '' ? {} : { status: filters.status }),
  });

  const first = useResource(() => ports.imports.list(query()), [ports, queryKey]);
  const [extra, setExtra] = React.useState<{ items: ImportJob[]; cursor: string | null } | null>(
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
    const result = await ports.imports.list(query(cursor));
    setLoadingMore(false);
    // The list was reloaded or its filters changed while this page was loading: it belongs to an older list.
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más importaciones.', severity: 'error' });
  };

  const state: ResourceState<ImportListData> =
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
    <ImportListView
      state={state}
      filters={filters}
      can={can}
      filtersActive={filters.entity !== '' || filters.status !== ''}
      loadingMore={loadingMore}
      notice={notice}
      onFiltersChange={setFilters}
      onClear={() => setFilters(noFilters)}
      onRetry={first.reload}
      onLoadMore={(cursor) => void loadMore(cursor)}
    />
  );
}
