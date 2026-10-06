import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import { useRouter } from '../app/router';
import type { ApiError, InsurancePolicyRevision } from '../app/types';
import { useVehicleName } from '../app/useVehicleName';
import { useSession } from '../auth/session';
import {
  archiveClosed,
  PolicyDetailView,
  type ArchiveDialogState,
  type HistoryPage,
} from './PolicyDetailView';
import { policyPath } from './PolicyMessages';

const notices: Record<string, string> = {
  creada: 'Póliza creada.',
  guardada: 'Cambios guardados.',
  renovada: 'Póliza renovada. La revisión anterior quedó en el historial.',
};

const HISTORY_PAGE = 25;

function archiveFailure(error: ApiError): Pick<ArchiveDialogState, 'error' | 'errorActionLabel'> {
  if (error.code === 'stale_version')
    return {
      error:
        'Otra persona modificó esta póliza mientras la revisabas. Recarga los datos y vuelve a decidir.',
      errorActionLabel: 'Recargar datos',
    };
  if (error.code === 'immutable')
    return { error: 'Esta póliza ya estaba archivada.', errorActionLabel: 'Recargar datos' };
  if (error.status === 403) return { error: 'No tienes permiso para archivar pólizas.' };
  if (error.status === 404) return { error: 'Esta póliza ya no existe.' };
  return { error: 'No pudimos archivar la póliza. Intenta nuevamente.' };
}

/** Policy detail screen. Requires `view`; "Editar" and "Renovar" need `edit`, "Archivar" needs `delete`. */
export function PolicyDetailScreen({ id }: { id: string }) {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const [refresh, setRefresh] = React.useState(0);
  const { state, reload, setData } = useResource(() => ports.insurance.get(id), [ports, id]);
  const history = useResource<HistoryPage>(
    () => ports.insurance.history(id, { limit: HISTORY_PAGE }),
    [ports, id, refresh],
  );
  const vehicleName = useVehicleName(state.status === 'ready' ? state.data.vehicleId : null);
  const [extra, setExtra] = React.useState<{
    items: InsurancePolicyRevision[];
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

  const [notice, setNotice] = React.useState<string | null>(() => {
    const code = router.search.get('aviso') ?? '';
    return Object.hasOwn(notices, code) ? (notices[code] ?? null) : null;
  });
  const [archive, setArchive] = React.useState<ArchiveDialogState>(archiveClosed);

  // The result of the previous screen is shown once and removed from the address bar.
  React.useEffect(() => {
    if (router.search.has('aviso')) router.navigate(policyPath(id), { replace: true });
  }, [router, id]);

  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setHistoryNotice(null);
    const requested = generation.current;
    const result = await ports.insurance.history(id, { limit: HISTORY_PAGE, cursor });
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

  const confirm = async () => {
    if (state.status !== 'ready') return;
    setArchive({ open: true, busy: true });
    const result = await ports.insurance.archive(id, state.data.version);
    if (result.ok) {
      setData(result.value);
      setArchive(archiveClosed);
      setNotice('Póliza archivada.');
      setRefresh((count) => count + 1);
    } else if (result.error.status === 401) {
      // The dialog lives outside the inert screen: close it so it cannot sit over the sign-in panel.
      setArchive(archiveClosed);
      markExpired();
    } else setArchive({ open: true, busy: false, ...archiveFailure(result.error) });
  };

  return (
    <PolicyDetailView
      state={state}
      history={{
        state: historyState,
        loadingMore,
        notice: historyNotice,
        onRetry: history.reload,
        onLoadMore: (cursor) => void loadMore(cursor),
      }}
      vehicleName={vehicleName}
      can={can}
      notice={notice}
      archive={archive}
      onRetry={reload}
      onArchiveRequest={() => setArchive({ open: true, busy: false })}
      onArchiveConfirm={() => void confirm()}
      onArchiveCancel={() => setArchive(archiveClosed)}
      onArchiveErrorAction={() => {
        setArchive(archiveClosed);
        reload();
      }}
    />
  );
}
