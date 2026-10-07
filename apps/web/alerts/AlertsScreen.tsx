import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { Alert, AlertListQuery } from '../app/types';
import { loadVehicleOptions, type VehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import { AlertListView, noFilters, type AlertFilters, type AlertListData } from './AlertListView';

const PAGE_SIZE = 25;

/** Expiry alerts screen. Requires `view`; alerts are derived by the server and cannot be changed here. */
export function AlertsScreen() {
  const { ports, markExpired } = useSession();
  const [filters, setFilters] = React.useState<AlertFilters>(noFilters);
  const queryKey = JSON.stringify([filters.source, filters.severity, filters.vehicleId]);
  const query = (cursor?: string): AlertListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.source === '' ? {} : { source: filters.source }),
    ...(filters.severity === '' ? {} : { severity: filters.severity }),
    ...(filters.vehicleId === '' ? {} : { vehicleId: filters.vehicleId }),
  });

  const first = useResource(() => ports.alerts.list(query()), [ports, queryKey]);
  // Vehicle names and the vehicle filter: best effort, the list works without them.
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

  const [extra, setExtra] = React.useState<{ items: Alert[]; cursor: string | null } | null>(null);
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
    const result = await ports.alerts.list(query(cursor));
    setLoadingMore(false);
    // The list was reloaded or its filters changed while this page was loading: it belongs to an older list.
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más alertas.', severity: 'error' });
  };

  const state: ResourceState<AlertListData> =
    first.state.status === 'ready'
      ? {
          status: 'ready',
          data: {
            items: [...first.state.data.items, ...(extra?.items ?? [])],
            total: first.state.data.total,
            nextCursor: extra ? extra.cursor : first.state.data.nextCursor,
            asOf: first.state.data.asOf,
            windowDays: first.state.data.windowDays,
          },
        }
      : first.state;

  return (
    <AlertListView
      state={state}
      filters={filters}
      vehicles={vehicles}
      filtersActive={filters.source !== '' || filters.severity !== '' || filters.vehicleId !== ''}
      loadingMore={loadingMore}
      notice={notice}
      onFiltersChange={setFilters}
      onClear={() => setFilters(noFilters)}
      onRetry={first.reload}
      onLoadMore={(cursor) => void loadMore(cursor)}
    />
  );
}
