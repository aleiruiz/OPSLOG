import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import {
  Button,
  DetailTabs,
  InlineAlert,
  PageHeader,
  SeverityBadge,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { BackLink } from '../../app/BackLink';
import { useRouter } from '../../app/router';
import { errorKind } from '../maintenance/useResult';
import { useIncidentEnv } from './env';
import { EvidenceTab } from './EvidenceTab';
import { STALE_COPY } from './errors';
import { InsuranceTab } from './InsuranceTab';
import { STATUS_LABELS, STATUS_TONES, TYPE_LABELS } from './labels';
import { NextStepsPanel } from './NextStepsPanel';
import { TAB_IDS, TAB_LABELS, asTab, incidentPath, incidentsPath } from './paths';
import { SummaryTab } from './SummaryTab';
import { ThirdPartiesTab } from './ThirdPartiesTab';
import { TimelineTab } from './TimelineTab';
import { useIncident } from './useIncident';
import { useLive } from './useLive';

/**
 * Siniestro: the case in tabs (Resumen, Terceros, Evidencia, Seguro, Timeline) with the next step beside it.
 * The tab lives in the address, so a deep link and the back button land where the person was. A case that
 * does not exist or belongs to another company gets the same neutral "not found" screen.
 */
export function IncidentDetail({ id, tab }: { id: string; tab?: string | undefined }) {
  const env = useIncidentEnv();
  const router = useRouter();
  const incident = useIncident(id);
  const steps = useLive(
    () => env.ports.nextSteps(id),
    [env.ports, id, incident.data?.version],
    env.onExpired,
  );
  const [notice, setNotice] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const active = asTab(tab);
  const back = <BackLink to={incidentsPath}>Siniestros</BackLink>;

  if (incident.data === null) {
    if (incident.loading) return <UiState kind="loading" />;
    return (
      <Box>
        {back}
        {incident.error?.status === 404 ? (
          <UiState
            kind="error"
            title="No encontramos este siniestro"
            description="Puede que no exista o que no tengas acceso."
          />
        ) : (
          <UiState
            kind={incident.error ? errorKind(incident.error) : 'error'}
            actionLabel="Reintentar"
            onAction={incident.reload}
          />
        )}
      </Box>
    );
  }

  const current: BffIncident = incident.data;
  const reload = () => {
    setStale(false);
    incident.reload();
    steps.reload();
  };
  const changed = (next: BffIncident, message?: string) => {
    setStale(false);
    setNotice(message ?? null);
    incident.set(next);
  };
  const childChanged = (_version: number, message?: string) => {
    setNotice(message ?? null);
    incident.reload();
  };
  const props = { incident: current, onIncident: changed, onReload: reload };
  const child = { incident: current, onVersion: childChanged, onReload: reload };
  const content: Record<(typeof TAB_IDS)[number], React.ReactNode> = {
    summary: <SummaryTab {...props} />,
    'third-parties': <ThirdPartiesTab {...child} />,
    evidence: <EvidenceTab {...child} />,
    insurance: <InsuranceTab {...props} />,
    timeline: <TimelineTab incidentId={current.id} version={current.version} />,
  };

  return (
    <Box>
      {back}
      <PageHeader
        title={current.folio}
        description={`${TYPE_LABELS[current.type]} · ${current.vehicle.economicNumber} · ${current.vehicle.plate}`}
        eyebrow="Siniestro"
      />
      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 2, mt: -2 }}>
        <StatusBadge label={STATUS_LABELS[current.status]} tone={STATUS_TONES[current.status]} />
        {current.severity && <SeverityBadge severity={current.severity} />}
      </Stack>
      {notice && <InlineAlert severity="success">{notice}</InlineAlert>}
      {(stale || incident.error) && (
        <InlineAlert
          severity="warning"
          action={
            <Button color="inherit" onClick={reload}>
              Recargar
            </Button>
          }
        >
          {stale ? STALE_COPY : 'No pudimos actualizar el caso. Lo que ves puede estar desfasado.'}
        </InlineAlert>
      )}
      <Box
        sx={{
          display: 'grid',
          gap: 3,
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 340px' },
          alignItems: 'start',
        }}
      >
        <Box sx={{ minWidth: 0, display: 'grid', gap: 2, gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <DetailTabs
            value={active}
            onChange={(next) => router.navigate(incidentPath(id, next))}
            tabs={TAB_IDS.map((tabId) => ({
              id: tabId,
              label: TAB_LABELS[tabId],
              content: content[tabId],
            }))}
          />
        </Box>
        <Box sx={{ minWidth: 0, order: { xs: -1, lg: 0 } }}>
          <NextStepsPanel
            incident={current}
            steps={steps}
            onIncident={changed}
            onStale={() => setStale(true)}
          />
        </Box>
      </Box>
    </Box>
  );
}
