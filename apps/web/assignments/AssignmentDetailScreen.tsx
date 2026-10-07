import React from 'react';
import { loadDriverOptions } from '../app/driverOptions';
import { useResource, type ResourceState } from '../app/resource';
import { useRouter } from '../app/router';
import type { AssignmentEvent } from '../app/types';
import { useVehicleName } from '../app/useVehicleName';
import { useSession } from '../auth/session';
import { AssignmentDetailView, type HistoryPage } from './AssignmentDetailView';
import { assignmentPath } from './AssignmentMessages';

const notices: Record<string, string> = {
  creada: 'Asignación creada.',
  reemplazada: 'Asignación creada. La principal anterior se cerró y quedó en el historial como reemplazada.',
  cerrada: 'Asignación cerrada. Quedó en el historial con su fecha de fin.',
};

const HISTORY_PAGE = 25;

/** Assignment detail screen. Requires `view`; "Cerrar asignación" needs `edit`. */
export function AssignmentDetailScreen({ id }: { id: string }) {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const { state, reload } = useResource(() => ports.assignments.get(id), [ports, id]);
  const history = useResource<HistoryPage>(
    () => ports.assignments.history(id, { limit: HISTORY_PAGE }),
    [ports, id],
  );
  const vehicleName = useVehicleName(state.status === 'ready' ? state.data.vehicleId : null);
  const [driverName, setDriverName] = React.useState<string | null>(null);
  const employeeId = state.status === 'ready' ? state.data.employeeId : null;
  React.useEffect(() => {
    setDriverName(null);
    if (employeeId === null) return undefined;
    let cancelled = false;
    void loadDriverOptions(ports.employees).then((result) => {
      if (!cancelled && result.ok)
        setDriverName(result.value.items.find((item) => item.id === employeeId)?.name ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [ports, employeeId]);
  const [extra, setExtra] = React.useState<{
    items: AssignmentEvent[];
    cursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [historyNotice, setHistoryNotice] = React.useState<string | null>(null);
  // Bumped whenever the first page is reloaded: a page requested before that belongs to an older list.
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current += 1;
    setExtra(null);
    setHistoryNotice(null);
  }, [history.state]);

  const [notice] = React.useState<string | null>(() => {
    const code = router.search.get('aviso') ?? '';
    return Object.hasOwn(notices, code) ? (notices[code] ?? null) : null;
  });
  // The result of the previous screen is shown once and removed from the address bar.
  React.useEffect(() => {
    if (router.search.has('aviso')) router.navigate(assignmentPath(id), { replace: true });
  }, [router, id]);

  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setHistoryNotice(null);
    const requested = generation.current;
    const result = await ports.assignments.history(id, { limit: HISTORY_PAGE, cursor });
    setLoadingMore(false);
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setHistoryNotice('No pudimos cargar más historial.');
  };

  const historyState: ResourceState<HistoryPage> =
    history.state.status === 'ready'
      ? {
          status: 'ready',
          data: {
            items: [...history.state.data.items, ...(extra?.items ?? [])],
            total: history.state.data.total,
            nextCursor: extra ? extra.cursor : history.state.data.nextCursor,
          },
        }
      : history.state;

  return (
    <AssignmentDetailView
      state={state}
      history={{
        state: historyState,
        loadingMore,
        notice: historyNotice,
        onRetry: history.reload,
        onLoadMore: (cursor) => void loadMore(cursor),
      }}
      vehicleName={vehicleName}
      driverName={driverName}
      can={can}
      notice={notice}
      onRetry={reload}
    />
  );
}
