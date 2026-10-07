import React from 'react';
import { useResource, type ResourceState } from '../app/resource';
import { useRouter } from '../app/router';
import type { ImportEvent, ImportOutcome, ImportRow } from '../app/types';
import { useSession } from '../auth/session';
import { ImportDetailView, type HistoryPage, type RowsPage } from './ImportDetailView';
import { importPath } from './ImportMessages';
import { errorReportCsv } from './csv';

const notices: Record<string, string> = {
  importada: 'Importación terminada. Revisa el informe por fila.',
  repetida:
    'Esta solicitud ya se había procesado: mostramos el resultado guardado y no se creó nada nuevo.',
  fallida:
    'No se importó nada: había filas con error y el modo era «todo o nada». Revisa el informe por fila.',
};

const PAGE = 25;

/** Keeps the first page of a resource plus the pages loaded after it (a reload of the first page drops them). */
function usePaged<I, P extends { items: readonly I[]; nextCursor: string | null; total: number }>(
  first: ReturnType<typeof useResource<P>>,
  fetchPage: (
    cursor: string,
  ) => Promise<{ ok: true; value: P } | { ok: false; error: { status: number } }>,
  failureText: string,
  resetKey: string,
  markExpired: () => void,
) {
  const [extra, setExtra] = React.useState<{ items: I[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  // Bumped whenever the first page is reloaded: a page requested before that belongs to an older list.
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current += 1;
    setExtra(null);
    setNotice(null);
  }, [first.state, resetKey]);
  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setNotice(null);
    const requested = generation.current;
    const result = await fetchPage(cursor);
    setLoadingMore(false);
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice(failureText);
  };
  const state: ResourceState<P> =
    first.state.status === 'ready'
      ? {
          status: 'ready',
          data: {
            ...first.state.data,
            items: [...first.state.data.items, ...(extra?.items ?? [])],
            nextCursor: extra ? extra.cursor : first.state.data.nextCursor,
          },
        }
      : first.state;
  return {
    state,
    loadingMore,
    notice,
    onRetry: first.reload,
    onLoadMore: (c: string) => void loadMore(c),
  };
}

/** Import detail screen. Requires `view`: the report and the history never include a cell value. */
export function ImportDetailScreen({ id }: { id: string }) {
  const { ports, markExpired } = useSession();
  const router = useRouter();
  const [outcome, setOutcome] = React.useState<ImportOutcome | ''>('');
  const [downloadingErrors, setDownloadingErrors] = React.useState(false);
  const [downloadNotice, setDownloadNotice] = React.useState<string | null>(null);
  const { state, reload } = useResource(() => ports.imports.get(id), [ports, id]);
  const rowsFirst = useResource<RowsPage>(
    () => ports.imports.rows(id, { limit: PAGE, ...(outcome === '' ? {} : { outcome }) }),
    [ports, id, outcome],
  );
  const historyFirst = useResource<HistoryPage>(
    () => ports.imports.history(id, { limit: PAGE }),
    [ports, id],
  );
  const rows = usePaged<ImportRow, RowsPage>(
    rowsFirst,
    (cursor) =>
      ports.imports.rows(id, { limit: PAGE, cursor, ...(outcome === '' ? {} : { outcome }) }),
    'No pudimos cargar más filas.',
    outcome,
    markExpired,
  );
  const history = usePaged<ImportEvent, HistoryPage>(
    historyFirst,
    (cursor) => ports.imports.history(id, { limit: PAGE, cursor }),
    'No pudimos cargar más historial.',
    id,
    markExpired,
  );

  const [notice] = React.useState<string | null>(() => {
    const code = router.search.get('aviso') ?? '';
    return Object.hasOwn(notices, code) ? (notices[code] ?? null) : null;
  });
  // The result of the previous screen is shown once and removed from the address bar.
  React.useEffect(() => {
    if (router.search.has('aviso')) router.navigate(importPath(id), { replace: true });
  }, [router, id]);

  const downloadErrors = async () => {
    setDownloadingErrors(true);
    setDownloadNotice(null);
    const allRows: ImportRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await ports.imports.rows(id, {
        limit: 100,
        outcome: 'invalid',
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) {
        setDownloadingErrors(false);
        if (result.error.status === 401) markExpired();
        else setDownloadNotice('No pudimos preparar el informe. Intenta nuevamente.');
        return;
      }
      allRows.push(...result.value.items);
      cursor = result.value.nextCursor ?? undefined;
      if (!cursor) break;
    }
    setDownloadingErrors(false);
    if (
      cursor ||
      allRows.length > 500 ||
      allRows.length !== (state.status === 'ready' ? state.data.invalidRows : 0)
    ) {
      setDownloadNotice('El informe supera el límite disponible o no está completo.');
      return;
    }
    const blob = new Blob([`\uFEFF${errorReportCsv(allRows)}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `importacion-${id}-errores.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <ImportDetailView
      state={state}
      rows={{ ...rows, outcome, onOutcomeChange: setOutcome }}
      history={history}
      notice={notice}
      downloadingErrors={downloadingErrors}
      downloadNotice={downloadNotice}
      onDownloadErrors={() => void downloadErrors()}
      onRetry={() => {
        reload();
        rowsFirst.reload();
        historyFirst.reload();
      }}
    />
  );
}
