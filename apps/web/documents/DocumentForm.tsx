import Box from '@mui/material/Box';
import React from 'react';
import { Button, Field, FormSection, Notifications, opslogTokens, UiState } from '@opslog/ui';
import { RouterButton, RouterLink } from '../app/router';
import type { VehicleOptions } from '../app/vehicleOptions';
import {
  emptyValues,
  fieldOrder,
  validate,
  type DocumentFormValues,
  type FieldErrors,
  type FieldKey,
  type FormMode,
} from './formModel';
import { DOCUMENT_TYPES, typeInfo } from './rules';
import type { Document } from '../app/types';
import { ownerTypeLabels, typeLabel } from './labels';

export interface FormAlert {
  /** Errors use the recoverable-error state (with an optional action); the others are plain notices. */
  readonly severity: 'error' | 'warning' | 'info';
  readonly title?: string;
  readonly message: string;
  /** Recovery action next to the message, for example "Cargar datos actuales". */
  readonly actionLabel?: string;
}

export interface DocumentFormProps {
  readonly mode: FormMode;
  readonly initial?: DocumentFormValues;
  /** Create: the vehicles to pick the owner from. */
  readonly vehicles?: VehicleOptions;
  /** Edit and renew: the document being changed (read-only context above the fields). */
  readonly document?: Document;
  /** Edit and renew: the label of the document's owner. */
  readonly ownerName?: string;
  readonly submitting?: boolean;
  /** Field messages that came back from the server (invalid owner). */
  readonly serverErrors?: FieldErrors;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: DocumentFormValues) => void;
  /** Reports every edit, so a parent can keep unsaved values across a reload. */
  readonly onValuesChange?: (values: DocumentFormValues) => void;
  readonly cancelTo: string;
  /** Overridable clock so tests and stories are deterministic. */
  readonly now?: Date;
}

const copy: Record<FormMode, { label: string; submit: string; failure: string }> = {
  create: {
    label: 'Nuevo documento',
    submit: 'Crear documento',
    failure: 'No pudimos guardar el documento',
  },
  edit: {
    label: 'Editar documento',
    submit: 'Guardar cambios',
    failure: 'No pudimos guardar el documento',
  },
  renew: {
    label: 'Renovar documento',
    submit: 'Renovar documento',
    failure: 'No pudimos renovar el documento',
  },
};

/** Create / edit / renew form of a document. Validation mirrors the backend; the server's answers arrive as props. */
export function DocumentForm({
  mode,
  initial,
  vehicles,
  document: current,
  ownerName,
  submitting = false,
  serverErrors,
  alert = null,
  onAlertAction,
  onSubmit,
  onValuesChange,
  cancelTo,
  now = new Date(),
}: DocumentFormProps) {
  const uid = React.useId();
  const inputId = (key: FieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<DocumentFormValues>(() => initial ?? emptyValues);
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
    const found = validate(values, { mode, now, document: current });
    const first = fieldOrder.find((key) => found[key]);
    setClientErrors(found);
    if (first) focusField(first);
    else onSubmit(values);
  };

  const expiryRequired =
    mode === 'create'
      ? typeInfo('vehicle', values.typeCode)?.expiry === 'required'
      : current !== undefined &&
        typeInfo(current.ownerType, current.typeCode)?.expiry === 'required';

  const text = (
    key: FieldKey,
    label: string,
    options: { required?: boolean; description?: string; type?: string; mono?: boolean } = {},
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
      {...(options.mono
        ? { sx: { '& input': { fontFamily: opslogTokens.typography.monoFamily } } }
        : {})}
      fullWidth
    />
  );

  const select = (
    key: FieldKey,
    label: string,
    placeholder: string,
    choices: readonly { value: string; label: string }[],
    description?: string,
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
      {...(errors[key] || description ? { helperText: errors[key] ?? description } : {})}
      fullWidth
    >
      <option value="">{placeholder}</option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </Field>
  );

  const grid = { display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } };
  const validity = (
    <FormSection
      title={mode === 'renew' ? 'Nueva vigencia' : 'Vigencia'}
      description={
        expiryRequired
          ? 'Este tipo de documento siempre vence: el vencimiento es obligatorio.'
          : 'El vencimiento es opcional para este tipo de documento.'
      }
    >
      <Box sx={grid}>
        {text('issuedOn', 'Fecha de emisión', {
          type: 'date',
          description: 'Opcional. No puede ser una fecha futura.',
        })}
        {text('expiresOn', 'Fecha de vencimiento', {
          type: 'date',
          required: expiryRequired,
          description: 'Último día de vigencia, incluido.',
        })}
        {mode === 'renew' &&
          text('documentNumber', 'Número de documento', {
            mono: true,
            description: 'Opcional. Se guarda en mayúsculas.',
          })}
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
        {mode !== 'create' && current && (
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
                ['Documento', current.title],
                ['Tipo', typeLabel(current.ownerType, current.typeCode)],
                [ownerTypeLabels[current.ownerType], ownerName ?? current.ownerId],
              ] as const
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
            title="Propietario"
            description="Los campos marcados con asterisco son obligatorios."
          >
            {vehicles && vehicles.items.length === 0 ? (
              <UiState
                kind="empty"
                title="Aún no hay vehículos"
                description="Registra un vehículo antes de agregar sus documentos."
              />
            ) : (
              select(
                'ownerId',
                'Vehículo',
                'Elige un vehículo',
                (vehicles?.items ?? []).map((item) => ({ value: item.id, label: item.label })),
                vehicles?.truncated
                  ? 'Se muestran los primeros vehículos del listado.'
                  : 'Los documentos de empleados llegarán con la pantalla de Empleados.',
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
          <FormSection title="Documento">
            <Box sx={grid}>
              {mode === 'create' &&
                select(
                  'typeCode',
                  'Tipo de documento',
                  'Elige un tipo',
                  DOCUMENT_TYPES.vehicle.map((type) => ({ value: type.code, label: type.label })),
                )}
              {text('title', 'Título', {
                required: true,
                description: 'Cómo reconocerás el documento. Hasta 80 caracteres.',
              })}
              {mode === 'create' &&
                text('documentNumber', 'Número de documento', {
                  mono: true,
                  description: 'Opcional. Se guarda en mayúsculas.',
                })}
              {text('notes', 'Notas', { description: 'Opcional. Hasta 500 caracteres.' })}
            </Box>
          </FormSection>
        )}
        {mode !== 'edit' && validity}
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
