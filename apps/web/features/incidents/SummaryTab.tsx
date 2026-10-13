import React from 'react';
import Typography from '@mui/material/Typography';
import { Button, DescriptionList, InlineAlert, Panel, SeverityBadge } from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { DateTime } from './DateTime';
import { useIncidentEnv } from './context';
import { EventForm, type SubmitOutcome } from './EventForm';
import type { EventFields } from './eventEdits';
import { TYPE_LABELS, YES_NO, ZONE_LABELS } from './labels';
import { outcomeOf } from './outcome';
import { ResolutionPanel } from './ResolutionPanel';
import { useSuggestions } from './useIncident';
import { VehiclePanel } from './VehiclePanel';
import { canWrite } from './model';
import { draftPath } from './paths';
import { useRouter } from '../../app/router';

export interface CaseProps {
  readonly incident: BffIncident;
  /** The server's answer to a change: the case as it is now. */
  readonly onIncident: (incident: BffIncident, message?: string) => void;
  /** Refreshes the case (and what hangs from it) after a conflict. */
  readonly onReload: () => void;
}

const yesNo = (value: boolean | null): string =>
  value === null ? YES_NO.unknown : value ? YES_NO.yes : YES_NO.no;

/** Resumen: the event as the server holds it, its edit form, the resolution and the vehicle proposal. */
export function SummaryTab({ incident, onIncident, onReload }: CaseProps) {
  const env = useIncidentEnv();
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const suggestions = useSuggestions(
    editing ? incident.vehicle.id : null,
    editing ? incident.occurredAt : null,
  );
  const save = async (fields: EventFields): Promise<SubmitOutcome> =>
    outcomeOf(
      await env.ports.update(incident.id, { version: incident.version, ...fields }),
      env.onExpired,
      (next) => {
        setEditing(false);
        onIncident(next, 'Cambios guardados.');
      },
      'guardar los cambios',
    );
  const damage = [
    ...incident.damage.zones.map((zone) => ZONE_LABELS[zone]),
    ...(incident.damage.description ? [incident.damage.description] : []),
  ];
  const items = [
    { label: 'Tipo', value: TYPE_LABELS[incident.type] },
    { label: 'Fecha y hora del evento', value: <DateTime value={incident.occurredAt} /> },
    { label: 'Vehículo', value: `${incident.vehicle.economicNumber} · ${incident.vehicle.plate}` },
    {
      label: 'Conductor',
      value:
        incident.driver?.displayName ??
        (incident.noDriverReason ? `Sin conductor: ${incident.noDriverReason}` : 'Sin conductor'),
    },
    { label: 'Ubicación', value: incident.location?.text ?? 'Sin ubicación' },
    {
      label: 'Gravedad',
      value: incident.severity ? <SeverityBadge severity={incident.severity} /> : 'Sin definir',
    },
    { label: 'Descripción', value: incident.description ?? 'Sin descripción' },
    { label: '¿Puede operar?', value: yesNo(incident.vehicleOperable) },
    { label: 'Daños', value: damage.length > 0 ? damage.join(' · ') : 'Sin daños registrados' },
    { label: 'Responsable', value: incident.responsible?.displayName ?? 'Sin asignar' },
    { label: 'Creado por', value: incident.createdBy.displayName },
    ...(incident.reportedBy
      ? [
          {
            label: 'Reportado por',
            value: (
              <>
                {incident.reportedBy.displayName} · <DateTime value={incident.reportedAt} />
              </>
            ),
          },
        ]
      : []),
    ...(incident.noPhotoJustification
      ? [{ label: 'Justificación sin foto', value: incident.noPhotoJustification }]
      : []),
  ];
  return (
    <>
      {incident.status === 'draft' && canWrite(incident) && (
        <InlineAlert
          severity="info"
          action={
            <Button color="inherit" onClick={() => router.navigate(draftPath(incident.id, 1))}>
              Continuar captura
            </Button>
          }
        >
          Este caso es un borrador: termina la captura y repórtalo.
        </InlineAlert>
      )}
      <Panel
        title="Datos del evento"
        actions={
          canWrite(incident) && !editing ? (
            <Button variant="outlined" onClick={() => setEditing(true)}>
              Editar datos del evento
            </Button>
          ) : undefined
        }
      >
        {editing ? (
          <EventForm
            label="Editar datos del evento"
            incident={incident}
            groups={['event', 'driver', 'photo']}
            zone={env.zone}
            suggestions={suggestions}
            drivers={env.drivers}
            onSubmit={save}
            onReload={onReload}
            actions={
              <Button variant="text" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
            }
          />
        ) : (
          <>
            <DescriptionList items={items} />
            {incident.reopenCount > 0 && (
              <Typography variant="body2" color="text.secondary">
                Este caso se reabrió{' '}
                {incident.reopenCount === 1 ? '1 vez' : `${incident.reopenCount} veces`}.
              </Typography>
            )}
          </>
        )}
      </Panel>
      <ResolutionPanel incident={incident} onIncident={onIncident} onReload={onReload} />
      <VehiclePanel incident={incident} />
    </>
  );
}
