import Typography from '@mui/material/Typography';
import { DescriptionList, Panel } from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { useIncidentEnv } from './context';
import { DateTime } from './DateTime';
import { formatMinor } from './money';

/**
 * Aprobación D20, for display. The server decided whether the cost needs a supervisor's approval; this panel
 * shows the threshold the company set (for callers who may see amounts), the approvals already given and
 * whether one is still pending. It never compares amounts and never decides.
 */
export function CostApproval({
  incident,
  pending,
}: {
  incident: BffIncident;
  /** A command of the next steps lists an approval as missing. */
  pending: boolean;
}) {
  const env = useIncidentEnv();
  const { assumptionApproval } = incident.insurance;
  const { closeApproval } = incident.resolution;
  const threshold = env.approvalThreshold;
  const items = [
    {
      label: 'Umbral de aprobación',
      value: threshold
        ? `${formatMinor(threshold.amountMinor, threshold.currency)}: arriba de este costo a cargo de la empresa se pide aprobación`
        : 'La empresa no tiene un umbral configurado',
    },
    {
      label: 'Aprobación de la asunción del costo',
      value: assumptionApproval ? (
        <>
          {assumptionApproval.by.displayName} · <DateTime value={assumptionApproval.at} />
        </>
      ) : (
        'Sin aprobación'
      ),
    },
    {
      label: 'Aprobación del cierre',
      value: closeApproval ? (
        <>
          {closeApproval.by.displayName} · <DateTime value={closeApproval.at} />
        </>
      ) : (
        'Sin aprobación'
      ),
    },
  ];
  return (
    <Panel
      title="Aprobación de costos"
      description="Si cambias líneas u órdenes vinculadas, las aprobaciones ya dadas se piden de nuevo."
    >
      {pending && (
        <Typography sx={{ mb: 2 }} role="status">
          El costo a cargo de la empresa necesita la aprobación de una persona supervisora antes de
          continuar.
        </Typography>
      )}
      <DescriptionList items={items} columns={1} />
    </Panel>
  );
}
