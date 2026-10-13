import React from 'react';
import Typography from '@mui/material/Typography';
import {
  Button,
  DataTable,
  Field,
  InlineAlert,
  Panel,
  SeverityBadge,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { BFF_INCIDENT_ALERT_KINDS } from '@opslog/contracts';
import type { ApiError, BffIncidentAlert, BffIncidentAlertKind } from '@opslog/contracts';
import { RouterLink, linkSx } from '../../app/router';
import { ScrollRegion } from '../../app/ScrollRegion';
import { errorKind } from '../maintenance/useResult';
import { useIncidentEnv } from './context';
import { ALERT_LABELS } from './labelsCosts';
import { alertsPath, incidentPath } from './paths';
import { formatDateTime } from './time';

const PAGE = 25;
const PREVIEW = 5;

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ApiError }
  | { readonly kind: 'ready'; readonly items: readonly BffIncidentAlert[]; readonly total: number };

/**
 * Avisos de siniestros (INC-SLA): the notices the server created for the caller (assigned, SLA 80 % and 100 %,
 * no responsible, no movement). Each one names the case by folio and links to it. `compact` is the short
 * version above the case list; the full one filters by kind and loads more. Read-only: the worker writes them.
 */
export function IncidentAlertsPanel({ compact = false }: { compact?: boolean }) {
  const env = useIncidentEnv();
  const [kind, setKind] = React.useState<'' | BffIncidentAlertKind>('');
  const [loaded, setLoaded] = React.useState<Loaded>({ kind: 'loading' });
  const [more, setMore] = React.useState<{ busy: boolean; error: boolean }>({
    busy: false,
    error: false,
  });
  const [attempt, setAttempt] = React.useState(0);
  const generation = React.useRef(0);
  const query = (offset: number) => ({
    limit: PAGE as typeof PAGE,
    offset,
    ...(kind === '' ? {} : { kind }),
  });

  React.useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    setLoaded({ kind: 'loading' });
    setMore({ busy: false, error: false });
    void env.ports.alerts.list(query(0)).then((result) => {
      if (mine !== generation.current) return;
      if (result.ok)
        setLoaded({ kind: 'ready', items: result.value.items, total: result.value.total });
      else {
        if (result.error.status === 401) env.onExpired();
        setLoaded({ kind: 'error', error: result.error });
      }
    });
  }, [env.ports, kind, attempt]);

  const loadMore = async () => {
    if (loaded.kind !== 'ready' || more.busy) return;
    const mine = generation.current;
    setMore({ busy: true, error: false });
    const result = await env.ports.alerts.list(query(loaded.items.length));
    if (mine !== generation.current) return;
    if (result.ok) {
      setMore({ busy: false, error: false });
      setLoaded({
        kind: 'ready',
        items: [...loaded.items, ...result.value.items],
        total: result.value.total,
      });
    } else {
      if (result.error.status === 401) env.onExpired();
      setMore({ busy: false, error: true });
    }
  };

  if (compact) {
    if (loaded.kind === 'loading') return null;
    if (loaded.kind === 'error')
      return (
        <InlineAlert
          severity="warning"
          action={
            <Button color="inherit" onClick={() => setAttempt((value) => value + 1)}>
              Reintentar
            </Button>
          }
        >
          No pudimos cargar los avisos de siniestros.
        </InlineAlert>
      );
    if (loaded.items.length === 0) return null;
  }

  const rows = loaded.kind === 'ready' ? loaded.items.slice(0, compact ? PREVIEW : undefined) : [];
  let body: React.ReactNode;
  if (loaded.kind === 'loading') body = <UiState kind="loading" />;
  else if (loaded.kind === 'error')
    body = (
      <UiState
        kind={errorKind(loaded.error)}
        actionLabel="Reintentar"
        onAction={() => setAttempt((value) => value + 1)}
      />
    );
  else if (rows.length === 0)
    body = (
      <UiState
        kind="empty"
        title={kind === '' ? 'No tienes avisos de siniestros' : 'Sin avisos de este tipo'}
        description="Aquí aparecen los avisos de plazos, casos sin responsable y casos sin movimiento."
      />
    );
  else
    body = (
      <>
        <ScrollRegion label="Tabla de avisos">
          <DataTable
            caption={`${rows.length} avisos`}
            rows={rows.map((alert) => ({ ...alert }))}
            columns={[
              {
                key: 'kind',
                label: 'Aviso',
                render: (_value, row) => (
                  <>
                    <StatusBadge
                      label={ALERT_LABELS[row.kind].label}
                      tone={ALERT_LABELS[row.kind].tone}
                    />
                    <Typography variant="body2" color="text.secondary">
                      {ALERT_LABELS[row.kind].detail}
                      {row.cycle > 1 ? ` (ciclo ${row.cycle})` : ''}
                    </Typography>
                  </>
                ),
              },
              {
                key: 'folio',
                label: 'Caso',
                render: (_value, row) => (
                  <RouterLink
                    to={incidentPath(row.incidentId)}
                    sx={{ ...linkSx, fontFamily: 'ui-monospace, "IBM Plex Mono", monospace' }}
                  >
                    {row.folio}
                  </RouterLink>
                ),
              },
              {
                key: 'severity',
                label: 'Gravedad',
                render: (_value, row) =>
                  row.severity ? <SeverityBadge severity={row.severity} /> : 'Sin definir',
              },
              {
                key: 'createdAt',
                label: 'Avisado',
                render: (_value, row) => formatDateTime(row.createdAt, env.zone),
              },
              {
                key: 'deadline',
                label: 'Fecha límite',
                render: (_value, row) =>
                  row.deadline === null ? 'Sin fecha' : formatDateTime(row.deadline, env.zone),
              },
            ]}
          />
        </ScrollRegion>
        {more.error && (
          <InlineAlert severity="error">
            No pudimos cargar más avisos. Intenta de nuevo.
          </InlineAlert>
        )}
        {compact && loaded.kind === 'ready' && loaded.total > rows.length && (
          <RouterLink to={alertsPath} sx={linkSx}>
            Ver los {loaded.total} avisos
          </RouterLink>
        )}
        {!compact && loaded.kind === 'ready' && loaded.items.length < loaded.total && (
          <Button variant="outlined" loading={more.busy} onClick={() => void loadMore()}>
            Cargar más avisos
          </Button>
        )}
      </>
    );

  return (
    <Panel
      title="Avisos de siniestros"
      {...(compact ? {} : { description: 'Avisos que el sistema creó para ti.' })}
      {...(compact
        ? {}
        : {
            toolbar: (
              <Field
                id="inc-alert-kind"
                label="Tipo de aviso"
                select
                SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true }}
                value={kind}
                onChange={(event) => setKind(event.target.value as '' | BffIncidentAlertKind)}
              >
                <option value="">Todos</option>
                {BFF_INCIDENT_ALERT_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {ALERT_LABELS[value].label}
                  </option>
                ))}
              </Field>
            ),
          })}
    >
      <div role="status" className="sr-only">
        {loaded.kind === 'ready' ? `${loaded.total} avisos.` : ''}
      </div>
      {body}
    </Panel>
  );
}
