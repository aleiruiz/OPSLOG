import React from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  Button,
  DataTable,
  DetailTabs,
  Field,
  FilterBar,
  PageHeader,
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

export interface WorkOrdersScreenProps {
  readonly ports: MaintenancePorts;
  readonly viewer: MaintenanceViewer;
  readonly onOpen: (orderId: string) => void;
  readonly onExpired: () => void;
}
interface Filters {
  readonly status: '' | BffWorkOrderStatus;
  readonly vehicleId: string;
  readonly month: string;
}
const NO_FILTERS: Filters = { status: '', vehicleId: '', month: '' };

export const matches = (order: BffWorkOrder, filters: Filters): boolean =>
  (filters.status === '' || order.status === filters.status) &&
  (filters.vehicleId === '' || order.vehicleId === filters.vehicleId) &&
  (filters.month === '' || (order.scheduledDate ?? '').startsWith(filters.month));

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

/** S14: one list of work orders shown as a table and as a calendar, from the same contract. */
export function WorkOrdersScreen({ ports, viewer, onOpen, onExpired }: WorkOrdersScreenProps) {
  const { state, reload } = useResult(() => ports.orders.list(), [ports], onExpired);
  const directory = useDirectory();
  const [filters, setFilters] = React.useState<Filters>(NO_FILTERS);
  const [tab, setTab] = React.useState('list');
  const [creating, setCreating] = React.useState(false);
  const canCreate = viewer.permissions.includes('create');

  const header = (
    <PageHeader
      title="Órdenes de mantenimiento"
      description="Preventivas generadas por planes y correctivas registradas por el equipo."
      actions={
        canCreate && !creating ? (
          <Button variant="contained" onClick={() => setCreating(true)}>
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
    <Link component="button" type="button" onClick={() => onOpen(order.id)}>
      {order.description ?? `Orden ${KIND_LABELS[order.kind].toLowerCase()}`}
    </Link>
  );
  const status = (order: BffWorkOrder) => (
    <StatusBadge label={STATUS_LABELS[order.status]} tone={STATUS_TONES[order.status]} />
  );
  const rows = shown.map((order) => ({ ...order, order }));
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
      </FilterBar>
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
                    columns={[
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
                    ]}
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
                      <Typography component="h2" variant="h6">
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
                      <Typography component="h2" variant="h6">
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
    </Box>
  );
}
