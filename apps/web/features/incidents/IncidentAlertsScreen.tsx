import Box from '@mui/material/Box';
import { PageHeader } from '@opslog/ui';
import { BackLink } from '../../app/BackLink';
import { IncidentAlertsPanel } from './IncidentAlertsPanel';
import { incidentsPath } from './paths';

/** `/incidents/avisos`: every notice of incidents the caller may see, with a filter by kind. */
export function IncidentAlertsScreen() {
  return (
    <Box>
      <BackLink to={incidentsPath}>Siniestros</BackLink>
      <PageHeader
        eyebrow="Siniestros"
        title="Avisos de siniestros"
        description="Plazos por vencer, casos sin responsable y casos sin movimiento."
      />
      <IncidentAlertsPanel />
    </Box>
  );
}
