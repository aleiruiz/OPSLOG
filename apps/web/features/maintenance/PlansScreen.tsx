import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  Button,
  DataTable,
  Field,
  FormSection,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import type {
  BffMaintenanceMechanic,
  BffMaintenancePlan,
  BffMaintenanceWorkshop,
} from '@opslog/contracts';
import { formatDate, formatKm } from './labels';
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
  onExpired,
}: {
  ports: MaintenancePorts;
  viewer: MaintenanceViewer;
  workshops?: readonly BffMaintenanceWorkshop[];
  mechanics?: readonly BffMaintenanceMechanic[];
  onExpired: () => void;
}) {
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
                    {row.vehicleId}
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
        />
      )}
    </Box>
  );
}

function PlanSchedule({
  ports,
  plan,
  onEdit,
  onExpired,
}: {
  ports: MaintenancePorts;
  plan: BffMaintenancePlan;
  onEdit: (() => void) | undefined;
  onExpired: () => void;
}) {
  const { state } = useResult(
    () => ports.plans.schedule(plan.id),
    [ports, plan.id, plan.version],
    onExpired,
  );
  return (
    <Card
      component="section"
      aria-label={`Próximo servicio de ${plan.vehicleId}`}
      sx={{ p: 2, mt: 3 }}
    >
      <Typography component="h2" variant="h6">
        Próximo servicio de {plan.vehicleId}
      </Typography>
      {state.status === 'ready' ? (
        <Stack spacing={1}>
          <Typography>
            Siguiente objetivo por fecha: {formatDate(state.data.nextTargetDate)}
          </Typography>
          <Typography>
            Siguiente objetivo por kilometraje: {formatKm(state.data.nextTargetKm)}
          </Typography>
          {state.data.occurrence ? (
            <Typography>
              Orden generada por{' '}
              {state.data.occurrence.trigger === 'odometer' ? 'kilometraje' : 'fecha'} (ocurrencia{' '}
              {state.data.occurrence.sequence}).
            </Typography>
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
      {onEdit && (
        <Button variant="outlined" onClick={onEdit} sx={{ mt: 2 }}>
          Editar plan
        </Button>
      )}
    </Card>
  );
}

function PlanForm({
  ports,
  plan,
  workshops,
  mechanics,
  onSaved,
  onCancel,
  onExpired,
}: {
  ports: MaintenancePorts;
  plan: BffMaintenancePlan | null;
  workshops: readonly BffMaintenanceWorkshop[];
  mechanics: readonly BffMaintenanceMechanic[];
  onSaved: (plan: BffMaintenancePlan) => void;
  onCancel: () => void;
  onExpired: () => void;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({
    vehicleId: plan?.vehicleId ?? '',
    intervalDays: plan?.intervalDays ? String(plan.intervalDays) : '',
    intervalKm: plan?.intervalKm ? String(plan.intervalKm) : '',
    lastServiceDate: plan?.lastServiceDate ?? '',
    lastServiceKm: plan?.lastServiceKm === undefined ? '' : String(plan.lastServiceKm),
    defaultWorkshopId: plan?.defaultWorkshopId ?? '',
    defaultMechanicId: plan?.defaultMechanicId ?? '',
  });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (name: string) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues({ ...values, [name]: event.target.value });
  const number = (name: string) => (values[name]?.trim() ? { [name]: Number(values[name]) } : {});
  const text = (name: string) => (values[name]?.trim() ? { [name]: values[name]?.trim() } : {});
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!values['intervalDays']?.trim() && !values['intervalKm']?.trim()) {
      setError('Indica un intervalo por días, por kilometraje o ambos.');
      return;
    }
    const body = {
      ...number('intervalDays'),
      ...number('intervalKm'),
      ...text('lastServiceDate'),
      ...number('lastServiceKm'),
      defaultWorkshopId: values['defaultWorkshopId'] || null,
      defaultMechanicId: values['defaultMechanicId'] || null,
    };
    setBusy(true);
    const result = plan
      ? await ports.plans.update(plan.id, { version: plan.version, ...body })
      : await ports.plans.create({ vehicleId: values['vehicleId']?.trim() ?? '', ...body });
    setBusy(false);
    if (result.ok) return onSaved(result.value);
    if (result.error.status === 401) onExpired();
    setError(
      result.error.status === 409
        ? 'El plan cambió o la combinación no es válida. Recarga y revisa los datos.'
        : result.error.status === 400
          ? 'Revisa los datos: cada intervalo necesita su último servicio (fecha o kilometraje).'
          : result.error.status === 404
            ? 'No encontramos ese vehículo en tu empresa.'
            : 'No pudimos guardar el plan. Intenta nuevamente.',
    );
  };
  return (
    <Card
      component="form"
      noValidate
      aria-label={plan ? 'Editar plan' : 'Nuevo plan'}
      onSubmit={submit}
      sx={{ p: 2, mb: 3 }}
    >
      <FormSection
        title={plan ? 'Editar plan' : 'Nuevo plan'}
        description="Editar el plan no cambia las órdenes ya generadas."
      >
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        {!plan && (
          <Field
            id="mnt-plan-vehicle"
            label="Vehículo"
            required
            value={values['vehicleId']}
            onChange={set('vehicleId')}
          />
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            id="mnt-plan-days"
            label="Cada cuántos días"
            type="number"
            inputProps={{ min: 1 }}
            value={values['intervalDays']}
            onChange={set('intervalDays')}
          />
          <Field
            id="mnt-plan-last-date"
            label="Fecha del último servicio"
            type="date"
            InputLabelProps={{ shrink: true }}
            value={values['lastServiceDate']}
            onChange={set('lastServiceDate')}
          />
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            id="mnt-plan-km"
            label="Cada cuántos kilómetros"
            type="number"
            inputProps={{ min: 1 }}
            value={values['intervalKm']}
            onChange={set('intervalKm')}
          />
          <Field
            id="mnt-plan-last-km"
            label="Kilometraje del último servicio"
            type="number"
            inputProps={{ min: 0 }}
            value={values['lastServiceKm']}
            onChange={set('lastServiceKm')}
          />
        </Stack>
        <Field
          select
          id="mnt-plan-workshop"
          label="Taller por defecto"
          value={values['defaultWorkshopId']}
          onChange={set('defaultWorkshopId')}
        >
          <MenuItem value="">Sin taller</MenuItem>
          {workshops
            .filter((w) => w.active)
            .map((w) => (
              <MenuItem key={w.id} value={w.id}>
                {w.name}
              </MenuItem>
            ))}
        </Field>
        <Field
          select
          id="mnt-plan-mechanic"
          label="Mecánico por defecto"
          value={values['defaultMechanicId']}
          onChange={set('defaultMechanicId')}
        >
          <MenuItem value="">Sin mecánico</MenuItem>
          {mechanics
            .filter((m) => m.active)
            .map((m) => (
              <MenuItem key={m.id} value={m.id}>
                {m.name}
              </MenuItem>
            ))}
        </Field>
        <Stack direction="row" gap={1}>
          <Button type="submit" variant="contained" loading={busy}>
            Guardar plan
          </Button>
          <Button variant="text" onClick={onCancel}>
            Cancelar
          </Button>
        </Stack>
      </FormSection>
    </Card>
  );
}
