import React from 'react';
import Card from '@mui/material/Card';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import { Button, ConfirmWithReason, Field, FormSection } from '@opslog/ui';
import type {
  BffMaintenanceMechanic,
  BffMaintenanceWorkshop,
  BffWorkOrder,
  BffWorkOrderCommand,
  BffWorkOrderTransitionInput,
} from '@opslog/contracts';
import { OptionPicker, useDirectory } from './directory';
import { COMMAND_LABELS, VEHICLE_STATUS_LABELS } from './labels';

type Fields = Omit<BffWorkOrderTransitionInput, 'command' | 'version'>;

/**
 * The inputs one SPECS §6.1 command needs. Fields left empty are sent as absent so the server can
 * answer with its structured missing requirements instead of a local rule.
 */
export function CommandForm({
  command,
  order,
  workshops,
  mechanics,
  busy,
  onSubmit,
  onCancel,
}: {
  command: BffWorkOrderCommand;
  order: BffWorkOrder;
  workshops: readonly BffMaintenanceWorkshop[];
  mechanics: readonly BffMaintenanceMechanic[];
  busy: boolean;
  onSubmit: (fields: Fields) => void;
  onCancel: () => void;
}) {
  const directory = useDirectory();
  const [values, setValues] = React.useState<Record<string, string>>({
    responsibleId: order.responsibleId ?? '',
    workshopId: order.workshopId ?? '',
    mechanicId: order.mechanicId ?? '',
    scheduledDate: order.scheduledDate ?? '',
    actualDate: order.actualDate ?? '',
    actualKm: order.actualKm === null ? '' : String(order.actualKm),
  });
  const [requiresWorkshop, setRequiresWorkshop] = React.useState(order.workshopId !== null);
  const set = (name: string) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues({ ...values, [name]: event.target.value });
  const value = (name: string) => values[name] ?? '';
  const optional = (name: string) => (value(name).trim() ? { [name]: value(name).trim() } : {});
  const title = COMMAND_LABELS[command];

  if (command === 'cancel' || command === 'reopen')
    return (
      <ConfirmWithReason
        title={title}
        reasonLabel={command === 'cancel' ? 'Motivo de la cancelación' : 'Motivo de la reapertura'}
        onConfirm={(reason) => onSubmit({ reason })}
        onCancel={onCancel}
      />
    );
  const fields: Record<Exclude<BffWorkOrderCommand, 'cancel' | 'reopen'>, React.ReactNode> = {
    assign: (
      <>
        <OptionPicker
          id="mnt-cmd-responsible"
          label="Persona responsable"
          placeholder="Sin responsable"
          options={directory.members}
          value={value('responsibleId')}
          onChange={(next) => setValues({ ...values, responsibleId: next })}
          {...(directory.membersTruncated
            ? { description: 'Se muestran las primeras personas de la empresa.' }
            : {})}
        />
        <Field
          select
          id="mnt-cmd-workshop"
          label="Taller"
          value={value('workshopId')}
          onChange={set('workshopId')}
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
          id="mnt-cmd-mechanic"
          label="Mecánico"
          value={value('mechanicId')}
          onChange={set('mechanicId')}
        >
          <MenuItem value="">Sin mecánico</MenuItem>
          {mechanics
            .filter((m) => m.active)
            .map((m) => (
              <MenuItem key={m.id} value={m.id}>
                {m.name} ({m.kind === 'internal' ? 'interno' : 'externo'})
              </MenuItem>
            ))}
        </Field>
        <Field
          id="mnt-cmd-scheduled"
          label="Fecha programada"
          type="date"
          InputLabelProps={{ shrink: true }}
          value={value('scheduledDate')}
          onChange={set('scheduledDate')}
        />
      </>
    ),
    start: (
      <FormControlLabel
        control={
          <Checkbox
            checked={requiresWorkshop}
            onChange={(event) => setRequiresWorkshop(event.target.checked)}
          />
        }
        label="El vehículo entra a taller (queda bloqueado para operar)"
      />
    ),
    complete: (
      <>
        <Field
          id="mnt-cmd-actual-date"
          label="Fecha real del servicio"
          type="date"
          InputLabelProps={{ shrink: true }}
          value={value('actualDate')}
          onChange={set('actualDate')}
        />
        <Field
          id="mnt-cmd-actual-km"
          label="Kilometraje del servicio"
          type="number"
          inputProps={{ min: 0, step: 1 }}
          value={value('actualKm')}
          onChange={set('actualKm')}
        />
      </>
    ),
    approve_close: null,
    close: (
      <>
        <Field
          select
          id="mnt-cmd-vehicle-status"
          label="Estado del vehículo al cerrar"
          value={value('vehicleStatus')}
          onChange={set('vehicleStatus')}
          description="Se registra como decisión; el estado del vehículo se cambia desde su ficha."
        >
          <MenuItem value="">Elige un estado</MenuItem>
          {(Object.keys(VEHICLE_STATUS_LABELS) as (keyof typeof VEHICLE_STATUS_LABELS)[]).map(
            (status) => (
              <MenuItem key={status} value={status}>
                {VEHICLE_STATUS_LABELS[status]}
              </MenuItem>
            ),
          )}
        </Field>
        <Field
          id="mnt-cmd-comment"
          label="Comentario (opcional)"
          multiline
          minRows={2}
          value={value('comment')}
          onChange={set('comment')}
        />
      </>
    ),
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const km = value('actualKm').trim();
    const byCommand: Record<string, Fields> = {
      assign: {
        ...optional('responsibleId'),
        workshopId: value('workshopId') || null,
        mechanicId: value('mechanicId') || null,
        ...optional('scheduledDate'),
      },
      start: { requiresWorkshop },
      complete: { ...optional('actualDate'), ...(km ? { actualKm: Number(km) } : {}) },
      approve_close: {},
      close: { ...(optional('vehicleStatus') as Fields), ...optional('comment') },
    };
    onSubmit(byCommand[command] ?? {});
  };
  return (
    <Card component="form" aria-label={title} onSubmit={submit} sx={{ p: 2 }}>
      <FormSection title={title}>
        {fields[command]}
        <Stack direction="row" gap={1}>
          <Button type="submit" variant="contained" loading={busy}>
            {title}
          </Button>
          <Button variant="text" onClick={onCancel}>
            Volver
          </Button>
        </Stack>
      </FormSection>
    </Card>
  );
}
