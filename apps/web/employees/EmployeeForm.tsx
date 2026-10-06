import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Field, FormSection, Notifications, opslogTokens, UiState } from '@opslog/ui';
import { RouterButton, RouterLink } from '../app/router';
import type { Employee, EmployeeKind } from '../app/types';
import { hasAssignableArea, type AreaChoice } from '../areas/areaChoices';
import { AreaSelect } from '../areas/AreaSelect';
import {
  emptyValues,
  fieldOrder,
  validate,
  type EmployeeFormValues,
  type FieldErrors,
  type FieldKey,
  type FormMode,
} from './formModel';
import { idTypeLabel, idTypeOrder, kindLabels, kindOrder } from './labels';
import type { FormAlert } from './messages';
import { MAX_LICENSE_DATE, MIN_DATE, hasLicense, todayOf } from './rules';

export type { FormAlert };

export interface EmployeeFormProps {
  readonly mode: FormMode;
  /** Values the form opens with (create: empty; edit: the loaded employee). */
  readonly initial?: EmployeeFormValues;
  /** The company's areas, for the area selector. */
  readonly areas: readonly AreaChoice[];
  /**
   * The session holds `view_pii`: the personal data fields exist and can be edited. Without it they are replaced by a
   * masked placeholder, and nothing personal is ever sent.
   */
  readonly canEditPii: boolean;
  /** Which personal data the loaded employee has on file (edit without `canEditPii`): presence only. */
  readonly piiPresent?: Employee['piiPresent'];
  readonly submitting?: boolean;
  /** Field messages that came back from the server (duplicates, rejected area). */
  readonly serverErrors?: FieldErrors;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: EmployeeFormValues) => void;
  /** Reports every edit, so a parent can keep unsaved values across a reload. */
  readonly onValuesChange?: (values: EmployeeFormValues) => void;
  /** Where "Cancelar" goes. */
  readonly cancelTo: string;
  /** Overridable clock so tests and stories are deterministic. */
  readonly now?: Date;
}

const grid = {
  display: 'grid',
  gap: 2,
  gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
} as const;
const mono = { '& input': { fontFamily: opslogTokens.typography.monoFamily } } as const;

const onFileNames: [keyof Employee['piiPresent'], string][] = [
  ['nationalId', 'identificación'],
  ['phone', 'teléfono'],
  ['email', 'correo'],
  ['licenseNumber', 'número de licencia'],
];

/** Create / edit form of an employee. Validation mirrors the backend; the server's answers arrive as props. */
export function EmployeeForm({
  mode,
  initial,
  areas,
  canEditPii,
  piiPresent,
  submitting = false,
  serverErrors,
  alert = null,
  onAlertAction,
  onSubmit,
  onValuesChange,
  cancelTo,
  now = new Date(),
}: EmployeeFormProps) {
  const uid = React.useId();
  const inputId = (key: FieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<EmployeeFormValues>(() => initial ?? emptyValues());
  const [clientErrors, setClientErrors] = React.useState<FieldErrors>({});
  const alertRef = React.useRef<HTMLDivElement>(null);
  const errors: FieldErrors = { ...serverErrors, ...clientErrors };
  const driver = hasLicense(values.kind as EmployeeKind);

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
    const found = validate(values, { mode, now, canEditPii });
    // Fields that are not on screen (license of a non-driver) never block the save.
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
      inputMode?: 'numeric' | 'tel' | 'email';
      mono?: boolean;
      type?: string;
      min?: string;
      max?: string;
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
      inputProps={{
        ...(options.inputMode ? { inputMode: options.inputMode } : {}),
        ...(options.min ? { min: options.min } : {}),
        ...(options.max ? { max: options.max } : {}),
      }}
      {...(options.mono ? { sx: mono } : {})}
      fullWidth
    />
  );

  const select = (
    key: 'kind' | 'idType',
    label: string,
    options: readonly { value: string; label: string }[],
    config: { required?: boolean; description?: string; empty: string; disabled?: boolean },
  ) => (
    <Field
      id={inputId(key)}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={values[key]}
      onChange={(event) => setField(key, event.target.value)}
      required={config.required ?? false}
      disabled={config.disabled ?? false}
      // The explanation of a locked field must stay readable: the disabled grey does not reach 4.5:1.
      sx={{ '& .MuiFormHelperText-root.Mui-disabled': { color: 'text.secondary' } }}
      error={Boolean(errors[key])}
      {...(errors[key] || config.description
        ? { helperText: errors[key] ?? config.description }
        : {})}
      fullWidth
    >
      <option value="">{config.empty}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Field>
  );

  // An identification type the catalog does not offer (it came from the server) must stay selectable.
  const idTypes = [
    ...idTypeOrder,
    ...(values.idType && !idTypeOrder.includes(values.idType) ? [values.idType] : []),
  ];
  const assignable = hasAssignableArea(areas);

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={mode === 'create' ? 'Nuevo empleado' : 'Editar empleado'}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}>
        {alert && (
          <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none' }}>
            {alert.severity === 'error' ? (
              <UiState
                kind="error"
                title={alert.title ?? 'No pudimos guardar el empleado'}
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
          title="Datos del empleado"
          description="Los campos marcados con asterisco son obligatorios."
        >
          <Box sx={grid}>
            {select(
              'kind',
              'Tipo de empleado',
              kindOrder.map((kind) => ({ value: kind, label: kindLabels[kind] })),
              mode === 'create'
                ? {
                    required: true,
                    empty: 'Elige un tipo',
                    description: 'Define qué datos se piden. No se puede cambiar después.',
                  }
                : {
                    empty: 'Elige un tipo',
                    disabled: true,
                    description: 'El tipo no se puede cambiar después del alta.',
                  },
            )}
            {text('employeeNumber', 'Número de empleado', {
              description: 'Opcional. Único en tu empresa; no distingue mayúsculas.',
              mono: true,
            })}
            {text('firstName', 'Nombre', { required: true })}
            {text('lastName', 'Apellidos', { required: true })}
            {text('position', 'Puesto', { description: 'Opcional.' })}
            {text('hireDate', 'Fecha de ingreso', {
              type: 'date',
              max: todayOf(now),
              min: MIN_DATE,
              description: 'Opcional. No puede ser una fecha futura.',
            })}
          </Box>
        </FormSection>
        <FormSection title="Asignación">
          <Box sx={grid}>
            <Box>
              <AreaSelect
                id={inputId('areaId')}
                value={values.areaId}
                choices={areas}
                onChange={(value) => setField('areaId', value)}
                required
                error={errors.areaId}
                description={assignable ? 'Solo se pueden elegir áreas activas.' : undefined}
              />
              {!assignable && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Aún no hay áreas activas.{' '}
                  <RouterLink
                    to="/plantilla/areas"
                    sx={{ color: 'primary.main', textDecoration: 'underline' }}
                  >
                    Crea o activa un área
                  </RouterLink>{' '}
                  para poder asignar al empleado.
                </Typography>
              )}
            </Box>
          </Box>
        </FormSection>
        {driver && (
          <FormSection
            title="Licencia de conducir"
            description="Sin tipo, vigencia y número de licencia el conductor no es apto para operar."
          >
            <Box sx={grid}>
              {text('licenseType', 'Tipo de licencia', {
                description: 'Opcional. Por ejemplo C.',
                mono: true,
              })}
              {text('licenseExpiresOn', 'Vigencia de la licencia', {
                type: 'date',
                min: MIN_DATE,
                max: MAX_LICENSE_DATE,
                description: 'Último día de vigencia, inclusive.',
              })}
              {canEditPii &&
                text('licenseNumber', 'Número de licencia', {
                  description: 'Opcional. Dato personal: se guarda cifrado.',
                  mono: true,
                })}
            </Box>
          </FormSection>
        )}
        {canEditPii ? (
          <FormSection
            title="Datos personales"
            description="Se guardan cifrados. Consultarlos queda registrado en la auditoría."
          >
            <Box sx={grid}>
              {select(
                'idType',
                'Tipo de identificación',
                idTypes.map((code) => ({ value: code, label: idTypeLabel(code) })),
                { empty: 'Sin identificación', description: 'Opcional; va junto con el número.' },
              )}
              {text('nationalId', 'Número de identificación', {
                description: 'Único en tu empresa.',
                mono: true,
              })}
              {text('phone', 'Teléfono', {
                inputMode: 'tel',
                description: 'Formato internacional, por ejemplo +52 55 5555 0100.',
                mono: true,
              })}
              {text('email', 'Correo electrónico', {
                inputMode: 'email',
                description: 'Único en tu empresa.',
              })}
            </Box>
          </FormSection>
        ) : (
          <FormSection title="Datos personales">
            <Notifications
              messages={[
                {
                  id: 'pii-protected',
                  severity: 'info',
                  text: `Los datos personales están protegidos: tu rol no permite verlos ni editarlos (identificación, teléfono, correo y número de licencia).${
                    mode === 'edit' && piiPresent
                      ? onFileNames.some(([key]) => piiPresent[key])
                        ? ` Registrados: ${onFileNames
                            .filter(([key]) => piiPresent[key])
                            .map(([, label]) => label)
                            .join(', ')}.`
                        : ' No hay datos personales registrados.'
                      : ''
                  }`,
                },
              ]}
            />
          </FormSection>
        )}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button type="submit" variant="contained" loading={submitting}>
            {mode === 'create' ? 'Crear empleado' : 'Guardar cambios'}
          </Button>
          <RouterButton to={cancelTo} variant="text">
            Cancelar
          </RouterButton>
        </Box>
      </Box>
    </form>
  );
}
