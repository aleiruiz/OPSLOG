import React from 'react';
import Box from '@mui/material/Box';
import { CheckField, Field } from '@opslog/ui';
import { BFF_DAMAGE_ZONES, BFF_INCIDENT_SEVERITIES, BFF_INCIDENT_TYPES } from '@opslog/contracts';
import type { BffIncidentField, BffIncidentSuggestions } from '@opslog/contracts';
import type { DirectoryOption } from '../maintenance/directory';
import { VehiclePicker } from '../maintenance/VehiclePicker';
import type { EventEdits } from './eventEdits';
import { shown } from './eventEdits';
import { SEVERITY_LABELS, TYPE_LABELS, ZONE_LABELS } from './labels';
import type { BffIncident } from '@opslog/contracts';

export type EventGroup = 'event' | 'driver' | 'photo' | 'policy';

interface Props {
  readonly group: EventGroup;
  readonly idPrefix: string;
  readonly incident: BffIncident | null;
  readonly edits: EventEdits;
  readonly zone: string;
  readonly suggestions: BffIncidentSuggestions | null;
  readonly drivers: readonly DirectoryOption[];
  readonly onEdit: (edits: EventEdits) => void;
}

const select = { select: true, SelectProps: { native: true }, InputLabelProps: { shrink: true } };

/** The inputs of one group of the event form. Fields the server does not let the caller change are not drawn. */
export function EventFields({
  group,
  idPrefix,
  incident,
  edits,
  zone,
  suggestions,
  drivers,
  onEdit,
}: Props) {
  const view = shown(edits, incident, zone);
  const editable = (field: BffIncidentField) =>
    incident === null || incident.editableFields.includes(field);
  const set = (change: EventEdits) => onEdit({ ...edits, ...change });
  const id = (name: string) => `${idPrefix}-${name}`;

  if (group === 'photo')
    return editable('noPhotoJustification') ? (
      <Field
        id={id('no-photo')}
        label="Justificación si no hay foto"
        description="Obligatoria para reportar si no subes una foto que haya pasado la revisión."
        multiline
        minRows={2}
        value={view.noPhotoJustification}
        onChange={(event) => set({ noPhotoJustification: event.target.value })}
      />
    ) : null;

  if (group === 'policy') {
    const policies = suggestions?.policies ?? [];
    return editable('policyId') && policies.length > 0 ? (
      <Field
        id={id('policy')}
        label="Póliza que cubría el día del evento"
        {...select}
        value={view.policyId}
        onChange={(event) => set({ policyId: event.target.value })}
      >
        <option value="">Elige una póliza</option>
        {policies.map((policy) => (
          <option key={policy.policyId} value={policy.policyId}>
            {`${policy.insurer} · póliza ${policy.policyNumber} (vigente del ${policy.startsOn} al ${policy.endsOn})`}
          </option>
        ))}
      </Field>
    ) : null;
  }

  if (group === 'driver') {
    const suggested = suggestions?.drivers ?? [];
    const known = new Set(suggested.map((driver) => driver.employeeId));
    return (
      <>
        {editable('driverId') && (
          <Field
            id={id('driver')}
            label="Conductor"
            {...select}
            value={view.driverId}
            onChange={(event) => set({ driverId: event.target.value })}
          >
            <option value="">Sin conductor</option>
            {incident?.driver && !known.has(incident.driver.employeeId) && (
              <option value={incident.driver.employeeId}>{incident.driver.displayName}</option>
            )}
            {suggested.length > 0 && (
              <optgroup label="Asignados al vehículo en ese momento">
                {suggested.map((driver) => (
                  <option key={driver.employeeId} value={driver.employeeId}>
                    {driver.type === 'principal'
                      ? `${driver.displayName} · principal`
                      : driver.displayName}
                  </option>
                ))}
              </optgroup>
            )}
            {drivers.filter((driver) => !known.has(driver.id)).length > 0 && (
              <optgroup label="Otros conductores">
                {drivers
                  .filter((driver) => !known.has(driver.id))
                  .map((driver) => (
                    <option key={driver.id} value={driver.id}>
                      {driver.label}
                    </option>
                  ))}
              </optgroup>
            )}
          </Field>
        )}
        {editable('noDriverReason') && view.driverId === '' && (
          <Field
            id={id('no-driver')}
            label="Motivo si no hay conductor"
            multiline
            minRows={2}
            value={view.noDriverReason}
            onChange={(event) => set({ noDriverReason: event.target.value })}
          />
        )}
      </>
    );
  }

  return (
    <>
      {editable('type') && (
        <Field
          id={id('type')}
          label="Tipo de siniestro"
          required
          {...select}
          value={view.type}
          onChange={(event) => set({ type: event.target.value })}
        >
          <option value="">Elige el tipo</option>
          {BFF_INCIDENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </Field>
      )}
      {editable('vehicleId') && (
        <VehiclePicker
          id={id('vehicle')}
          value={view.vehicleId}
          onChange={(vehicleId) => set({ vehicleId })}
        />
      )}
      {editable('occurredAt') && (
        <Field
          id={id('occurred')}
          label="Fecha y hora del evento"
          type="datetime-local"
          InputLabelProps={{ shrink: true }}
          description="Hora de tu empresa. No puede ser futura."
          value={view.occurredAt}
          onChange={(event) => set({ occurredAt: event.target.value })}
        />
      )}
      {editable('location') && (
        <Field
          id={id('location')}
          label="Ubicación"
          value={view.location}
          onChange={(event) => set({ location: event.target.value })}
        />
      )}
      {editable('description') && (
        <Field
          id={id('description')}
          label="Descripción"
          multiline
          minRows={3}
          value={view.description}
          onChange={(event) => set({ description: event.target.value })}
        />
      )}
      {editable('severity') && (
        <Field
          id={id('severity')}
          label="Gravedad"
          {...select}
          value={view.severity}
          onChange={(event) => set({ severity: event.target.value })}
        >
          <option value="">Sin definir</option>
          {BFF_INCIDENT_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {SEVERITY_LABELS[severity]}
            </option>
          ))}
        </Field>
      )}
      {editable('vehicleOperable') && (
        <Field
          id={id('operable')}
          label="¿El vehículo puede operar?"
          {...select}
          value={view.operable}
          onChange={(event) => set({ operable: event.target.value })}
        >
          <option value="">Sin dato</option>
          <option value="yes">Sí, puede operar</option>
          <option value="no">No, no puede operar</option>
        </Field>
      )}
      {editable('damage') && (
        <>
          <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
            <Box component="legend" sx={{ typography: 'body2', color: 'text.secondary', mb: 0.5 }}>
              Zonas dañadas
            </Box>
            <Box
              sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)' } }}
            >
              {BFF_DAMAGE_ZONES.map((zoneId) => (
                <CheckField
                  key={zoneId}
                  label={ZONE_LABELS[zoneId]}
                  checked={view.zones.includes(zoneId)}
                  onChange={(checked) =>
                    set({
                      zones: checked
                        ? [...view.zones, zoneId]
                        : view.zones.filter((item) => item !== zoneId),
                    })
                  }
                />
              ))}
            </Box>
          </Box>
          <Field
            id={id('damage')}
            label="Descripción de los daños"
            multiline
            minRows={2}
            value={view.damageDescription}
            onChange={(event) => set({ damageDescription: event.target.value })}
          />
        </>
      )}
    </>
  );
}
