import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Field, FormSection, Notifications, opslogTokens, UiState } from '@opslog/ui';
import { RouterButton, RouterLink } from '../app/router';
import { hasAssignableArea, type AreaChoice } from '../areas/areaChoices';
import { AreaSelect } from '../areas/AreaSelect';
import { formatKm } from './labels';
import {
  emptyValues,
  fieldOrder,
  validate,
  type FieldErrors,
  type FieldKey,
  type VehicleFormValues,
} from './formModel';
import { maxModelYear, todayOf } from './rules';

export interface FormAlert {
  /** Errors use the recoverable-error state (with an optional action); the others are plain notices. */
  readonly severity: 'error' | 'warning' | 'info';
  readonly title?: string;
  readonly message: string;
  /** Recovery action next to the message, for example "Cargar datos actuales". */
  readonly actionLabel?: string;
}

export interface VehicleFormProps {
  readonly mode: 'create' | 'edit';
  /** Values the form opens with (create: empty; edit: the loaded vehicle). */
  readonly initial?: VehicleFormValues;
  /** The company's areas, for the area selector. */
  readonly areas: readonly AreaChoice[];
  /** Edit: the odometer reading loaded with the vehicle; the form refuses a lower one. */
  readonly currentOdometerKm?: number;
  readonly submitting?: boolean;
  /** Field messages that came back from the server (duplicates, rejected odometer). */
  readonly serverErrors?: FieldErrors;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: VehicleFormValues) => void;
  /** Reports every edit, so a parent can keep unsaved values across a reload. */
  readonly onValuesChange?: (values: VehicleFormValues) => void;
  /** Where "Cancelar" goes. */
  readonly cancelTo: string;
  /** Overridable clock so tests and stories are deterministic. */
  readonly now?: Date;
}

/** Create / edit form of a vehicle. Validation mirrors the backend; the server's answers arrive as props. */
export function VehicleForm({
  mode,
  initial,
  areas,
  currentOdometerKm,
  submitting = false,
  serverErrors,
  alert = null,
  onAlertAction,
  onSubmit,
  onValuesChange,
  cancelTo,
  now = new Date(),
}: VehicleFormProps) {
  const uid = React.useId();
  const inputId = (key: FieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<VehicleFormValues>(
    () => initial ?? emptyValues(todayOf(now)),
  );
  const [clientErrors, setClientErrors] = React.useState<FieldErrors>({});
  const alertRef = React.useRef<HTMLDivElement>(null);
  const errors: FieldErrors = { ...serverErrors, ...clientErrors };

  const focusField = (key: FieldKey) => document.getElementById(inputId(key))?.focus();

  // A failed save moves focus to what the person must read: the first field the server rejected, else the alert.
  React.useEffect(() => {
    const first = fieldOrder.find((key) => serverErrors?.[key]);
    if (first) focusField(first);
    else if (alert) alertRef.current?.focus();
  }, [serverErrors, alert]);

  const changed = React.useRef(false);
  React.useEffect(() => {
    // Only real edits are reported, never the initial values.
    if (changed.current) onValuesChange?.(values);
  }, [values, onValuesChange]);

  const setField = (key: FieldKey, value: string) => {
    changed.current = true;
    setValues((current) => ({ ...current, [key]: value }));
    setClientErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const found = validate(values, { mode, now, currentOdometerKm });
    const first = fieldOrder.find((key) => found[key]);
    setClientErrors(found);
    if (first) focusField(first);
    else onSubmit(values);
  };

  const text = (
    key: FieldKey,
    label: string,
    options: {
      required?: boolean;
      description?: string;
      inputMode?: 'numeric';
      mono?: boolean;
      type?: string;
    } = {},
  ) => (
    <Field
      id={inputId(key)}
      label={label}
      value={values[key]}
      onChange={(event) => setField(key, event.target.value)}
      required={options.required ?? false}
      error={Boolean(errors[key])}
      {...(errors[key] || options.description
        ? { helperText: errors[key] ?? options.description }
        : {})}
      {...(options.type ? { type: options.type, InputLabelProps: { shrink: true } } : {})}
      inputProps={options.inputMode ? { inputMode: options.inputMode } : {}}
      {...(options.mono
        ? { sx: { '& input': { fontFamily: opslogTokens.typography.monoFamily } } }
        : {})}
      fullWidth
    />
  );

  const odometerLabel = mode === 'create' ? 'Odómetro (km)' : 'Odómetro actual (km)';
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={mode === 'create' ? 'Nuevo vehículo' : 'Editar vehículo'}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}>
        {alert && (
          <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none' }}>
            {alert.severity === 'error' ? (
              <UiState
                kind="error"
                title={alert.title ?? 'No pudimos guardar el vehículo'}
                description={alert.message}
                {...(alert.actionLabel && onAlertAction
                  ? { actionLabel: alert.actionLabel, onAction: onAlertAction }
                  : {})}
              />
            ) : (
              <Notifications
                messages={[{ id: 'form-alert', text: alert.message, severity: alert.severity }]}
              />
            )}
          </Box>
        )}
        <FormSection
          title="Identificación"
          description="Los campos marcados con asterisco son obligatorios."
        >
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
            {text('economicNumber', 'Número económico', {
              required: true,
              description: 'Único en tu empresa; no distingue mayúsculas.',
              mono: true,
            })}
            {text('plate', 'Placa', {
              required: true,
              description: 'Única en tu empresa; se guarda en mayúsculas.',
              mono: true,
            })}
            {text('vin', 'VIN', {
              description: 'Opcional. 17 caracteres, único en tu empresa.',
              mono: true,
            })}
          </Box>
        </FormSection>
        <FormSection title="Características">
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
            {text('make', 'Marca', { required: true })}
            {text('model', 'Modelo', { required: true })}
            {text('year', 'Año', {
              required: true,
              inputMode: 'numeric',
              description: `Entre 1950 y ${maxModelYear(now)}.`,
            })}
          </Box>
        </FormSection>
        <FormSection title="Operación">
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
            <Box>
              <AreaSelect
                id={inputId('areaId')}
                value={values.areaId}
                choices={areas}
                onChange={(value) => setField('areaId', value)}
                required
                error={errors.areaId}
                description={
                  hasAssignableArea(areas) ? 'Solo se pueden elegir áreas activas.' : undefined
                }
              />
              {!hasAssignableArea(areas) && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Aún no hay áreas activas.{' '}
                  <RouterLink
                    to="/plantilla/areas"
                    sx={{ color: 'primary.main', textDecoration: 'underline' }}
                  >
                    Crea o activa un área
                  </RouterLink>{' '}
                  para poder asignar el vehículo.
                </Typography>
              )}
            </Box>
            {text('odometerKm', odometerLabel, {
              required: true,
              inputMode: 'numeric',
              description:
                mode === 'edit' && currentOdometerKm !== undefined
                  ? `Lectura actual: ${formatKm(currentOdometerKm)}. Solo puede aumentar.`
                  : 'Kilómetros recorridos. Después solo podrá aumentar.',
            })}
            {mode === 'create' &&
              text('registeredOn', 'Fecha de alta', {
                required: true,
                type: 'date',
                description: 'No puede ser una fecha futura.',
              })}
          </Box>
        </FormSection>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button type="submit" variant="contained" loading={submitting}>
            {mode === 'create' ? 'Crear vehículo' : 'Guardar cambios'}
          </Button>
          <RouterButton to={cancelTo} variant="text">
            Cancelar
          </RouterButton>
        </Box>
      </Box>
    </form>
  );
}
