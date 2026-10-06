import Box from '@mui/material/Box';
import React from 'react';
import { Button, Field, FormSection, Notifications, opslogTokens, UiState } from '@opslog/ui';
import type { FormAlert } from '../documents/DocumentForm';
import { RouterButton, RouterLink } from '../app/router';
import type { InsurancePolicy } from '../app/types';
import type { VehicleOptions } from '../app/vehicleOptions';
import {
  emptyValues,
  fieldOrder,
  validate,
  type FieldErrors,
  type FieldKey,
  type FormMode,
  type PolicyFormValues,
} from './formModel';
import { coverageLabel, coverageLabels } from './labels';
import { COVERAGE_TYPES } from './rules';

export type { FormAlert };

export interface PolicyFormProps {
  readonly mode: FormMode;
  readonly initial?: PolicyFormValues;
  /** Whether the session holds `view_costs`: only then the deductible is shown and sent. */
  readonly canViewCosts: boolean;
  /** Create: the vehicles to pick from. */
  readonly vehicles?: VehicleOptions;
  /** Edit and renew: the policy being changed (read-only context above the fields). */
  readonly policy?: InsurancePolicy;
  /** Edit and renew: the economic number of the policy's vehicle. */
  readonly vehicleName?: string;
  readonly submitting?: boolean;
  /** Field messages that came back from the server (invalid vehicle). */
  readonly serverErrors?: FieldErrors;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: PolicyFormValues) => void;
  /** Reports every edit, so a parent can keep unsaved values across a reload. */
  readonly onValuesChange?: (values: PolicyFormValues) => void;
  readonly cancelTo: string;
}

const copy: Record<FormMode, { label: string; submit: string; failure: string }> = {
  create: {
    label: 'Nueva póliza',
    submit: 'Crear póliza',
    failure: 'No pudimos guardar la póliza',
  },
  edit: {
    label: 'Editar póliza',
    submit: 'Guardar cambios',
    failure: 'No pudimos guardar la póliza',
  },
  renew: {
    label: 'Renovar póliza',
    submit: 'Renovar póliza',
    failure: 'No pudimos renovar la póliza',
  },
};

/** Create / edit / renew form of an insurance policy. Validation mirrors the backend; the server's answers arrive as props. */
export function PolicyForm({
  mode,
  initial,
  canViewCosts,
  vehicles,
  policy,
  vehicleName,
  submitting = false,
  serverErrors,
  alert = null,
  onAlertAction,
  onSubmit,
  onValuesChange,
  cancelTo,
}: PolicyFormProps) {
  const uid = React.useId();
  const inputId = (key: FieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<PolicyFormValues>(() => initial ?? emptyValues);
  const [clientErrors, setClientErrors] = React.useState<FieldErrors>({});
  const alertRef = React.useRef<HTMLDivElement>(null);
  const errors: FieldErrors = { ...serverErrors, ...clientErrors };

  const focusField = (key: FieldKey) => globalThis.document.getElementById(inputId(key))?.focus();

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
    setValues((existing) => ({ ...existing, [key]: value }));
    setClientErrors((existing) => (existing[key] ? { ...existing, [key]: undefined } : existing));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const found = validate(values, { mode, canViewCosts });
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
      type?: string;
      mono?: boolean;
      inputMode?: 'decimal';
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

  const select = (
    key: FieldKey,
    label: string,
    choices: readonly { value: string; label: string }[],
    options: { placeholder?: string; required?: boolean; description?: string } = {},
  ) => (
    <Field
      id={inputId(key)}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={values[key]}
      onChange={(event) => setField(key, event.target.value)}
      required={options.required ?? true}
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

  const grid = { display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } };
  const coverageChoices = COVERAGE_TYPES.map((type) => ({
    value: type,
    label: coverageLabels[type],
  }));

  const deductible = (
    <FormSection
      title="Deducible"
      description={
        mode === 'renew'
          ? 'Se conserva el deducible actual; cámbialo o quítalo solo si cambió.'
          : 'Opcional. Es un dato financiero: solo lo ve y lo escribe quien puede ver costos.'
      }
    >
      <Box sx={grid}>
        {select(
          'deductibleKind',
          'Tipo de deducible',
          [
            { value: 'none', label: 'Sin deducible' },
            { value: 'amount', label: 'Monto' },
            { value: 'percent', label: 'Porcentaje' },
          ],
          { required: false },
        )}
        {values.deductibleKind === 'amount' && (
          <>
            {text('deductibleAmount', 'Monto del deducible', {
              required: true,
              inputMode: 'decimal',
              description: 'Con hasta 2 decimales, por ejemplo 12500.50.',
            })}
            {text('deductibleCurrency', 'Moneda', {
              required: true,
              mono: true,
              description: 'Código de 3 letras, por ejemplo MXN.',
            })}
          </>
        )}
        {values.deductibleKind === 'percent' &&
          text('deductiblePercent', 'Porcentaje del deducible', {
            required: true,
            inputMode: 'decimal',
            description: 'Entre 0.01 y 100, por ejemplo 15.',
          })}
      </Box>
    </FormSection>
  );

  const period = (
    <FormSection
      title={mode === 'renew' ? 'Nueva vigencia' : 'Vigencia'}
      description="Ambos días, el primero y el último, cuentan como cubiertos."
    >
      <Box sx={grid}>
        {text('startsOn', 'Inicio de vigencia', { required: true, type: 'date' })}
        {text('endsOn', 'Fin de vigencia', { required: true, type: 'date' })}
      </Box>
    </FormSection>
  );

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
        {mode === 'renew' && (
          <Notifications
            messages={[
              {
                id: 'renew-note',
                text: 'Renovar guarda una revisión nueva. La anterior queda en el historial como reemplazada y no se modifica.',
                severity: 'info',
              },
            ]}
          />
        )}
        {mode !== 'create' && policy && (
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
                ['Aseguradora', policy.insurer],
                ['Vehículo', vehicleName ?? 'Vehículo de la póliza'],
                ...(mode === 'edit'
                  ? ([
                      ['Número de póliza', policy.policyNumber],
                      ['Cobertura', coverageLabel(policy.coverageType)],
                    ] as const)
                  : []),
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
        )}
        {mode === 'create' && (
          <FormSection
            title="Vehículo"
            description="Los campos marcados con asterisco son obligatorios."
          >
            {vehicles && vehicles.items.length === 0 ? (
              <UiState
                kind="empty"
                title="Aún no hay vehículos"
                description="Registra un vehículo antes de agregar su póliza."
              />
            ) : (
              select(
                'vehicleId',
                'Vehículo asegurado',
                (vehicles?.items ?? []).map((item) => ({ value: item.id, label: item.label })),
                {
                  placeholder: 'Elige un vehículo',
                  ...(vehicles?.truncated
                    ? { description: 'Se muestran los primeros vehículos del listado.' }
                    : {}),
                },
              )
            )}
            <Box sx={{ mt: 1 }}>
              <RouterLink
                to="/flota/vehiculos/nuevo"
                sx={{ color: 'primary.main', textDecoration: 'underline' }}
              >
                Registrar un vehículo nuevo
              </RouterLink>
            </Box>
          </FormSection>
        )}
        {mode !== 'renew' && (
          <FormSection title="Aseguradora">
            <Box sx={grid}>
              {text('insurer', 'Aseguradora', {
                required: true,
                description: 'Entre 2 y 80 caracteres.',
              })}
              {text('coverageNotes', 'Notas de cobertura', {
                description: 'Opcional. Hasta 500 caracteres.',
              })}
            </Box>
          </FormSection>
        )}
        {mode !== 'edit' && (
          <FormSection title="Póliza">
            <Box sx={grid}>
              {text('policyNumber', 'Número de póliza', {
                required: true,
                mono: true,
                description: 'Se guarda en mayúsculas.',
              })}
              {select('coverageType', 'Tipo de cobertura', coverageChoices, {
                placeholder: 'Elige una cobertura',
              })}
            </Box>
          </FormSection>
        )}
        {mode !== 'edit' && period}
        {mode !== 'edit' &&
          (canViewCosts ? (
            deductible
          ) : (
            <Notifications
              messages={[
                {
                  id: 'costs-note',
                  text:
                    mode === 'renew'
                      ? 'El deducible actual se conserva: cambiarlo requiere permiso para ver costos.'
                      : 'La póliza se crea sin deducible: registrarlo requiere permiso para ver costos.',
                  severity: 'info',
                },
              ]}
            />
          ))}
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
