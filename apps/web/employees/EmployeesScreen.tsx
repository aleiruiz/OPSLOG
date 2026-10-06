import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { Employee, EmployeeListQuery } from '../app/types';
import { loadAllAreas } from '../areas/loadAreas';
import { useSession } from '../auth/session';
import {
  EmployeeListView,
  noFilters,
  type EmployeeFilters,
  type EmployeeListData,
} from './EmployeeListView';

const PAGE_SIZE = 25;

/** Employee list screen. Requires `view`; "Nuevo empleado" and "Editar" depend on `create` and `edit`. */
export function EmployeesScreen() {
  const { ports, can, markExpired } = useSession();
  const [filters, setFilters] = React.useState<EmployeeFilters>(noFilters);
  const queryKey = JSON.stringify([
    filters.kind,
    filters.status,
    filters.areaId,
    filters.includeArchived,
  ]);
  const query = (cursor?: string): EmployeeListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.kind === '' ? {} : { kind: filters.kind }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.areaId === '' ? {} : { areaId: filters.areaId }),
    ...(filters.includeArchived ? { includeArchived: 'true' as const } : {}),
  });

  const first = useResource(() => ports.employees.list(query()), [ports, queryKey]);
  // The structure only names the areas and fills the filter: the list works without it (ids are shown instead).
  const catalog = useResource(() => loadAllAreas(ports.areas, true), [ports]);
  const [extra, setExtra] = React.useState<{ items: Employee[]; cursor: string | null } | null>(
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
    const result = await ports.employees.list(query(cursor));
    setLoadingMore(false);
    // The list was reloaded or its filters changed while this page was loading: it belongs to an older list.
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más empleados.', severity: 'error' });
  };

  const state: ResourceState<EmployeeListData> =
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
    <EmployeeListView
      state={state}
      filters={filters}
      areas={catalog.state.status === 'ready' ? catalog.state.data.areas : []}
      can={can}
      filtersActive={
        filters.kind !== '' ||
        filters.status !== '' ||
        filters.areaId !== '' ||
        filters.includeArchived
      }
      loadingMore={loadingMore}
      notice={notice}
      onFiltersChange={setFilters}
      onClear={() => setFilters(noFilters)}
      onRetry={first.reload}
      onLoadMore={(cursor) => void loadMore(cursor)}
    />
  );
}
