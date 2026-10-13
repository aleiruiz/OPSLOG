import { PageHeader, UiState } from '@opslog/ui';
import { errorKind } from '../maintenance/useResult';
import { IncidentSettingsForm } from './IncidentSettingsForm';
import type { IncidentPorts } from './ports';
import { useLive } from './useLive';

/**
 * Configuración de siniestros (`/incidents/configuracion`): company settings that drive incidents. The server
 * checks `manage_config` on every save. The settings refresh in place, so a reload after a conflict keeps the form.
 */
export function IncidentSettingsScreen({
  ports,
  onExpired,
}: {
  ports: IncidentPorts;
  onExpired: () => void;
}) {
  const settings = useLive(() => ports.settings.get(), [ports], onExpired);
  return (
    <section aria-label="Configuración de siniestros">
      <PageHeader
        eyebrow="Configuración"
        title="Configuración de siniestros"
        description="Foto al reportar, plazos por gravedad, días sin movimiento y aprobación de costos."
      />
      {settings.data === null ? (
        settings.error ? (
          <UiState
            kind={errorKind(settings.error)}
            actionLabel="Reintentar"
            onAction={settings.reload}
          />
        ) : (
          <UiState kind="loading" />
        )
      ) : (
        <IncidentSettingsForm
          settings={settings.data}
          ports={ports}
          onSaved={settings.set}
          onReload={settings.reload}
          onExpired={onExpired}
        />
      )}
    </section>
  );
}
