import AddOutlined from '@mui/icons-material/AddOutlined';
import React from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  Button,
  DataTable,
  type DataTableColumn,
  DetailTabs,
  Field,
  FilterBar,
  PageHeader,
  Panel,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import type { BffWorkOrder, BffWorkOrderStatus } from '@opslog/contracts';
import { KIND_LABELS, STATUS_LABELS, STATUS_TONES, formatDate } from './labels';
import type { MaintenancePorts } from './ports';
import { errorKind, useResult } from './useResult';
import type { MaintenanceViewer } from './workflow';
import { CorrectiveOrderForm } from './CorrectiveOrderForm';
import { useDirectory, vehicleLabel } from './directory';
import { linkSx } from '../../app/router';
import { ExtraFilters } from '../search/views/ExtraFilters';
import type { ViewsPorts } from '../search/views/ports';
import { useListState, type ListState } from '../search/views/useListState';
import { ViewsBar } from '../search/views/ViewsBar';
import { formatMinor } from '../incidents/money';
import { filtersFromUrl, filtersToUrl, matches, NO_FILTERS, type Filters } from './orderFilters';

export interface WorkOrdersScreenProps {
  readonly ports: MaintenancePorts;
  readonly viewer: MaintenanceViewer;
  readonly onOpen: (orderId: string) => void;
  readonly onExpired: () => void;
  /** Saved views and persistent columns; without it the filters live in the screen and are not shared by link. */
  readonly views?: ViewsPorts;
}
export { matches } from './orderFilters';

/** Calendar groups by scheduled date; orders without one are listed apart with an explanation. */
export function byScheduledDate(orders: readonly BffWorkOrder[]) {
  const dated = new Map<string, BffWorkOrder[]>();
  const undated: BffWorkOrder[] = [];
  for (const order of orders) {
    if (!order.scheduledDate) undated.push(order);
    else dated.set(order.scheduledDate, [...(dated.get(order.scheduledDate) ?? []), order]);
  }
  return { days: [...dated.entries()].sort(([a], [b]) => a.localeCompare(b)), undated };
}

/**
 * S14: one list of work orders shown as a table and as a calendar, from the same contract. With `views`
 * its filters live in the address (keys of BFF_LIST_CATALOG) and the screen offers saved views and columns.
 */
type OrderRow = BffWorkOrder & { order: BffWorkOrder; cost: string };

export function WorkOrdersScreen(props: WorkOrdersScreenProps) {
  const { views, ...rest } = props;
  return views ? <WithList {...rest} views={views} /> : <WorkOrdersBody {...rest} list={null} />;
}

function WithList(props: WorkOrdersScreenProps & { views: ViewsPorts }) {
  const { views, ...rest } = props;
  const list = useListState('maintenance', {
    views,
    can: (permission) => props.viewer.permissions.includes(permission),
    onExpired: props.onExpired,
  });
  return <WorkOrdersBody {...rest} list={list} />;
}

function WorkOrdersBody({
  ports,
  viewer,
  onOpen,
  onExpired,
  list,
}: Omit<WorkOrdersScreenProps, 'views'> & { list: ListState | null }) {
  const { state, reload } = useResult(() => ports.orders.list(), [ports], onExpired);
  const directory = useDirectory();
  const [local, setLocal] = React.useState<Filters>(NO_FILTERS);
  const filters = list ? filtersFromUrl(list.url.filters) : local;
  const setFilters = (next: Filters) =>
    list ? list.setFilters(filtersToUrl(next)) : setLocal(next);
  const visible = <T extends { key: string }>(columns: T[]): T[] =>
    list ? list.columns.visible(columns) : columns;
  const [tab, setTab] = React.useState('list');
  const [creating, setCreating] = React.useState(false);
  const canCreate = viewer.permissions.includes('create');

  const header = (
    <PageHeader
      eyebrow="Mantenimiento"
      title="Órdenes de mantenimiento"
      description="Preventivas generadas por planes y correctivas registradas por el equipo."
      actions={
        canCreate && !creating ? (
          <Button variant="contained" startIcon={<AddOutlined />} onClick={() => setCreating(true)}>
            Nueva orden correctiva
          </Button>
        ) : undefined
      }
    />
  );
  if (state.status === 'loading')
    return (
      <Box>
        {header}
        <UiState kind="loading" />
      </Box>
    );
  if (state.status === 'error')
    return (
      <Box>
        {header}
        <UiState kind={errorKind(state.error)} actionLabel="Reintentar" onAction={reload} />
      </Box>
    );
  const orders = state.data;
  const shown = orders.filter((order) => matches(order, filters));
  const vehicles = [...new Set(orders.map((order) => order.vehicleId))]
    .map((id) => ({ id, label: vehicleLabel(directory, id) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  const open = (order: BffWorkOrder) => (
    <Link
      component="button"
      type="button"
      onClick={() => onOpen(order.id)}
      sx={{ ...linkSx, typography: 'body2', textAlign: 'left' }}
    >
      {order.description ?? `Orden ${KIND_LABELS[order.kind].toLowerCase()}`}
    </Link>
  );
  const status = (order: BffWorkOrder) => (
    <StatusBadge label={STATUS_LABELS[order.status]} tone={STATUS_TONES[order.status]} />
  );
  const rows: OrderRow[] = shown.map((order) => ({
    ...order,
    order,
    cost: order.costs?.length
      ? formatMinor(
          order.costs.reduce((sum, line) => sum + BigInt(line.amount.amountMinor), 0n).toString(),
          order.costs[0]!.amount.currency,
        )
      : '—',
  }));
  const columns: DataTableColumn<OrderRow>[] = [
    { key: 'order', label: 'Orden', render: (_value, row) => open(row.order) },
    {
      key: 'kind',
      label: 'Tipo',
      render: (_value, row) => KIND_LABELS[row.kind],
    },
    {
      key: 'vehicleId',
      label: 'Vehículo',
      render: (_value, row) => vehicleLabel(directory, row.vehicleId),
    },
    {
      key: 'status',
      label: 'Estado',
      render: (_value, row) => status(row.order),
    },
    {
      key: 'scheduledDate',
      label: 'Fecha programada',
      render: (_value, row) => formatDate(row.scheduledDate),
    },
    ...(list && viewer.permissions.includes('view_costs')
      ? [{ key: 'cost' as const, label: 'Costo' }]
      : []),
  ];
  const { days, undated } = byScheduledDate(shown);
  const empty =
    orders.length === 0 ? (
      <UiState
        kind="empty"
        title="Aún no hay órdenes"
        description="Las preventivas aparecen cuando un plan alcanza su fecha o kilometraje."
      />
    ) : (
      <UiState
        kind="no-results"
        actionLabel="Limpiar filtros"
        onAction={() => setFilters(NO_FILTERS)}
      />
    );
  return (
    <Box>
      {header}
      {creating && (
        <CorrectiveOrderForm
          ports={ports}
          onExpired={onExpired}
          onCancel={() => setCreating(false)}
          onCreated={(order) => {
            setCreating(false);
            onOpen(order.id);
          }}
        />
      )}
      <Panel>
        {list && <ViewsBar list={list} />}
        <FilterBar onClear={() => setFilters(NO_FILTERS)}>
          <Field
            select
            id="mnt-filter-status"
            label="Estado"
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value as Filters['status'] })
            }
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">Todos</MenuItem>
            {(Object.keys(STATUS_LABELS) as BffWorkOrderStatus[]).map((value) => (
              <MenuItem key={value} value={value}>
                {STATUS_LABELS[value]}
              </MenuItem>
            ))}
          </Field>
          <Field
            select
            id="mnt-filter-vehicle"
            label="Vehículo"
            value={filters.vehicleId}
            onChange={(event) => setFilters({ ...filters, vehicleId: event.target.value })}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">Todos</MenuItem>
            {vehicles.map((vehicle) => (
              <MenuItem key={vehicle.id} value={vehicle.id}>
                {vehicle.label}
              </MenuItem>
            ))}
          </Field>
          <Field
            id="mnt-filter-month"
            label="Mes programado"
            type="month"
            value={filters.month}
            onChange={(event) => setFilters({ ...filters, month: event.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          {list && (
            <>
              <Field
                select
                id="mnt-filter-kind"
                label="Tipo"
                value={filters.kind ?? ''}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    kind: event.target.value as NonNullable<Filters['kind']>,
                  })
                }
                sx={{ minWidth: 180 }}
              >
                <MenuItem value="">Todos</MenuItem>
                <MenuItem value="preventive">{KIND_LABELS.preventive}</MenuItem>
                <MenuItem value="corrective">{KIND_LABELS.corrective}</MenuItem>
              </Field>
              <Field
                select
                id="mnt-filter-overdue"
                label="Vencimiento"
                value={filters.overdue ? 'true' : ''}
                onChange={(event) =>
                  setFilters({ ...filters, overdue: event.target.value === 'true' })
                }
                sx={{ minWidth: 180 }}
              >
                <MenuItem value="">Todas</MenuItem>
                <MenuItem value="true">Solo vencidas</MenuItem>
              </Field>
              <ExtraFilters list={list} keys={['costFrom', 'costTo']} pageSizeLabel={null} />
            </>
          )}
        </FilterBar>
      </Panel>
      <Panel title="Órdenes">
        <DetailTabs
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'list',
              label: 'Lista',
              content:
                shown.length === 0 ? (
                  empty
                ) : (
                  <Box sx={{ overflowX: 'auto' }}>
                    <DataTable
                      caption={`${shown.length} órdenes`}
                      rows={rows}
                      columns={visible(columns)}
                    />
                  </Box>
                ),
            },
            {
              id: 'calendar',
              label: 'Calendario',
              content:
                shown.length === 0 ? (
                  empty
                ) : (
                  <Stack spacing={3}>
                    {days.map(([day, items]) => (
                      <Box
                        component="section"
                        key={day}
                        aria-label={`Programadas el ${formatDate(day)}`}
                      >
                        <Typography component="h3" variant="h6">
                          {formatDate(day)}
                        </Typography>
                        <Stack component="ul" spacing={1} sx={{ pl: 2 }}>
                          {items.map((order) => (
                            <li key={order.id}>
                              <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                                {open(order)} {status(order)}
                              </Stack>
                            </li>
                          ))}
                        </Stack>
                      </Box>
                    ))}
                    {undated.length > 0 && (
                      <Box component="section" aria-label="Sin fecha programada">
                        <Typography component="h3" variant="h6">
                          Sin fecha programada
                        </Typography>
                        <Typography color="text.secondary">
                          Aparecerán en el calendario cuando se asignen con una fecha.
                        </Typography>
                        <Stack component="ul" spacing={1} sx={{ pl: 2 }}>
                          {undated.map((order) => (
                            <li key={order.id}>
                              <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                                {open(order)} {status(order)}
                              </Stack>
                            </li>
                          ))}
                        </Stack>
                      </Box>
                    )}
                  </Stack>
                ),
            },
          ]}
        />
      </Panel>
    </Box>
  );
}
