import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Button, DataTable, Panel, StatusBadge, UiState } from '@opslog/ui';
import type { BffMaintenanceAlert } from '@opslog/contracts';
import { ALERT_KIND_LABELS, alertReason, alertTarget, odometerAge } from './alertLabels';
import { useDirectory, vehicleLabel } from './directory';
import { formatInstantDay } from './labels';
import type { MaintenancePorts } from './ports';
import { errorKind, useResult } from './useResult';

const PAGE_SIZE = 25;
const day = (iso: string) => formatInstantDay(iso);

/**
 * The in-app alert records of maintenance plans (MNT-UI acceptance #8), newest first and paged by
 * cursor. Narrowed to one plan on the plan detail, or to a vehicle / all plans in the shell's
 * alerts area. Read-only: the worker creates them, the server decides who may read them.
 */
export function MaintenanceAlertsPanel({
  ports,
  planId,
  vehicleId,
  title,
  headingLevel = 3,
  showVehicle = false,
  emptyText = 'No hay alertas de mantenimiento.',
  framed = false,
  onExpired,
}: {
  ports: MaintenancePorts;
  planId?: string;
  vehicleId?: string;
  title: string;
  headingLevel?: 2 | 3;
  showVehicle?: boolean;
  emptyText?: string;
  /** Renders the records as a card of the page (the alerts screen) instead of a plain section. */
  framed?: boolean;
  onExpired: () => void;
}) {
  const directory = useDirectory();
  const query = (cursor?: string) => ({
    limit: PAGE_SIZE as typeof PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(planId === undefined ? {} : { planId }),
    ...(vehicleId === undefined || vehicleId === '' ? {} : { vehicleId }),
  });
  const first = useResult(() => ports.alerts.list(query()), [ports, planId, vehicleId], onExpired);
  const [extra, setExtra] = React.useState<{
    items: readonly BffMaintenanceAlert[];
    cursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const generation = React.useRef(0);
  // A layout effect: the reset must land before the page can be clicked, or a "load more"
  // started right after the first page arrives is discarded as stale.
  React.useLayoutEffect(() => {
    generation.current += 1;
    setExtra(null);
    setFailed(false);
  }, [planId, vehicleId, first.state]);
  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setFailed(false);
    const requested = generation.current;
    const result = await ports.alerts.list(query(cursor));
    setLoadingMore(false);
    if (generation.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) onExpired();
    else setFailed(true);
  };
  const heading = (
    <Typography component={`h${headingLevel}`} variant="h6">
      {title}
    </Typography>
  );
  const pad = { px: { xs: 2, sm: 2.5 }, py: 2 };
  const frame = (body: React.ReactNode, flush = false) =>
    framed ? (
      <Panel title={title} headingLevel={headingLevel} flush={flush}>
        {body}
      </Panel>
    ) : (
      <Box component="section" aria-label={title} sx={{ mt: 3 }}>
        {heading}
        {body}
      </Box>
    );
  if (first.state.status === 'loading')
    return frame(<Typography color="text.secondary">Cargando alertas…</Typography>);
  if (first.state.status === 'error')
    return frame(
      <UiState
        kind={errorKind(first.state.error)}
        description="No pudimos cargar las alertas de mantenimiento."
        actionLabel="Reintentar"
        onAction={first.reload}
      />,
    );
  const items = [...first.state.data.items, ...(extra?.items ?? [])];
  const cursor = extra ? extra.cursor : first.state.data.nextCursor;
  const columns = [
    ...(showVehicle
      ? [
          {
            key: 'vehicleId' as const,
            label: 'Vehículo',
            render: (_value: unknown, row: BffMaintenanceAlert) =>
              vehicleLabel(directory, row.vehicleId),
          },
        ]
      : []),
    {
      key: 'kind' as const,
      label: 'Alerta',
      render: (_value: unknown, row: BffMaintenanceAlert) => {
        const view = ALERT_KIND_LABELS[row.kind];
        return (
          <>
            <StatusBadge label={view.label} tone={view.tone} />
            <Typography variant="body2" color="text.secondary">
              {alertReason(row)}
            </Typography>
          </>
        );
      },
    },
    {
      key: 'targetDate' as const,
      label: 'Objetivo',
      render: (_value: unknown, row: BffMaintenanceAlert) => (
        <>
          {row.trigger === 'odometer' ? 'Por kilometraje: ' : 'Por fecha: '}
          {alertTarget(row)}
          {odometerAge(row) && (
            <Typography variant="body2" color="text.secondary">
              {odometerAge(row)}
            </Typography>
          )}
        </>
      ),
    },
    {
      key: 'occurredAt' as const,
      label: 'Detectada',
      render: (_value: unknown, row: BffMaintenanceAlert) => day(row.occurredAt),
    },
  ];
  const footer = framed ? pad : { mt: 1 };
  return frame(
    <>
      {items.length === 0 ? (
        <Typography color="text.secondary">{emptyText}</Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <DataTable
            caption={`${title} (${first.state.data.total})`}
            rows={items.map((alert) => ({ ...alert }))}
            columns={columns}
          />
        </Box>
      )}
      {failed && (
        <Box sx={framed ? { px: { xs: 2, sm: 2.5 }, pt: 2 } : {}}>
          <Alert severity="error" role="alert" sx={{ mt: 1 }}>
            No pudimos cargar más alertas.
          </Alert>
        </Box>
      )}
      {cursor && (
        <Box sx={footer}>
          <Button variant="outlined" loading={loadingMore} onClick={() => void loadMore(cursor)}>
            Cargar más alertas
          </Button>
        </Box>
      )}
    </>,
    items.length > 0,
  );
}
