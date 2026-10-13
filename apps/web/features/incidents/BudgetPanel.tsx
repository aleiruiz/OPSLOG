import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Panel, StatusBadge } from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { RouterLink, linkSx } from '../../app/router';
import { useIncidentEnv } from './context';
import { FILE_STATUS_LABELS } from './labels';
import { isFinished } from './model';
import { incidentPath } from './paths';
import { useLive } from './useLive';

const TONES = {
  pending_upload: 'warning',
  pending_scan: 'warning',
  clean: 'success',
  rejected: 'danger',
  missing: 'neutral',
} as const;

/**
 * Presupuesto: the other way to reach repair (ADR-0014). A budget is evidence of the Evidencia tab, and it
 * counts only after its review; one still in review or rejected says so and never reads as met.
 */
export function BudgetPanel({ incident }: { incident: BffIncident }) {
  const env = useIncidentEnv();
  const list = useLive(
    () => env.ports.evidence.list(incident.id),
    [env.ports, incident.id, incident.version],
    env.onExpired,
  );
  if (list.data === null) return null;
  const budgets = list.data.items.filter((item) => item.category === 'budget');
  return (
    <Panel
      title="Presupuesto"
      description="Un presupuesto revisado también permite pasar a reparación, sin orden vinculada."
    >
      {budgets.length === 0 ? (
        <Typography color="text.secondary">
          Sin presupuesto.{' '}
          {!isFinished(incident) && (
            <RouterLink to={incidentPath(incident.id, 'evidence')} sx={linkSx}>
              Subir un presupuesto en Evidencia
            </RouterLink>
          )}
        </Typography>
      ) : (
        <Box component="ul" aria-label="Presupuestos" sx={{ display: 'grid', gap: 1, p: 0, m: 0 }}>
          {budgets.map((item) => (
            <Box
              component="li"
              key={item.id}
              sx={{ listStyle: 'none', display: 'flex', gap: 1.5, flexWrap: 'wrap' }}
            >
              <Typography sx={{ overflowWrap: 'anywhere' }}>{item.displayName}</Typography>
              <StatusBadge
                label={FILE_STATUS_LABELS[item.fileStatus]}
                tone={TONES[item.fileStatus]}
              />
            </Box>
          ))}
        </Box>
      )}
    </Panel>
  );
}
