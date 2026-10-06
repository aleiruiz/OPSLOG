import React from 'react';
import {
  Button,
  ConfirmWithReason,
  Field,
  FormSection,
  Notifications,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { ResourceView, useResource } from '../../app/resource';
import type { CompanySettings, MfaPolicy } from '../../app/types';
import { DraftNotice, useServerDraft } from '../../auth/drafts';
import { fieldErrorMap, useSession } from '../../auth/session';

const mfaOptions: ReadonlyArray<{ value: MfaPolicy; label: string }> = [
  { value: 'disabled', label: 'No usar verificación en dos pasos' },
  { value: 'optional', label: 'Opcional para cada persona' },
  { value: 'required', label: 'Obligatoria para todas las personas' },
];

type Form = { name: string; mfa: string; sessionIdleHours: string };

function toForm(settings: CompanySettings): Form {
  return {
    name: settings.name,
    mfa: settings.mfa,
    sessionIdleHours: String(settings.sessionIdleHours),
  };
}

/** Tenant administration: company profile and security policy, behind `manage_config`. */
export function TenantAdminScreen() {
  const { ports } = useSession();
  const { state, reload } = useResource(() => ports.tenant.getCompanySettings(), [ports]);
  return (
    <>
      <PageHeader title="Empresa" description="Datos de la empresa y política de acceso." />
      <ResourceView state={state} onRetry={reload}>
        {(settings) => <CompanyForm settings={settings} />}
      </ResourceView>
    </>
  );
}

function CompanyForm({ settings }: { settings: CompanySettings }) {
  const { ports, markExpired } = useSession();
  const [saved, setSaved] = React.useState(settings);
  const draft = useServerDraft('company-settings', toForm(settings));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [confirming, setConfirming] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [outcome, setOutcome] = React.useState<'saved' | 'failed' | 'expired' | null>(null);
  const { values, setField } = draft;

  const securityChanged =
    values.mfa !== saved.mfa || Number(values.sessionIdleHours) !== saved.sessionIdleHours;

  const send = async (reason?: string) => {
    setSubmitting(true);
    setErrors({});
    setOutcome(null);
    const result = await ports.tenant.updateCompanySettings({
      name: values.name,
      mfa: values.mfa as MfaPolicy,
      sessionIdleHours: Number(values.sessionIdleHours),
      reason,
    });
    setSubmitting(false);
    setConfirming(false);
    if (result.ok) {
      setSaved(result.value);
      await draft.discard(toForm(result.value));
      setOutcome('saved');
    } else if (result.error.status === 401) {
      markExpired();
      setOutcome('expired');
    } else {
      setErrors(fieldErrorMap(result.error));
      setOutcome('failed');
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (securityChanged) setConfirming(true);
    else void send();
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Datos de la empresa">
      <FormSection
        title="Perfil y acceso"
        description="Los cambios de seguridad piden un motivo y quedan registrados."
      >
        <StatusBadge
          label={saved.status === 'active' ? 'Activa' : 'Suspendida'}
          tone={saved.status === 'active' ? 'success' : 'danger'}
          description="Estado de la empresa"
        />
        {outcome === 'saved' && (
          <Notifications
            messages={[{ id: 'saved', text: 'Cambios guardados.', severity: 'success' }]}
          />
        )}
        {outcome === 'failed' && (
          <UiState
            kind="error"
            title="No pudimos guardar los cambios"
            description="Revisa los campos marcados e intenta nuevamente."
          />
        )}
        {outcome === 'expired' && <UiState kind="session-expired" />}
        <Field
          id="company-name"
          label="Nombre de la empresa"
          required
          value={values.name}
          onChange={(event) => setField('name', event.target.value)}
          error={Boolean(errors.name)}
          helperText={errors.name}
        />
        <Field
          id="company-mfa"
          label="Verificación en dos pasos"
          select
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true }}
          value={values.mfa}
          onChange={(event) => setField('mfa', event.target.value)}
        >
          {mfaOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Field>
        <Field
          id="company-idle"
          label="Cierre de sesión por inactividad (horas)"
          type="number"
          inputProps={{ min: 1, max: 24 }}
          value={values.sessionIdleHours}
          onChange={(event) => setField('sessionIdleHours', event.target.value)}
          error={Boolean(errors.sessionIdleHours)}
          helperText={errors.sessionIdleHours}
        />
        <DraftNotice status={draft.status} />
        {confirming ? (
          <ConfirmWithReason
            title="Confirma el cambio de seguridad"
            reasonLabel="Motivo del cambio"
            onConfirm={(reason) => void send(reason)}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <Button type="submit" variant="contained" loading={submitting}>
            Guardar cambios
          </Button>
        )}
      </FormSection>
    </form>
  );
}
