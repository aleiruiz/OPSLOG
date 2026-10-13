import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { DescriptionList, Panel } from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { DateTime } from './DateTime';
import { SLA_LABELS } from './labelsCosts';

/**
 * Plazo de resolución: what the server calculated on this read (the screen never works out a deadline).
 * Cycles that ended before the current one keep their own result.
 */
export function SlaPanel({ incident }: { incident: BffIncident }) {
  const { sla } = incident;
  if (!sla || sla.state === 'not_started') return null;
  const items = [
    { label: 'Estado del plazo', value: SLA_LABELS[sla.state] },
    ...(sla.targetDays !== null
      ? [{ label: 'Plazo', value: `${sla.targetDays} días naturales` }]
      : []),
    { label: 'Inicio del plazo', value: <DateTime value={sla.startedAt} /> },
    { label: 'Fecha límite', value: <DateTime value={sla.deadline} /> },
    { label: 'Plazo usado', value: `${sla.elapsedPercent} %` },
    ...(sla.resolvedAt
      ? [{ label: 'Resuelto el', value: <DateTime value={sla.resolvedAt} /> }]
      : []),
  ];
  return (
    <Panel
      title="Plazo de resolución"
      {...(sla.cycle > 1 ? { description: `Ciclo ${sla.cycle}: el caso se reabrió.` } : {})}
    >
      <DescriptionList items={items} />
      {sla.previousCycles.length > 0 && (
        <Box component="ul" aria-label="Ciclos anteriores" sx={{ mt: 2, mb: 0, pl: 2.5 }}>
          {sla.previousCycles.map((cycle) => (
            <li key={cycle.cycle}>
              <Typography variant="body2">
                Ciclo {cycle.cycle}:{' '}
                {cycle.resolvedAt === null
                  ? 'sin resolver'
                  : cycle.met
                    ? 'resuelto en plazo'
                    : 'resuelto fuera de plazo'}
              </Typography>
            </li>
          ))}
        </Box>
      )}
    </Panel>
  );
}
