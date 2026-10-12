import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Button, DataTable, PageHeader, StatusBadge, UiState } from '@opslog/ui';
import type {
  BffMaintenanceMechanic,
  BffMaintenancePlan,
  BffMaintenanceWorkshop,
} from '@opslog/contracts';
import { useDirectory, vehicleLabel } from './directory';
import { formatDate, formatKm } from './labels';
import { MaintenanceAlertsPanel } from './MaintenanceAlertsPanel';
import { PlanForm } from './PlanForm';
import type { MaintenancePorts } from './ports';
import { errorKind, useResult } from './useResult';
import type { MaintenanceViewer } from './workflow';

const intervals = (plan: BffMaintenancePlan) =>
  [
    plan.intervalDays ? `cada ${plan.intervalDays} días` : null,
    plan.intervalKm ? `cada ${formatKm(plan.intervalKm)}` : null,
  ]
    .filter(Boolean)
    .join(' o ') + (plan.intervalDays && plan.intervalKm ? ', lo que ocurra primero' : '');

/** Plan of one vehicle by date and/or km (SPECS §6.1); no plans by type or by hours. */
export function PlansScreen({
  ports,
  viewer,
  workshops = [],
  mechanics = [],
  onOpenOrder,
  onExpired,
}: {
  ports: MaintenancePorts;
  viewer: MaintenanceViewer;
  workshops?: readonly BffMaintenanceWorkshop[];
  mechanics?: readonly BffMaintenanceMechanic[];
  onOpenOrder?: (orderId: string) => void;
  onExpired: () => void;
}) {
  const directory = useDirectory();
  const { state, reload } = useResult(() => ports.plans.list(), [ports], onExpired);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<'create' | 'edit' | null>(null);
  const header = (
    <PageHeader
      title="Planes de mantenimiento"
      description="Por vehículo, por fecha y/o kilometraje: la orden se crea al alcanzar el primer objetivo."
      actions={
        viewer.permissions.includes('create') && form === null ? (
          <Button variant="contained" onClick={() => setForm('create')}>
            Nuevo plan
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
  const plans = state.data;
  const current = plans.find((plan) => plan.id === selected) ?? null;
  return (
    <Box>
      {header}
      {form && (
        <PlanForm
          ports={ports}
          plan={form === 'edit' ? current : null}
          workshops={workshops}
          mechanics={mechanics}
          onExpired={onExpired}
          onCancel={() => setForm(null)}
          onSaved={(plan) => {
            setForm(null);
            setSelected(plan.id);
            reload();
          }}
        />
      )}
      {plans.length === 0 ? (
        <UiState
          kind="empty"
          title="Aún no hay planes"
          description="Crea un plan para que las órdenes preventivas se generen solas."
        />
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <DataTable
            caption={`${plans.length} planes`}
            rows={plans.map((plan) => ({ ...plan, plan }))}
            columns={[
              {
                key: 'vehicleId',
                label: 'Vehículo',
                render: (_value, row) => (
                  <Link component="button" type="button" onClick={() => setSelected(row.id)}>
                    {vehicleLabel(directory, row.vehicleId)}
                  </Link>
                ),
              },
              { key: 'plan', label: 'Intervalo', render: (_value, row) => intervals(row.plan) },
              {
                key: 'lastServiceDate',
                label: 'Último servicio',
                render: (_value, row) =>
                  `${formatDate(row.lastServiceDate ?? null)} · ${formatKm(row.lastServiceKm ?? null)}`,
              },
              {
                key: 'state',
                label: 'Estado',
                render: (_value, row) => (
                  <StatusBadge
                    label={row.state === 'active' ? 'Activo' : 'Pausado'}
                    tone={row.state === 'active' ? 'success' : 'neutral'}
                  />
                ),
              },
            ]}
          />
        </Box>
      )}
      {current && (
        <PlanSchedule
          ports={ports}
          plan={current}
          onExpired={onExpired}
          onEdit={viewer.permissions.includes('edit') ? () => setForm('edit') : undefined}
          onOpenOrder={viewer.permissions.includes('create') ? onOpenOrder : undefined}
        />
      )}
    </Box>
  );
}

function PlanSchedule({
  ports,
  plan,
  onEdit,
  onOpenOrder,
  onExpired,
}: {
  ports: MaintenancePorts;
  plan: BffMaintenancePlan;
  onEdit: (() => void) | undefined;
  onOpenOrder: ((orderId: string) => void) | undefined;
  onExpired: () => void;
}) {
  const directory = useDirectory();
  const vehicle = vehicleLabel(directory, plan.vehicleId);
  const [opening, setOpening] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // A generated preventive order becomes a work order (same id) the first time someone opens it.
  const openOrder = async (orderId: string) => {
    if (!onOpenOrder) return;
    setOpening(true);
    setFailed(false);
    const result = await ports.orders.adoptPreventive({
      planId: plan.id,
      scheduledOrderId: orderId,
    });
    setOpening(false);
    if (result.ok || result.error.code === 'duplicate') return onOpenOrder(orderId);
    if (result.error.status === 401) onExpired();
    setFailed(true);
  };
  const { state } = useResult(
    () => ports.plans.schedule(plan.id),
    [ports, plan.id, plan.version],
    onExpired,
  );
  return (
    <Card component="section" aria-label={`Próximo servicio de ${vehicle}`} sx={{ p: 2, mt: 3 }}>
      <Typography component="h2" variant="h6">
        Próximo servicio de {vehicle}
      </Typography>
      {state.status === 'ready' ? (
        <Stack spacing={1}>
          <Typography>
            Siguiente objetivo por fecha: {formatDate(state.data.nextTargetDate)}
          </Typography>
          <Typography>
            Siguiente objetivo por kilometraje: {formatKm(state.data.nextTargetKm)}
          </Typography>
          {state.data.occurrence?.state === 'scheduled' ? (
            <>
              <Typography>
                Orden generada por{' '}
                {state.data.occurrence.trigger === 'odometer' ? 'kilometraje' : 'fecha'} (ocurrencia{' '}
                {state.data.occurrence.sequence}).
              </Typography>
              {state.data.order && onOpenOrder && (
                <Box>
                  <Button
                    variant="contained"
                    loading={opening}
                    onClick={() => void openOrder(state.data.order?.id as string)}
                  >
                    Abrir orden de trabajo
                  </Button>
                </Box>
              )}
              {failed && (
                <Alert severity="error" role="alert">
                  No pudimos abrir la orden. Intenta nuevamente.
                </Alert>
              )}
            </>
          ) : (
            <Typography color="text.secondary">
              Todavía no se alcanza ningún objetivo; la orden se crea al alcanzar el primero.
            </Typography>
          )}
        </Stack>
      ) : (
        <Typography color="text.secondary">
          {state.status === 'loading' ? 'Cargando…' : 'No pudimos cargar el próximo servicio.'}
        </Typography>
      )}
      <MaintenanceAlertsPanel
        ports={ports}
        planId={plan.id}
        title={`Alertas de ${vehicle}`}
        onExpired={onExpired}
      />
      {onEdit && (
        <Button variant="outlined" onClick={onEdit} sx={{ mt: 2 }}>
          Editar plan
        </Button>
      )}
    </Card>
  );
}
