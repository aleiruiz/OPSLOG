import React from 'react';
import Typography from '@mui/material/Typography';
import { Button, ConfirmDialog, InlineAlert, Panel } from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { useIncidentEnv } from './context';
import { describeError } from './errors';
import { VEHICLE_DECISION_LABELS } from './labels';
import type { VehicleDecision } from './types';

interface Proposal {
  readonly key: string;
  readonly status: VehicleDecision;
  readonly intro: string;
}

/**
 * Two things the case may ask of the vehicle (BR-I5, D11), and it never does either by itself: the proposal
 * the server computes while the vehicle cannot operate or after a total loss, and the state recorded as the
 * resolution decision. Each is applied only by an explicit action that asks for confirmation and sends the
 * reason "Siniestro <folio>" to the vehicles module.
 */
export function VehiclePanel({ incident }: { incident: BffIncident }) {
  const env = useIncidentEnv();
  const [confirming, setConfirming] = React.useState<Proposal | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const proposals: Proposal[] = [];
  if (incident.vehicleProposal)
    proposals.push({
      key: 'proposal',
      status: incident.vehicleProposal.suggestedStatus,
      intro: 'El sistema sugiere cambiar el estado del vehículo.',
    });
  const decision = incident.resolution.vehicleStatusDecision as VehicleDecision | null;
  const decided = incident.status === 'resolved' || incident.status === 'closed';
  if (decision !== null && decided && !proposals.some((item) => item.status === decision))
    proposals.push({
      key: 'decision',
      status: decision,
      intro: 'La resolución dejó registrado el estado en que queda el vehículo.',
    });
  if (proposals.length === 0) return null;
  const reason = `Siniestro ${incident.folio}`;
  const apply = async (proposal: Proposal) => {
    setBusy(true);
    setError(null);
    const result = await env.ports.vehicles.applyStatus(
      incident.vehicle.id,
      proposal.status,
      reason,
    );
    setBusy(false);
    if (result.ok) {
      setConfirming(null);
      setDone(`El vehículo quedó en «${VEHICLE_DECISION_LABELS[proposal.status]}».`);
    } else {
      if (result.error.status === 401) env.onExpired();
      setError(describeError(result.error, 'cambiar el estado del vehículo'));
    }
  };
  return (
    <Panel title="Estado del vehículo">
      {done && <InlineAlert severity="success">{done}</InlineAlert>}
      {proposals.map((proposal) => (
        <div key={proposal.key}>
          <Typography>
            {proposal.intro} Estado propuesto:{' '}
            <strong>{VEHICLE_DECISION_LABELS[proposal.status]}</strong>.
          </Typography>
          {env.mayChangeVehicles ? (
            <Button
              variant="outlined"
              sx={{ mt: 1 }}
              onClick={() => {
                setError(null);
                setDone(null);
                setConfirming(proposal);
              }}
            >
              {`Cambiar el vehículo a ${VEHICLE_DECISION_LABELS[proposal.status]}`}
            </Button>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Quien gestiona la flota puede aplicarlo desde la ficha del vehículo.
            </Typography>
          )}
        </div>
      ))}
      {confirming && (
        <ConfirmDialog
          title="Cambiar el estado del vehículo"
          description={`${incident.vehicle.economicNumber} pasará a «${VEHICLE_DECISION_LABELS[confirming.status]}» con el motivo «${reason}». Se registra en el historial del vehículo.`}
          confirmLabel="Cambiar estado"
          confirmTone="primary"
          busy={busy}
          {...(error ? { error } : {})}
          onConfirm={() => void apply(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </Panel>
  );
}
