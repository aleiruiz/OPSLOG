import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormHelperText from '@mui/material/FormHelperText';
import React from 'react';
import { Button, Field, FormSection, Notifications, UiState } from '@opslog/ui';
import type { FormAlert } from '../documents/DocumentForm';
import { RouterButton } from '../app/router';
import type { AlertRecipientRole, AlertSettings } from '../app/types';
import {
  alertsPath,
  formatDateTime,
  recipientLabels,
  recipientOrder,
  recipientSummary,
} from './labels';
import {
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  settingsFieldOrder,
  validate,
  valuesOf,
  type SettingsFieldErrors,
  type SettingsFieldKey,
  type SettingsFormValues,
} from './settingsModel';

export type { FormAlert };

export interface AlertSettingsFormProps {
  /** The settings as last read: their version is what a save carries. */
  readonly settings: AlertSettings;
  /** Only `manage_config` changes the settings; everyone else reads them. */
  readonly editable: boolean;
  readonly initial?: SettingsFormValues;
  readonly submitting?: boolean;
  readonly saved?: boolean;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: SettingsFormValues) => void;
  /** Reports every edit, so a parent can keep unsaved values across a reload. */
  readonly onValuesChange?: (values: SettingsFormValues) => void;
}

const plural = (count: number) => `${count} ${count === 1 ? 'día' : 'días'}`;

function Meta({ settings }: { settings: AlertSettings }) {
  return (
    <Box component="p" sx={{ typography: 'body2', color: 'text.secondary', m: 0 }}>
      {settings.version === 0 || settings.updatedAt === null
        ? 'Aún no se han guardado ajustes: se usan los valores por defecto.'
        : `Última actualización: ${formatDateTime(settings.updatedAt)}.`}
    </Box>
  );
}

/** Alert settings: expiry window and recipient roles. Editable with `manage_config`, read-only otherwise. */
export function AlertSettingsForm({
  settings,
  editable,
  initial,
  submitting = false,
  saved = false,
  alert = null,
  onAlertAction,
  onSubmit,
  onValuesChange,
}: AlertSettingsFormProps) {
  const uid = React.useId();
  const windowId = `${uid}-window`;
  const roleId = (role: AlertRecipientRole) => `${uid}-role-${role}`;
  const roleErrorId = `${uid}-roles-error`;
  const [values, setValues] = React.useState<SettingsFormValues>(
    () => initial ?? valuesOf(settings),
  );
  const [errors, setErrors] = React.useState<SettingsFieldErrors>({});
  const alertRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  const changed = React.useRef(false);
  React.useEffect(() => {
    // Only real edits are reported, never the initial values.
    if (changed.current) onValuesChange?.(values);
  }, [values, onValuesChange]);

  const focusField = (key: SettingsFieldKey) =>
    globalThis.document
      .getElementById(
        key === 'expiryWindowDays' ? windowId : roleId(recipientOrder[0] as AlertRecipientRole),
      )
      ?.focus();

  const edit = (next: SettingsFormValues, key: SettingsFieldKey) => {
    changed.current = true;
    setValues(next);
    setErrors((existing) => (existing[key] ? { ...existing, [key]: undefined } : existing));
  };

  const toggle = (role: AlertRecipientRole, checked: boolean) =>
    edit(
      {
        ...values,
        recipientRoles: checked
          ? recipientOrder.filter((item) => item === role || values.recipientRoles.includes(item))
          : values.recipientRoles.filter((item) => item !== role),
      },
      'recipientRoles',
    );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const found = validate(values);
    const first = settingsFieldOrder.find((key) => found[key]);
    setErrors(found);
    if (first) focusField(first);
    else onSubmit(values);
  };

  if (!editable)
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}>
        <Notifications
          messages={[
            {
              id: 'read-only',
              text: 'Solo quien administra la configuración de la empresa puede cambiar estos ajustes.',
              severity: 'info',
            },
          ]}
        />
        <Box
          component="dl"
          aria-label="Ajustes de alertas"
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 220px) 1fr' },
            columnGap: 3,
            m: 0,
          }}
        >
          {(
            [
              ['Días de anticipación', plural(settings.expiryWindowDays)],
              ['Reciben las alertas', recipientSummary(settings)],
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
        <Meta settings={settings} />
        <Box>
          <RouterButton to={alertsPath} variant="outlined">
            Ver alertas
          </RouterButton>
        </Box>
      </Box>
    );

  return (
    <form onSubmit={submit} noValidate aria-label="Ajustes de alertas">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}>
        {saved && (
          <Notifications
            messages={[{ id: 'saved', text: 'Ajustes guardados.', severity: 'success' }]}
          />
        )}
        {alert && (
          <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none' }}>
            {alert.severity === 'error' ? (
              <UiState
                kind="error"
                title={alert.title ?? 'No pudimos guardar los ajustes'}
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
          title="Anticipación"
          description="Una alerta aparece desde estos días antes de que venza un documento de vehículo o un seguro, y sigue mientras esté vencido."
        >
          <Field
            id={windowId}
            label="Días de anticipación"
            required
            disabled={submitting}
            type="number"
            inputProps={{ min: MIN_WINDOW_DAYS, max: MAX_WINDOW_DAYS, inputMode: 'numeric' }}
            value={values.expiryWindowDays}
            onChange={(event) =>
              edit({ ...values, expiryWindowDays: event.target.value }, 'expiryWindowDays')
            }
            error={Boolean(errors.expiryWindowDays)}
            helperText={
              errors.expiryWindowDays ??
              `Entre ${MIN_WINDOW_DAYS} y ${MAX_WINDOW_DAYS} días. Los estados «por vencer» de documentos y seguros siempre usan 30 días.`
            }
            sx={{
              maxWidth: 320,
              // Helper text is content, not a control: keep readable contrast while the field is locked.
              '& .MuiFormHelperText-root.Mui-disabled': { color: 'text.secondary' },
            }}
          />
        </FormSection>
        <FormSection
          title="Destinatarios"
          description="Roles a los que se dirigen las alertas. Hoy son solo un ajuste: todavía no se envía ningún aviso."
        >
          <FormGroup>
            {recipientOrder.map((role) => (
              <FormControlLabel
                key={role}
                label={recipientLabels[role]}
                control={
                  <Checkbox
                    id={roleId(role)}
                    checked={values.recipientRoles.includes(role)}
                    disabled={submitting}
                    onChange={(event) => toggle(role, event.target.checked)}
                    inputProps={
                      errors.recipientRoles
                        ? { 'aria-describedby': roleErrorId, 'aria-invalid': true }
                        : {}
                    }
                  />
                }
              />
            ))}
          </FormGroup>
          {errors.recipientRoles && (
            <FormHelperText id={roleErrorId} error>
              {errors.recipientRoles}
            </FormHelperText>
          )}
        </FormSection>
        <Meta settings={settings} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button type="submit" variant="contained" loading={submitting}>
            Guardar ajustes
          </Button>
          <RouterButton to={alertsPath} variant="text">
            Ver alertas
          </RouterButton>
        </Box>
      </Box>
    </form>
  );
}
