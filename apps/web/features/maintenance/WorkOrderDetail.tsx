import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Button, NextStepPanel, PageHeader, StatusBadge, Timeline, UiState } from '@opslog/ui';
import type {
  BffMaintenanceMechanic,
  BffMaintenanceWorkshop,
  BffWorkOrder,
  BffWorkOrderCommand,
} from '@opslog/contracts';
import { CommandForm } from './CommandForm';
import { SubmitKeys, submitTransition } from './idempotency';
import { EvidencePanel } from './EvidencePanel';
import {
  COMMAND_LABELS,
  COST_CATEGORY_LABELS,
  KIND_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  VEHICLE_STATUS_LABELS,
  formatDate,
  formatKm,
  formatMoney,
  historyTitle,
} from './labels';
import type { MaintenancePorts, Result } from './ports';
import { errorKind, useResult } from './useResult';
import { CostEditor, WorkEditor } from './WorkEditor';
import {
  availableCommands,
  canRecordCosts,
  canRecordWork,
  nextSteps,
  type MaintenanceViewer,
} from './workflow';

type Editing = BffWorkOrderCommand | 'work' | 'costs' | null;

/** S15: the work order, what is missing for its next step, its commands and its timeline. */
export function WorkOrderDetail({
  ports,
  viewer,
  orderId,
  workshops = [],
  mechanics = [],
  onBack,
  onExpired,
}: {
  ports: MaintenancePorts;
  viewer: MaintenanceViewer;
  orderId: string;
  workshops?: readonly BffMaintenanceWorkshop[];
  mechanics?: readonly BffMaintenanceMechanic[];
  onBack: () => void;
  onExpired: () => void;
}) {
  const { state, reload } = useResult(() => ports.orders.get(orderId), [ports, orderId], onExpired);
  const history = useResult(
    () => ports.orders.history(orderId),
    [ports, orderId, state],
    onExpired,
  );
  const [editing, setEditing] = React.useState<Editing>(null);
  const [missing, setMissing] = React.useState<readonly string[]>([]);
  const [notice, setNotice] = React.useState<{
    severity: 'success' | 'error' | 'warning';
    text: string;
  } | null>(null);
  const [stale, setStale] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [order, setOrder] = React.useState<BffWorkOrder | null>(null);
  const keys = React.useRef(new SubmitKeys());
  React.useEffect(() => {
    if (state.status === 'ready') setOrder(state.data);
  }, [state]);

  const back = (
    <Button variant="text" onClick={onBack}>
      Volver a órdenes
    </Button>
  );
  if (state.status === 'loading' && !order) return <UiState kind="loading" />;
  if (state.status === 'error' && !order)
    return (
      <Box>
        {back}
        {state.error.status === 404 ? (
          <UiState
            kind="error"
            title="No encontramos esta orden"
            description="Puede que no exista o que no tengas acceso."
          />
        ) : (
          <UiState kind={errorKind(state.error)} actionLabel="Reintentar" onAction={reload} />
        )}
      </Box>
    );
  if (!order) return <UiState kind="loading" />;

  const run = async (call: () => Promise<Result<BffWorkOrder>>, success: string) => {
    setBusy(true);
    setNotice(null);
    const result = await call();
    setBusy(false);
    if (result.ok) {
      setOrder(result.value);
      setEditing(null);
      setMissing([]);
      setStale(false);
      setNotice({ severity: 'success', text: success });
      history.reload();
      return;
    }
    const { error } = result;
    if (error.status === 401) return onExpired();
    if (error.status === 422 && error.missingRequirements) {
      setMissing(error.missingRequirements);
      setNotice({
        severity: 'warning',
        text: 'Faltan requisitos para continuar; revisa el siguiente paso.',
      });
    } else if (error.status === 409 && error.code === 'stale_version') {
      setStale(true);
    } else
      setNotice({
        severity: 'error',
        text:
          error.status === 403
            ? 'No tienes permiso para esta acción.'
            : error.status === 409
              ? 'La orden no admite esta acción en su estado actual.'
              : 'No pudimos guardar el cambio. Intenta nuevamente.',
      });
  };
  const commands = availableCommands(order, viewer);
  const viewCosts = order.costs !== undefined;
  const detail = (label: string, value: string) => (
    <Box component="div">
      <Typography component="dt" variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" sx={{ m: 0 }}>
        {value}
      </Typography>
    </Box>
  );
  return (
    <Box>
      {back}
      <PageHeader
        title={order.description ?? `Orden ${KIND_LABELS[order.kind].toLowerCase()}`}
        description={`${KIND_LABELS[order.kind]} · Vehículo ${order.vehicleId}`}
        actions={
          <StatusBadge label={STATUS_LABELS[order.status]} tone={STATUS_TONES[order.status]} />
        }
      />
      {stale && (
        <Alert
          severity="warning"
          role="alert"
          action={
            <Button
              color="inherit"
              onClick={() => {
                setStale(false);
                setMissing([]);
                reload();
              }}
            >
              Recargar
            </Button>
          }
        >
          La orden cambió mientras la editabas. Recarga para ver la versión actual; tus campos
          siguen en el formulario.
        </Alert>
      )}
      {notice && (
        <Alert
          severity={notice.severity}
          role={notice.severity === 'success' ? 'status' : 'alert'}
          sx={{ mb: 2 }}
        >
          {notice.text}
        </Alert>
      )}
      <Stack direction={{ xs: 'column', md: 'row' }} gap={3} alignItems="flex-start">
        <Stack spacing={3} sx={{ flex: 1, minWidth: 0 }}>
          <Box
            component="dl"
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 2,
              m: 0,
            }}
          >
            {detail(
              'Origen',
              order.planId ? `Plan preventivo ${order.planId}` : 'Registro correctivo',
            )}
            {detail('Responsable', order.responsibleId ?? 'Sin asignar')}
            {detail(
              'Taller',
              workshops.find((w) => w.id === order.workshopId)?.name ??
                order.workshopId ??
                'Sin taller',
            )}
            {detail(
              'Mecánico',
              mechanics.find((m) => m.id === order.mechanicId)?.name ??
                order.mechanicId ??
                'Sin mecánico',
            )}
            {detail('Fecha programada', formatDate(order.scheduledDate))}
            {detail('Fecha real', formatDate(order.actualDate))}
            {detail('Kilometraje del servicio', formatKm(order.actualKm))}
            {order.vehicleStatusDecision &&
              detail(
                'Estado del vehículo al cerrar',
                VEHICLE_STATUS_LABELS[
                  order.vehicleStatusDecision as keyof typeof VEHICLE_STATUS_LABELS
                ] ?? order.vehicleStatusDecision,
              )}
          </Box>
          <Box component="section" aria-labelledby="mnt-work-title">
            <Typography id="mnt-work-title" component="h2" variant="h6">
              Trabajos y refacciones
            </Typography>
            {order.tasks.length === 0 ? (
              <Typography color="text.secondary">Aún no hay trabajos registrados.</Typography>
            ) : (
              <ul>
                {order.tasks.map((task) => (
                  <li key={task.id}>{task.description}</li>
                ))}
              </ul>
            )}
            {order.parts.length > 0 && (
              <ul aria-label="Refacciones">
                {order.parts.map((part) => (
                  <li key={part.id}>
                    {part.name} · {part.quantity}
                    {viewCosts && part.unitCost ? ` · ${formatMoney(part.unitCost)} c/u` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Box>
          {viewCosts && (
            <Box component="section" aria-labelledby="mnt-costs-title">
              <Typography id="mnt-costs-title" component="h2" variant="h6">
                Costos
              </Typography>
              {order.costs?.length ? (
                <ul>
                  {order.costs.map((cost) => (
                    <li key={cost.id}>
                      {COST_CATEGORY_LABELS[cost.category]}: {formatMoney(cost.amount)}
                    </li>
                  ))}
                </ul>
              ) : (
                <Typography color="text.secondary">Sin costos registrados.</Typography>
              )}
            </Box>
          )}
          <EvidencePanel
            ports={ports}
            order={order}
            viewer={viewer}
            onOrder={(next) => {
              setOrder(next);
              setMissing([]);
              history.reload();
            }}
            onExpired={onExpired}
          />
          {editing === 'work' && (
            <WorkEditor
              order={order}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={(body) =>
                run(() => ports.orders.recordWork(order.id, body), 'Trabajo guardado.')
              }
            />
          )}
          {editing === 'costs' && (
            <CostEditor
              order={order}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={(body) =>
                run(() => ports.orders.recordCosts(order.id, body), 'Costos guardados.')
              }
            />
          )}
          {editing && editing !== 'work' && editing !== 'costs' && (
            <CommandForm
              key={editing}
              command={editing}
              order={order}
              workshops={workshops}
              mechanics={mechanics}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={(fields) =>
                run(
                  () =>
                    submitTransition(ports, keys.current, order.id, {
                      command: editing,
                      version: order.version,
                      ...fields,
                    }),
                  `${COMMAND_LABELS[editing]}: listo.`,
                )
              }
            />
          )}
          <Box component="section" aria-labelledby="mnt-history-title">
            <Typography id="mnt-history-title" component="h2" variant="h6">
              Historial
            </Typography>
            {history.state.status === 'ready' ? (
              <Timeline
                items={history.state.data.map((entry) => ({
                  id: String(entry.sequence),
                  title: historyTitle(entry),
                  date: entry.occurredAt.slice(0, 16).replace('T', ' '),
                  ...(entry.comment ? { description: entry.comment } : {}),
                }))}
              />
            ) : (
              <Typography color="text.secondary">
                {history.state.status === 'loading'
                  ? 'Cargando historial…'
                  : 'No pudimos cargar el historial.'}
              </Typography>
            )}
          </Box>
        </Stack>
        <Stack spacing={2} sx={{ width: { xs: '100%', md: 320 } }}>
          <NextStepPanel
            title={missing.length ? 'Falta para continuar' : 'Siguiente paso'}
            steps={nextSteps(order, missing)}
          />
          <Stack spacing={1} aria-label="Acciones de la orden">
            {commands.map((command) => (
              <Button
                key={command}
                variant={command === 'cancel' ? 'outlined' : 'contained'}
                color={command === 'cancel' ? 'error' : 'primary'}
                onClick={() => setEditing(command)}
              >
                {COMMAND_LABELS[command]}
              </Button>
            ))}
            {canRecordWork(order, viewer) && (
              <Button variant="outlined" onClick={() => setEditing('work')}>
                Registrar trabajo
              </Button>
            )}
            {canRecordCosts(order, viewer) && (
              <Button variant="outlined" onClick={() => setEditing('costs')}>
                Registrar costos
              </Button>
            )}
          </Stack>
        </Stack>
      </Stack>
    </Box>
  );
}
