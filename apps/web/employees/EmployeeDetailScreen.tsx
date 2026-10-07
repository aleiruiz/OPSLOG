import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import { useRouter } from '../app/router';
import type { Employee, EmployeeHistoryEntry, EmployeeStatus } from '../app/types';
import { useSession } from '../auth/session';
import { AssignmentHistorySection } from '../assignments/AssignmentHistorySection';
import {
  dialogClosed,
  EmployeeDetailView,
  statusPanelClosed,
  type EmployeeDialogState,
  type HistoryPage,
  type StatusPanelState,
} from './EmployeeDetailView';
import { employeePath } from './EmployeeMessages';
import { statusPresentation } from './labels';
import { loadEmployeeContext } from './loadEmployee';
import { archiveFailure, statusFailure } from './messages';

const notices: Record<string, string> = {
  creado: 'Empleado creado.',
  guardado: 'Cambios guardados.',
};

const HISTORY_PAGE = 25;

/**
 * Employee detail screen. Requires `view`; "Editar" and "Cambiar estado" need `edit`, "Archivar" needs `delete`.
 * Personal data comes with the employee only for a session holding `view_pii`; it stays hidden until asked for.
 */
export function EmployeeDetailScreen({ id }: { id: string }) {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const [refresh, setRefresh] = React.useState(0);
  const { state, reload, setData } = useResource(
    () => loadEmployeeContext(ports.employees, ports.areas, id),
    [ports, id],
  );
  const history = useResource<HistoryPage>(
    () => ports.employees.history(id, { limit: HISTORY_PAGE }),
    [ports, id, refresh],
  );
  const [extra, setExtra] = React.useState<{
    items: EmployeeHistoryEntry[];
    cursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [historyNotice, setHistoryNotice] = React.useState<string | null>(null);
  // Bumped whenever the first page is reloaded: a page requested before that belongs to an older list.
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current += 1;
    setExtra(null);
    setLoadingMore(false);
    setHistoryNotice(null);
  }, [history.state]);

  const [notice, setNotice] = React.useState<string | null>(() => {
    const code = router.search.get('aviso') ?? '';
    return Object.hasOwn(notices, code) ? (notices[code] ?? null) : null;
  });
  const [dialog, setDialog] = React.useState<EmployeeDialogState>(dialogClosed);
  const [panel, setPanel] = React.useState<StatusPanelState>(statusPanelClosed);

  // The result of the previous screen is shown once and removed from the address bar.
  React.useEffect(() => {
    if (router.search.has('aviso')) router.navigate(employeePath(id), { replace: true });
  }, [router, id]);

  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setHistoryNotice(null);
    const requested = generation.current;
    const result = await ports.employees.history(id, { limit: HISTORY_PAGE, cursor });
    // A stale request must not clear the spinner of the one that is active.
    if (generation.current !== requested) return;
    setLoadingMore(false);
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

  /** A change came back: keep the personal data the page already holds (writes never return it). */
  const applied = (employee: Employee, message: string) => {
    if (state.status !== 'ready') return;
    setData({ ...state.data, employee: { ...employee, pii: state.data.employee.pii } });
    setDialog(dialogClosed);
    setPanel(statusPanelClosed);
    setNotice(message);
    setRefresh((count) => count + 1);
  };

  const expired = () => {
    // The dialog lives outside the inert screen: close it so it cannot sit over the sign-in panel.
    setDialog(dialogClosed);
    setPanel(statusPanelClosed);
    markExpired();
  };

  const changeStatus = async (to: EmployeeStatus, reason: string, from: 'panel' | 'dialog') => {
    if (state.status !== 'ready') return;
    if (from === 'panel') setPanel({ open: true, busy: true });
    else setDialog({ kind: 'terminate', busy: true, reason });
    const result = await ports.employees.changeStatus(id, {
      version: state.data.employee.version,
      status: to,
      reason,
    });
    if (result.ok)
      applied(
        result.value,
        to === 'terminated'
          ? 'Empleado dado de baja.'
          : `Estado cambiado a ${statusPresentation[to].label}.`,
      );
    else if (result.error.status === 401) expired();
    else if (from === 'panel')
      setPanel({ open: true, busy: false, ...statusFailure(result.error) });
    else setDialog({ kind: 'terminate', busy: false, reason, ...statusFailure(result.error) });
  };

  const archive = async () => {
    if (state.status !== 'ready') return;
    setDialog({ kind: 'archive', busy: true });
    const result = await ports.employees.archive(id, state.data.employee.version);
    if (result.ok) applied(result.value, 'Empleado archivado.');
    else if (result.error.status === 401) expired();
    else setDialog({ kind: 'archive', busy: false, ...archiveFailure(result.error) });
  };

  const recover = () => {
    setDialog(dialogClosed);
    setPanel(statusPanelClosed);
    setNotice(null);
    reload();
    setRefresh((count) => count + 1);
  };

  return (
    <>
      <EmployeeDetailView
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
        statusPanel={panel}
        onRetry={reload}
        onStatusOpen={() => setPanel({ open: true, busy: false })}
        onStatusCancel={() => setPanel(statusPanelClosed)}
        onStatusSubmit={(to, reason) =>
          to === 'terminated'
            ? setDialog({ kind: 'terminate', busy: false, reason })
            : void changeStatus(to, reason, 'panel')
        }
        onStatusErrorAction={recover}
        onArchiveRequest={() => setDialog({ kind: 'archive', busy: false })}
        onDialogConfirm={() =>
          dialog.kind === 'terminate'
            ? void changeStatus('terminated', dialog.reason ?? '', 'dialog')
            : void archive()
        }
        onDialogCancel={() => setDialog(dialogClosed)}
        onDialogErrorAction={recover}
      />
      {state.status === 'ready' && state.data.employee.kind === 'driver' && (
        <AssignmentHistorySection employeeId={state.data.employee.id} />
      )}
    </>
  );
}
