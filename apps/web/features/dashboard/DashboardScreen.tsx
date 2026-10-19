import React from 'react';
import type { BffDashboardQuery } from '@opslog/contracts';
import { InlineAlert, Button, UiState } from '@opslog/ui';
import { loadAllAreas } from '../../areas/loadAreas';
import { useResource } from '../../app/resource';
import { useSession } from '../../auth/session';
import { DashboardBody } from './DashboardBody';
import { DashboardFilters, type DashboardFilterValues } from './DashboardFilters';
import { customRangeError, rangeOf } from './range';
import { useDashboard } from './useDashboard';

const INITIAL: DashboardFilterValues = {
  areaId: '',
  choice: 'default',
  customFrom: '',
  customTo: '',
};

/** The dashboard of Inicio (S02): widgets per permission, filtered by area and range, each with its drill-down. */
export function DashboardScreen() {
  const { ports } = useSession();
  const [filters, setFilters] = React.useState<DashboardFilterValues>(INITIAL);
  // The company's day, learned from the first answer; the shortcuts are computed from it, never from the browser clock.
  const known = React.useRef<string | null>(null);
  const today = known.current;
  const catalog = useResource(() => loadAllAreas(ports.areas, false), [ports]);
  const areas = catalog.state.status === 'ready' ? catalog.state.data.areas : [];

  const range =
    filters.choice === 'custom'
      ? customRangeError(filters.customFrom, filters.customTo) === null
        ? { from: filters.customFrom, to: filters.customTo }
        : null
      : today === null
        ? null
        : rangeOf(filters.choice, today);
  // The server defaults to the last 30 days of the company's zone; a bad custom range keeps the last good query.
  const lastGood = React.useRef<BffDashboardQuery>({});
  const query: BffDashboardQuery = {
    ...(filters.areaId ? { areaId: filters.areaId } : {}),
    ...(range ? range : filters.choice === 'custom' ? lastGood.current : {}),
  };
  if (range || filters.choice !== 'custom') lastGood.current = range ?? {};

  const { state, reload } = useDashboard(query);
  if (state.data) known.current = state.data.today;

  if (state.status === 'forbidden') return <NoWidgets />;
  if (state.status === 'loading') return <UiState kind="loading" />;
  if (state.data === null)
    return (
      <UiState
        kind="error"
        title="No pudimos cargar los indicadores"
        description="Tus datos no cambiaron. Intenta nuevamente."
        actionLabel="Reintentar"
        onAction={reload}
      />
    );
  if (state.data.widgets.length === 0) return <NoWidgets />;
  return (
    <section aria-label="Indicadores">
      <DashboardFilters
        values={filters}
        areas={areas}
        ready={known.current !== null}
        onChange={(patch) => setFilters((previous) => ({ ...previous, ...patch }))}
      />
      {state.status === 'error' && (
        <InlineAlert
          severity="error"
          action={
            <Button size="small" variant="outlined" onClick={reload}>
              Reintentar
            </Button>
          }
        >
          No pudimos actualizar los indicadores; se muestran las últimas cifras cargadas.
        </InlineAlert>
      )}
      <DashboardBody data={state.data} refreshing={state.status === 'ready' && state.refreshing} />
    </section>
  );
}

/** No widget is visible to the reader: say what to ask for, without naming what exists. */
function NoWidgets() {
  return (
    <UiState
      kind="no-permission"
      title="Todavía no tienes indicadores"
      description="Tu rol no incluye indicadores. Pide a quien administre la empresa el permiso para consultar la información de la flota o de siniestros."
    />
  );
}
