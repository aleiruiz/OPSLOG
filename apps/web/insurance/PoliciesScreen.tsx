import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { InsuranceListQuery, InsurancePolicy } from '../app/types';
import { loadVehicleOptions, type VehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import { isDateBetween, MAX_EXPIRY_DATE, MIN_DATE } from '../documents/rules';
import {
  noFilters,
  PolicyListView,
  type PolicyFilters,
  type PolicyListData,
} from './PolicyListView';

const PAGE_SIZE = 25;

/** Policy list screen. Requires `view`; "Nueva póliza", "Editar" and "Renovar" depend on `create` and `edit`. */
export function PoliciesScreen() {
  const { ports, can, markExpired } = useSession();
  const [filters, setFilters] = React.useState<PolicyFilters>(noFilters);
  const dateValid =
    filters.coversOn === '' || isDateBetween(filters.coversOn, MIN_DATE, MAX_EXPIRY_DATE);
  const appliedDate = dateValid ? filters.coversOn : '';
  const queryKey = JSON.stringify([
    filters.status,
    filters.vehicleId,
    filters.coverageType,
    appliedDate,
    filters.includeArchived,
  ]);
  const query = (cursor?: string): InsuranceListQuery => ({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.vehicleId === '' ? {} : { vehicleId: filters.vehicleId }),
    ...(filters.coverageType === '' ? {} : { coverageType: filters.coverageType }),
    ...(appliedDate === '' ? {} : { coversOn: appliedDate }),
    ...(filters.includeArchived ? { includeArchived: 'true' as const } : {}),
  });

  const first = useResource(() => ports.insurance.list(query()), [ports, queryKey]);
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

  const [extra, setExtra] = React.useState<{
    items: InsurancePolicy[];
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
    const result = await ports.insurance.list(query(cursor));
    setLoadingMore(false);
    // The list was reloaded or its filters changed while this page was loading: it belongs to an older list.
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más pólizas.', severity: 'error' });
  };

  const state: ResourceState<PolicyListData> =
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
    <PolicyListView
      state={state}
      filters={filters}
      vehicles={vehicles}
      dateError={
        dateValid ? undefined : 'Elige un día válido. El filtro no se aplica hasta entonces.'
      }
      can={can}
      filtersActive={
        filters.status !== '' ||
        filters.vehicleId !== '' ||
        filters.coverageType !== '' ||
        appliedDate !== '' ||
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
