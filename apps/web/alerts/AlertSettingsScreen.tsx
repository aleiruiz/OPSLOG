import React from 'react';
import { PageHeader } from '@opslog/ui';
import { ResourceView, useResource } from '../app/resource';
import type { AlertSettings, ApiError } from '../app/types';
import { useSession } from '../auth/session';
import { AlertSettingsForm, type FormAlert } from './AlertSettingsForm';
import { isUnchanged, toInput, valuesOf, type SettingsFormValues } from './settingsModel';

const RELOAD = 'Cargar datos actuales';

/** Maps a failed save to what the person sees: an alert, or (401) nothing at all (the session panel takes over). */
export function describeFailure(error: ApiError): FormAlert | null {
  const fail = (title: string, message: string, actionLabel?: string): FormAlert => ({
    severity: 'error',
    title,
    message,
    ...(actionLabel ? { actionLabel } : {}),
  });
  if (error.status === 401) return null;
  if (error.code === 'stale_version')
    return fail(
      'Otra persona cambió los ajustes',
      'Cambiaron mientras los trabajabas. Tus cambios no se guardaron. Carga los datos actuales y vuelve a hacer tus cambios.',
      RELOAD,
    );
  if (error.status === 400)
    return fail(
      'El servidor rechazó los datos',
      'Revisa los días y los destinatarios e intenta de nuevo. Tus cambios no se guardaron.',
    );
  if (error.status === 403)
    return fail(
      'No tienes permiso',
      'Cambiar los ajustes de alertas requiere permiso para administrar la configuración de la empresa.',
    );
  return fail('No pudimos guardar los ajustes', 'Intenta nuevamente.');
}

/** Unsaved edits that outlive a reload of the settings (an expired session reloads them after signing in). */
interface Draft {
  values: SettingsFormValues;
  baseVersion: number;
}

function Editor({
  settings,
  setSettings,
  reload,
  draft,
}: {
  settings: AlertSettings;
  setSettings: (settings: AlertSettings) => void;
  reload: () => void;
  draft: React.MutableRefObject<Draft | null>;
}) {
  const { ports, can, markExpired } = useSession();
  const editable = can('manage_config');
  const [submitting, setSubmitting] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  // Edits are restored only if the settings are still at the version they were made on; otherwise they could
  // silently overwrite what another person saved in the meantime.
  const [start] = React.useState(() => {
    const kept = draft.current;
    if (kept && kept.baseVersion === settings.version)
      return { values: kept.values, outdated: false };
    draft.current = null;
    return { values: valuesOf(settings), outdated: kept !== null };
  });
  const [alert, setAlert] = React.useState<FormAlert | null>(
    start.outdated
      ? {
          severity: 'warning',
          message:
            'Los ajustes cambiaron desde que empezaste. Cargamos los datos actuales: vuelve a hacer tus cambios.',
        }
      : null,
  );
  const version = settings.version;
  const versionRef = React.useRef(version);
  versionRef.current = version;
  // Stable identity: the form reports edits only when they change, never when a save moves the version on.
  const remember = React.useCallback(
    (values: SettingsFormValues) => {
      draft.current = { values, baseVersion: draft.current?.baseVersion ?? versionRef.current };
      setSaved(false);
    },
    [draft],
  );

  const submit = async (values: SettingsFormValues) => {
    if (isUnchanged(settings, values)) {
      setSaved(false);
      setAlert({ severity: 'info', message: 'No hay cambios que guardar.' });
      return;
    }
    setSubmitting(true);
    setAlert(null);
    setSaved(false);
    const result = await ports.alerts.saveSettings(toInput(values, version));
    setSubmitting(false);
    if (result.ok) {
      draft.current = null;
      setSettings(result.value);
      setSaved(true);
    } else {
      if (result.error.status === 401) markExpired();
      setAlert(describeFailure(result.error));
    }
  };

  return (
    <AlertSettingsForm
      settings={settings}
      editable={editable}
      initial={start.values}
      submitting={submitting}
      saved={saved}
      alert={alert}
      onAlertAction={() => {
        draft.current = null;
        reload();
      }}
      onValuesChange={remember}
      onSubmit={(values) => void submit(values)}
    />
  );
}

/** Alert settings screen. Reading needs `view`; changing the expiry window and the recipients needs `manage_config`. */
export function AlertSettingsScreen() {
  const { ports, can } = useSession();
  const { state, reload, setData, generation } = useResource(
    () => ports.alerts.settings(),
    [ports],
  );
  const draft = React.useRef<Draft | null>(null);
  return (
    <>
      <PageHeader
        title="Ajustes de alertas"
        description={
          can('manage_config')
            ? 'Elige con cuántos días de anticipación avisar de un vencimiento y a qué roles dirigir las alertas.'
            : 'Días de anticipación y roles a los que se dirigen las alertas de vencimiento.'
        }
      />
      <ResourceView state={state} onRetry={reload}>
        {(settings) => (
          <Editor
            key={generation}
            settings={settings}
            setSettings={setData}
            reload={reload}
            draft={draft}
          />
        )}
      </ResourceView>
    </>
  );
}
