import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import type { InsuranceListQuery, InsurancePolicy } from '../app/types';
import { loadVehicleOptions, type VehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import { pickFilters } from '../features/search/views/urlState';
import { useListState } from '../features/search/views/useListState';
import { isDateBetween, MAX_EXPIRY_DATE, MIN_DATE } from '../documents/rules';
import { PolicyListView, type PolicyFilters, type PolicyListData } from './PolicyListView';

const RANGE_KEYS = ['endsFrom', 'endsTo'] as const;

/** Policy list screen. Requires `view`; "Nueva póliza", "Editar" and "Renovar" depend on `create` and `edit`. */
export function PoliciesScreen() {
  const { ports, can, markExpired } = useSession();
  const list = useListState('insurance', { views: ports.views, can, onExpired: markExpired });
  const url = list.url.filters;
  // The day being typed stays in the field until it is a valid one; only then does it reach the address.
  const [coversText, setCoversText] = React.useState(url.coversOn ?? '');
  React.useEffect(() => setCoversText(url.coversOn ?? ''), [url.coversOn]);
  // Filters, order and size live in the address (keys of BFF_LIST_CATALOG), so a link reproduces the list.
  const filters: PolicyFilters = {
    status: (url.status ?? '') as PolicyFilters['status'],
    vehicleId: url.vehicleId ?? '',
    coverageType: (url.coverageType ?? '') as PolicyFilters['coverageType'],
    coversOn: coversText,
    includeArchived: url.includeArchived === 'true',
  };
  const dateValid = coversText === '' || isDateBetween(coversText, MIN_DATE, MAX_EXPIRY_DATE);
  const setFilters = (next: PolicyFilters) => {
    setCoversText(next.coversOn);
    const covers = next.coversOn === '' || isDateBetween(next.coversOn, MIN_DATE, MAX_EXPIRY_DATE);
    const coversOn = covers ? next.coversOn : (url.coversOn ?? '');
    list.setFilters({
      ...pickFilters(url, RANGE_KEYS),
      ...(next.status === '' ? {} : { status: next.status }),
      ...(next.vehicleId === '' ? {} : { vehicleId: next.vehicleId }),
      ...(next.coverageType === '' ? {} : { coverageType: next.coverageType }),
      ...(coversOn === '' ? {} : { coversOn }),
      ...(next.includeArchived ? { includeArchived: 'true' } : {}),
    });
  };
  const queryKey = list.key;
  const query = (cursor?: string): InsuranceListQuery => ({
    limit: list.url.limit as 25 | 50 | 100,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.vehicleId === '' ? {} : { vehicleId: filters.vehicleId }),
    ...(filters.coverageType === '' ? {} : { coverageType: filters.coverageType }),
    ...(url.coversOn ? { coversOn: url.coversOn } : {}),
    ...(filters.includeArchived ? { includeArchived: 'true' as const } : {}),
    ...pickFilters(url, RANGE_KEYS),
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
