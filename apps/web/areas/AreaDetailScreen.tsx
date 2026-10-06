import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import { useRouter } from '../app/router';
import type { AreaHistoryEntry, Result } from '../app/types';
import { useSession } from '../auth/session';
import {
  AreaDetailView,
  dialogClosed,
  type AreaDialogState,
  type HistoryPage,
} from './AreaDetailView';
import { areaPath } from './AreaTreeView';
import { loadAreaContext, type AreaContext } from './loadAreas';
import { activateFailure, deactivateFailure } from './messages';

const notices: Record<string, string> = {
  creada: 'Área creada.',
  guardada: 'Cambios guardados.',
  movida: 'Área movida con todas sus sub-áreas.',
};

const HISTORY_PAGE = 25;

/** Area detail screen. Requires `view`; "Editar"/"Mover"/"Activar" need `edit`, "Nueva sub-área" `create`, "Desactivar" `delete`. */
export function AreaDetailScreen({ id }: { id: string }) {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const [refresh, setRefresh] = React.useState(0);
  const { state, reload, setData } = useResource(
    () => loadAreaContext(ports.areas, id),
    [ports, id],
  );
  const history = useResource<HistoryPage>(
    () => ports.areas.history(id, { limit: HISTORY_PAGE }),
    [ports, id, refresh],
  );
  const [extra, setExtra] = React.useState<{
    items: AreaHistoryEntry[];
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
  const [dialog, setDialog] = React.useState<AreaDialogState>(dialogClosed);

  // The result of the previous screen is shown once and removed from the address bar.
  React.useEffect(() => {
    if (router.search.has('aviso')) router.navigate(areaPath(id), { replace: true });
  }, [router, id]);

  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setHistoryNotice(null);
    const requested = generation.current;
    const result = await ports.areas.history(id, { limit: HISTORY_PAGE, cursor });
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
    if (state.status !== 'ready' || dialog.kind === null) return;
    const { kind } = dialog;
    const { area, areas } = state.data;
    setDialog({ kind, busy: true });
    const result: Result<AreaContext['area']> = await (kind === 'deactivate'
      ? ports.areas.deactivate(id, area.version)
      : ports.areas.activate(id, area.version)
    ).then((outcome) =>
      outcome.ok
        ? { ok: true as const, value: { ...outcome.value, resourceCounts: area.resourceCounts } }
        : outcome,
    );
    if (result.ok) {
      setData({
        ...state.data,
        area: result.value,
        areas: areas.map((item) => (item.id === id ? { ...item, ...result.value } : item)),
      });
      setDialog(dialogClosed);
      setNotice(kind === 'deactivate' ? 'Área desactivada.' : 'Área activada.');
      setRefresh((count) => count + 1);
    } else if (result.error.status === 401) {
      // The dialog lives outside the inert screen: close it so it cannot sit over the sign-in panel.
      setDialog(dialogClosed);
      markExpired();
    } else
      setDialog({
        kind,
        busy: false,
        ...(kind === 'deactivate' ? deactivateFailure(result.error) : activateFailure(result.error)),
      });
  };

  return (
    <AreaDetailView
      state={state}
      history={{
        state: historyState,
        loadingMore,
        notice: historyNotice,
        onRetry: history.reload,
        onLoadMore: (cursor) => void loadMore(cursor),
      }}
      can={can}
      notice={notice}
      dialog={dialog}
      onRetry={reload}
      onDialogRequest={(kind) => setDialog({ kind, busy: false })}
      onDialogConfirm={() => void confirm()}
      onDialogCancel={() => setDialog(dialogClosed)}
      onDialogErrorAction={() => {
        setDialog(dialogClosed);
        setNotice(null);
        reload();
        setRefresh((count) => count + 1);
      }}
    />
  );
}
