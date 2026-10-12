import React from 'react';
import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Button, Field, FormSection } from '@opslog/ui';
import type {
  BffMaintenanceMechanic,
  BffMaintenancePlan,
  BffMaintenanceWorkshop,
} from '@opslog/contracts';
import { useDirectory, vehicleLabel } from './directory';
import type { MaintenancePorts } from './ports';
import { VehiclePicker } from './VehiclePicker';

/** Create or edit a vehicle plan by date and/or km; editing never rewrites generated orders. */
export function PlanForm({
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
  const directory = useDirectory();
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
    if (!plan && !values['vehicleId']?.trim()) {
      setError('Elige el vehículo del plan.');
      return;
    }
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
        {plan ? (
          <Typography>Vehículo: {vehicleLabel(directory, plan.vehicleId)}</Typography>
        ) : (
          <VehiclePicker
            id="mnt-plan-vehicle"
            value={values['vehicleId'] ?? ''}
            onChange={(next) => setValues({ ...values, vehicleId: next })}
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
