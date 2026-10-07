import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import React from 'react';
import { Button, Field, FormSection, Notifications, UiState } from '@opslog/ui';
import type { DriverOptions } from '../app/driverOptions';
import { isEligibleDriver } from '../app/driverOptions';
import { RouterButton, RouterLink } from '../app/router';
import type { VehicleAssignment } from '../app/types';
import type { VehicleOptions } from '../app/vehicleOptions';
import type { FormAlert } from '../documents/DocumentForm';
import {
  assignFieldOrder,
  emptyAssign,
  emptyEnd,
  validateAssign,
  validateEnd,
  type AssignFieldErrors,
  type AssignFieldKey,
  type AssignFormValues,
  type EndFieldErrors,
  type EndFormValues,
  type FormMode,
} from './formModel';
import { formatDateTime, typeLabel, typeLabels, typeOrder } from './labels';
import { assignableVehicleStatus } from './rules';

export type { FormAlert };

export interface AssignmentFormProps {
  readonly mode: FormMode;
  /** Assign: values to start from (a vehicle or a driver chosen on the previous screen). */
  readonly initial?: Partial<AssignFormValues>;
  /** Assign: the vehicles and the drivers to pick from. */
  readonly vehicles?: VehicleOptions;
  readonly drivers?: DriverOptions;
  /** Assign: whether the session holds `edit`, which replacing the principal also needs. */
  readonly canReplace?: boolean;
  /** End: the assignment being closed, and the names of its vehicle and driver. */
  readonly assignment?: VehicleAssignment;
  readonly vehicleName?: string;
  readonly driverName?: string;
  readonly submitting?: boolean;
  /** Field messages that came back from the server. */
  readonly serverErrors?: AssignFieldErrors & EndFieldErrors;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: AssignFormValues) => void;
  /** Reports every edit, so a parent can keep unsaved values across a reload. */
  readonly onValuesChange?: (values: AssignFormValues) => void;
  readonly cancelTo: string;
}

const copy: Record<FormMode, { label: string; submit: string; failure: string }> = {
  assign: {
    label: 'Nueva asignación',
    submit: 'Crear asignación',
    failure: 'No pudimos crear la asignación',
  },
  end: {
    label: 'Cerrar asignación',
    submit: 'Cerrar asignación',
    failure: 'No pudimos cerrar la asignación',
  },
};

/** Label of the alert action that repeats the assignment as a replacement of the current principal. */
const REPLACE_ACTION = 'Reemplazar al principal actual';
const REASON_DESCRIPTION = 'Entre 1 y 200 caracteres, en una sola línea.';

/**
 * Assign / close form of a driver-vehicle assignment. Validation mirrors the backend; the server's answers arrive as
 * props. The form values of both modes share one shape (`reason` is the only field of a closure).
 */
export function AssignmentForm({
  mode,
  initial,
  vehicles,
  drivers,
  canReplace = false,
  assignment,
  vehicleName,
  driverName,
  submitting = false,
  serverErrors,
  alert = null,
  onAlertAction,
  onSubmit,
  onValuesChange,
  cancelTo,
}: AssignmentFormProps) {
  const uid = React.useId();
  const inputId = (key: AssignFieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<AssignFormValues>(() => ({
    ...(mode === 'assign' ? emptyAssign : { ...emptyAssign, ...emptyEnd }),
    ...initial,
  }));
  const [clientErrors, setClientErrors] = React.useState<AssignFieldErrors>({});
  const alertRef = React.useRef<HTMLDivElement>(null);
  const errors: AssignFieldErrors = { ...serverErrors, ...clientErrors };
  const order: readonly AssignFieldKey[] = mode === 'assign' ? assignFieldOrder : ['reason'];

  const focusField = (key: AssignFieldKey) =>
    globalThis.document.getElementById(inputId(key))?.focus();

  // A failed save moves focus to what the person must read: the first field the server rejected, else the alert.
  React.useEffect(() => {
    const first = order.find((key) => serverErrors?.[key]);
    if (first) focusField(first);
    else if (alert) alertRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverErrors, alert]);

  const changed = React.useRef(false);
  React.useEffect(() => {
    // Only real edits are reported, never the initial values.
    if (changed.current) onValuesChange?.(values);
  }, [values, onValuesChange]);

  const setField = (key: keyof AssignFormValues, value: string | boolean) => {
    changed.current = true;
    setValues((existing) => ({ ...existing, [key]: value }));
    if (key !== 'replace')
      setClientErrors((existing) => (existing[key] ? { ...existing, [key]: undefined } : existing));
  };

  const run = (next: AssignFormValues) => {
    if (submitting) return;
    const found: AssignFieldErrors =
      mode === 'assign' ? validateAssign(next) : validateEnd({ reason: next.reason });
    const first = order.find((key) => found[key]);
    setClientErrors(found);
    if (first) focusField(first);
    else onSubmit(next);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    run(values);
  };

  const replaceNow = () => {
    changed.current = true;
    const next = { ...values, type: 'principal', replace: true };
    setValues(next);
    run(next);
  };

  const text = (key: AssignFieldKey, label: string, description: string) => (
    <Field
      id={inputId(key)}
      label={label}
      value={values[key]}
      onChange={(event) => setField(key, event.target.value)}
      required
      error={Boolean(errors[key])}
      helperText={errors[key] ?? description}
      fullWidth
    />
  );

  const select = (
    key: AssignFieldKey,
    label: string,
    choices: readonly { value: string; label: string }[],
    options: { placeholder?: string; description?: string } = {},
  ) => (
    <Field
      id={inputId(key)}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={values[key]}
      onChange={(event) => setField(key, event.target.value)}
      required
      error={Boolean(errors[key])}
      {...(errors[key] || options.description
        ? { helperText: errors[key] ?? options.description }
        : {})}
      fullWidth
    >
      {options.placeholder !== undefined && <option value="">{options.placeholder}</option>}
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </Field>
  );

  const vehicleChoices = (vehicles?.items ?? [])
    .filter((item) => assignableVehicleStatus(item.status))
    .map((item) => ({ value: item.id, label: item.label }));
  const driverChoices = (drivers?.items ?? [])
    .filter(isEligibleDriver)
    .map((item) => ({ value: item.id, label: item.label }));
  const typeChoices = typeOrder.map((type) => ({ value: type, label: typeLabels[type] }));

  return (
    <form onSubmit={submit} noValidate aria-label={copy[mode].label}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}>
        {alert && (
          <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none' }}>
            {alert.severity === 'error' ? (
              <UiState
                kind="error"
                title={alert.title ?? copy[mode].failure}
                description={alert.message}
                {...(alert.actionLabel
                  ? {
                      actionLabel: alert.actionLabel,
                      onAction: alert.actionLabel === REPLACE_ACTION ? replaceNow : onAlertAction,
                    }
                  : {})}
              />
            ) : (
              <Notifications
                messages={[{ id: 'form-alert', text: alert.message, severity: alert.severity }]}
              />
            )}
          </Box>
        )}
        {mode === 'end' && assignment && (
          <>
            <Notifications
              messages={[
                {
                  id: 'end-note',
                  text: 'Cerrar una asignación no se puede deshacer: queda en el historial con su fecha de fin y no se edita. Para corregirla, crea una nueva.',
                  severity: 'info',
                },
              ]}
            />
            <Box
              component="dl"
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: 'minmax(120px, 160px) 1fr' },
                columnGap: 3,
                m: 0,
              }}
            >
              {(
                [
                  ['Vehículo', vehicleName ?? 'Vehículo de la asignación'],
                  ['Conductor', driverName ?? 'Conductor de la asignación'],
                  ['Tipo', typeLabel(assignment.type)],
                  ['Vigente desde', formatDateTime(assignment.startedAt)],
                ] as readonly (readonly [string, string])[]
              ).map(([label, value]) => (
                <React.Fragment key={label}>
                  <Box component="dt" sx={{ typography: 'body2', color: 'text.secondary' }}>
                    {label}
                  </Box>
                  <Box component="dd" sx={{ m: 0, mb: { xs: 1, sm: 0.5 } }}>
                    {value}
                  </Box>
                </React.Fragment>
              ))}
            </Box>
          </>
        )}
        {mode === 'assign' && (
          <>
            <FormSection
              title="Vehículo y conductor"
              description="Los campos marcados con asterisco son obligatorios. Solo se ofrecen vehículos que no están inactivos ni dados de baja y conductores activos."
            >
              {vehicles && vehicleChoices.length === 0 ? (
                <UiState
                  kind="empty"
                  title="No hay vehículos disponibles"
                  description="Registra un vehículo activo antes de asignarle un conductor."
                />
              ) : (
                select('vehicleId', 'Vehículo', vehicleChoices, {
                  placeholder: 'Elige un vehículo',
                  ...(vehicles?.truncated
                    ? { description: 'Se muestran los primeros vehículos del listado.' }
                    : {}),
                })
              )}
              {drivers && driverChoices.length === 0 ? (
                <UiState
                  kind="empty"
                  title="No hay conductores disponibles"
                  description="Registra o activa un conductor antes de asignarlo."
                />
              ) : (
                select('employeeId', 'Conductor', driverChoices, {
                  placeholder: 'Elige un conductor',
                  ...(drivers?.truncated
                    ? { description: 'Se muestran los primeros conductores del listado.' }
                    : {}),
                })
              )}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                <RouterLink
                  to="/flota/vehiculos/nuevo"
                  sx={{ color: 'primary.main', textDecoration: 'underline' }}
                >
                  Registrar un vehículo nuevo
                </RouterLink>
                <RouterLink
                  to="/plantilla/empleados/nuevo"
                  sx={{ color: 'primary.main', textDecoration: 'underline' }}
                >
                  Registrar un conductor nuevo
                </RouterLink>
              </Box>
            </FormSection>
            <FormSection
              title="Tipo de asignación"
              description="Un vehículo tiene a lo sumo un conductor principal vigente y un conductor es principal de a lo sumo un vehículo."
            >
              {select('type', 'Tipo', typeChoices)}
              {values.type === 'principal' &&
                (canReplace ? (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={values.replace}
                        onChange={(event) => setField('replace', event.target.checked)}
                      />
                    }
                    label="Reemplazar al conductor principal actual del vehículo, si lo hay"
                  />
                ) : (
                  <Notifications
                    messages={[
                      {
                        id: 'replace-note',
                        text: 'Si el vehículo ya tiene un principal, reemplazarlo requiere permiso para editar.',
                        severity: 'info',
                      },
                    ]}
                  />
                ))}
              {values.replace && values.type === 'principal' && (
                <Notifications
                  messages={[
                    {
                      id: 'replace-warning',
                      text: 'La asignación principal actual se cerrará con la fecha de hoy y quedará en el historial como reemplazada.',
                      severity: 'warning',
                    },
                  ]}
                />
              )}
            </FormSection>
          </>
        )}
        <FormSection
          title="Motivo"
          description={
            mode === 'assign'
              ? 'Queda en el historial de la asignación. La fecha de inicio es la de hoy y la fija el servidor.'
              : 'Queda en el historial. La fecha de fin es la de hoy y la fija el servidor.'
          }
        >
          {text(
            'reason',
            mode === 'assign' ? 'Motivo de la asignación' : 'Motivo del cierre',
            REASON_DESCRIPTION,
          )}
        </FormSection>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button type="submit" variant="contained" loading={submitting}>
            {copy[mode].submit}
          </Button>
          <RouterButton to={cancelTo} variant="text">
            Cancelar
          </RouterButton>
        </Box>
      </Box>
    </form>
  );
}

export { REPLACE_ACTION };
