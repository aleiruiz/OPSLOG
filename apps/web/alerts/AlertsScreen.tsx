import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { Alert, AlertListQuery } from '../app/types';
import { loadVehicleOptions, type VehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import { DirectoryProvider, type MaintenanceDirectory } from '../features/maintenance/directory';
import { MaintenanceAlertsPanel } from '../features/maintenance/MaintenanceAlertsPanel';
import { UiState } from '@opslog/ui';
import { AlertListView, noFilters, type AlertFilters, type AlertListData } from './AlertListView';
import { AlertStats } from './AlertStats';
import { loadAlertsSummary, type AlertsSummaryData } from './AlertsSummary';

const PAGE_SIZE = 25;
const emptyPage = {
  ok: true as const,
  value: {
    items: [],
    total: 0,
    nextCursor: null,
    asOf: '',
    windowDays: 0,
    sort: { field: 'dueOn', direction: 'asc' as const },
  },
};

/** Expiry alerts screen. Requires `view`; alerts are derived by the server and cannot be changed here. */
export function AlertsScreen() {
  const { ports, markExpired } = useSession();
  const [filters, setFilters] = React.useState<AlertFilters>(noFilters);
  const queryKey = JSON.stringify([filters.source, filters.severity, filters.vehicleId]);
  const maintenanceOnly = filters.source === 'maintenance';
  const query = (cursor?: string): AlertListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.source === '' || filters.source === 'maintenance'
      ? {}
      : { source: filters.source }),
    ...(filters.severity === '' ? {} : { severity: filters.severity }),
    ...(filters.vehicleId === '' ? {} : { vehicleId: filters.vehicleId }),
  });

  const first = useResource(
    () => (maintenanceOnly ? Promise.resolve(emptyPage) : ports.alerts.list(query())),
    [ports, queryKey],
  );
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

  // Totals by status for the summary cards: best effort, read once the list itself has loaded so the
  // list stays the first request of the screen.
  const expire = React.useRef(markExpired);
  expire.current = markExpired;
  const [totals, setTotals] = React.useState<AlertsSummaryData | null | undefined>(undefined);
  // Totals do not depend on the filters: read them once, the first time the list is ready.
  const listReady = first.state.status === 'ready' || totals !== undefined;
  React.useEffect(() => {
    if (!listReady) return;
    let cancelled = false;
    void loadAlertsSummary(ports).then((result) => {
      if (cancelled) return;
      if (!result.ok && result.error.status === 401) expire.current();
      setTotals(result.ok ? result.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, [ports, listReady]);
  // The list itself failed (error, no access, session over): no cards waiting on totals that never come.
  const summary =
    totals === undefined && first.state.status !== 'ready' && first.state.status !== 'loading'
      ? null
      : totals;

  const [extra, setExtra] = React.useState<{ items: Alert[]; cursor: string | null } | null>(null);
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

  const directory = React.useMemo<MaintenanceDirectory>(
    () => ({
      vehicles: vehicles?.items ?? null,
      vehiclesTruncated: vehicles?.truncated ?? false,
      members: [],
      membersTruncated: false,
    }),
    [vehicles],
  );
  // The maintenance records have no expiry severity: choosing one leaves them out.
  const showMaintenance =
    filters.severity === '' && (filters.source === '' || filters.source === 'maintenance');
  return (
    <AlertListView
      maintenanceSource
      hideList={maintenanceOnly}
      summary={
        <AlertStats
          data={summary}
          severity={filters.severity}
          onSelect={(severity) => setFilters({ ...filters, severity })}
        />
      }
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
    >
      {showMaintenance ? (
        <DirectoryProvider value={directory}>
          <MaintenanceAlertsPanel
            ports={ports.maintenance}
            vehicleId={filters.vehicleId}
            title="Alertas de mantenimiento"
            headingLevel={2}
            showVehicle
            framed
            emptyText="No hay alertas de mantenimiento. Aparecen cuando un plan se acerca a su fecha o kilometraje."
            onExpired={markExpired}
          />
        </DirectoryProvider>
      ) : maintenanceOnly ? (
        <UiState kind="no-results" />
      ) : null}
    </AlertListView>
  );
}
