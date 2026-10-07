import React from 'react';
import { PageHeader } from '@opslog/ui';
import { AlertSettingsForm, type AlertSettingsFormProps } from './AlertSettingsForm';
import { AlertsSummaryView } from './AlertsSummary';
import { makeSettings, unsavedSettings } from './fixtures';
import { Frame, noop } from './storyFrame';

export default {
  title: 'Configuración/Alertas',
  parameters: { layout: 'padded' },
};

const form = (props: Partial<AlertSettingsFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Ajustes de alertas"
      description="Elige con cuántos días de anticipación avisar de un vencimiento y a qué roles dirigir las alertas."
    />
    <AlertSettingsForm settings={makeSettings()} editable onSubmit={noop} {...props} />
  </Frame>
);
const readOnly = (props: Partial<AlertSettingsFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Ajustes de alertas"
      description="Días de anticipación y roles a los que se dirigen las alertas de vencimiento."
    />
    <AlertSettingsForm settings={makeSettings()} editable={false} onSubmit={noop} {...props} />
  </Frame>
);

export const Unsaved = { render: () => form({ settings: unsavedSettings }) };
export const Saved = { render: () => form() };
export const JustSaved = { render: () => form({ saved: true }) };
export const Saving = { render: () => form({ submitting: true }) };
export const EveryRole = {
  render: () =>
    form({
      settings: makeSettings({
        expiryWindowDays: 7,
        recipientRoles: ['admin', 'editor', 'viewer', 'auditor', 'pii_reader'],
      }),
    }),
};
export const Conflict = {
  render: () =>
    form({
      alert: {
        severity: 'error',
        title: 'Otra persona cambió los ajustes',
        message:
          'Cambiaron mientras los trabajabas. Tus cambios no se guardaron. Carga los datos actuales y vuelve a hacer tus cambios.',
        actionLabel: 'Cargar datos actuales',
      },
      onAlertAction: noop,
    }),
};
export const Outdated = {
  render: () =>
    form({
      alert: {
        severity: 'warning',
        message:
          'Los ajustes cambiaron desde que empezaste. Cargamos los datos actuales: vuelve a hacer tus cambios.',
      },
    }),
};
export const Rejected = {
  render: () =>
    form({
      alert: {
        severity: 'error',
        title: 'El servidor rechazó los datos',
        message:
          'Revisa los días y los destinatarios e intenta de nuevo. Tus cambios no se guardaron.',
      },
    }),
};
export const NoPermissionToSave = {
  render: () =>
    form({
      alert: {
        severity: 'error',
        title: 'No tienes permiso',
        message:
          'Cambiar los ajustes de alertas requiere permiso para administrar la configuración de la empresa.',
      },
    }),
};
export const ReadOnly = { render: () => readOnly() };
export const ReadOnlyUnsaved = { render: () => readOnly({ settings: unsavedSettings }) };

const summary = (state: Parameters<typeof AlertsSummaryView>[0]['state']) => (
  <Frame>
    <PageHeader title="Inicio" description="Esta es la cuenta de Transportes Demo SA." />
    <AlertsSummaryView state={state} onRetry={noop} />
  </Frame>
);
export const HomeSummary = {
  render: () => summary({ status: 'ready', data: { expired: 12, expiring: 22, windowDays: 30 } }),
};
export const HomeSummaryNothingPending = {
  render: () => summary({ status: 'ready', data: { expired: 0, expiring: 0, windowDays: 30 } }),
};
export const HomeSummaryLoading = { render: () => summary({ status: 'loading' }) };
export const HomeSummaryFailed = {
  render: () =>
    summary({
      status: 'error',
      error: { code: 'internal_error', status: 500, message: 'x', correlationId: 'c' },
    }),
};
