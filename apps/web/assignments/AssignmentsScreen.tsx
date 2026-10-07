import React from 'react';
import { loadDriverOptions, type DriverOptions } from '../app/driverOptions';
import { useResource, type ResourceState } from '../app/resource';
import { useRouter } from '../app/router';
import type { AssignmentListQuery, VehicleAssignment } from '../app/types';
import { loadVehicleOptions, type VehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import {
  AssignmentListView,
  noFilters,
  type AssignmentFilters,
  type AssignmentListData,
} from './AssignmentListView';
import { OPAQUE_ID } from './rules';

const PAGE_SIZE = 25;

/** Filters a link from another screen can carry: `?vehiculo=<id>&conductor=<id>&estado=vigente|finalizada`. */
export function filtersFromSearch(search: URLSearchParams): AssignmentFilters {
  const id = (name: string) => {
    const value = search.get(name) ?? '';
    return OPAQUE_ID.test(value) ? value : '';
  };
  const state = search.get('estado');
  return {
    ...noFilters,
    vehicleId: id('vehiculo'),
    employeeId: id('conductor'),
    status: state === 'vigente' ? 'current' : state === 'finalizada' ? 'ended' : '',
  };
}

/** Assignment list screen. Requires `view`; "Nueva asignación" needs `create` and "Cerrar" needs `edit`. */
export function AssignmentsScreen() {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const [filters, setFilters] = React.useState<AssignmentFilters>(() =>
    filtersFromSearch(router.search),
  );
  const queryKey = JSON.stringify([
    filters.status,
    filters.vehicleId,
    filters.employeeId,
    filters.type,
  ]);
  const query = (cursor?: string): AssignmentListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.vehicleId === '' ? {} : { vehicleId: filters.vehicleId }),
    ...(filters.employeeId === '' ? {} : { employeeId: filters.employeeId }),
    ...(filters.type === '' ? {} : { type: filters.type }),
  });

  const first = useResource(() => ports.assignments.list(query()), [ports, queryKey]);
  // Names and filter choices: best effort, the list works without them.
  const [vehicles, setVehicles] = React.useState<VehicleOptions | null>(null);
  const [drivers, setDrivers] = React.useState<DriverOptions | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void loadVehicleOptions(ports.vehicles).then((result) => {
      if (!cancelled && result.ok) setVehicles(result.value);
    });
    void loadDriverOptions(ports.employees).then((result) => {
      if (!cancelled && result.ok) setDrivers(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [ports]);

  const [extra, setExtra] = React.useState<{
    items: VehicleAssignment[];
    cursor: string | null;
  } | null>(null);
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
    const result = await ports.assignments.list(query(cursor));
    setLoadingMore(false);
    // The list was reloaded or its filters changed while this page was loading: it belongs to an older list.
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más asignaciones.', severity: 'error' });
  };

  const state: ResourceState<AssignmentListData> =
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
    <AssignmentListView
      state={state}
      filters={filters}
      vehicles={vehicles}
      drivers={drivers}
      can={can}
      filtersActive={
        filters.status !== '' ||
        filters.vehicleId !== '' ||
        filters.employeeId !== '' ||
        filters.type !== ''
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
