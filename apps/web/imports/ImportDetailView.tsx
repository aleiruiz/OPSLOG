import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  Field,
  Notifications,
  PageHeader,
  StatusBadge,
  Timeline,
  UiState,
} from '@opslog/ui';
import { NoSubmit, ResourceView, type ResourceState } from '../app/resource';
import { RouterLink } from '../app/router';
import type { ImportEvent, ImportJob, ImportOutcome, ImportRow } from '../app/types';
import { ImportRowsTable } from './ImportRowsTable';
import { ImportNotFound, importsPath } from './ImportMessages';
import {
  entityLabel,
  eventLabel,
  formatDateTime,
  modeLabel,
  outcomeOrder,
  outcomePresentation,
  statusPresentation,
} from './labels';

export interface RowsPage {
  readonly items: readonly ImportRow[];
  readonly nextCursor: string | null;
  readonly total: number;
}
export interface HistoryPage {
  readonly items: readonly ImportEvent[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface PagedProps<T> {
  readonly state: ResourceState<T>;
  readonly loadingMore?: boolean;
  readonly notice?: string | null;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

export interface ImportDetailViewProps {
  readonly state: ResourceState<ImportJob>;
  readonly rows: PagedProps<RowsPage> & {
    readonly outcome: ImportOutcome | '';
    readonly onOutcomeChange: (outcome: ImportOutcome | '') => void;
  };
  readonly history: PagedProps<HistoryPage>;
  readonly notice?: string | null;
  readonly downloadingErrors?: boolean;
  readonly downloadNotice?: string | null;
  readonly onDownloadErrors?: () => void;
  readonly onRetry: () => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;
const number = (value: number) => new Intl.NumberFormat('es-MX').format(value);

/** Success message of the last change; kept focusable so the result is announced and reachable. */
function FocusNotice({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => ref.current?.focus(), [text]);
  return (
    <Box ref={ref} tabIndex={-1} sx={{ outline: 'none', mb: 2 }}>
      <Notifications messages={[{ id: 'notice', text, severity: 'success' }]} />
    </Box>
  );
}

function Summary({ job }: { job: ImportJob }) {
  const status = statusPresentation[job.status];
  const rows: [string, React.ReactNode][] = [
    ['Qué se importó', entityLabel(job.entity)],
    ['Modo', modeLabel(job.mode)],
    ['Estado', <StatusBadge label={status.label} tone={status.tone} />],
    ['Filas revisadas', number(job.totalRows)],
    ['Filas válidas', number(job.validRows)],
    ['Filas con error', number(job.invalidRows)],
    ['Registros creados', number(job.importedRows)],
    ['Iniciada', formatDateTime(job.createdAt)],
    ['Terminó', job.finishedAt === null ? 'En curso' : formatDateTime(job.finishedAt)],
    ['Por', job.createdBy],
  ];
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 220px) 1fr' },
        columnGap: 3,
        rowGap: { xs: 0.5, sm: 1.5 },
        m: 0,
        maxWidth: 720,
      }}
    >
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography component="dd" variant="body1" sx={{ m: 0, mb: { xs: 1.5, sm: 0 } }}>
            {value}
          </Typography>
        </React.Fragment>
      ))}
    </Box>
  );
}

function LoadMore({
  cursor,
  loading,
  label,
  onLoadMore,
}: {
  cursor: string | null;
  loading: boolean;
  label: string;
  onLoadMore: (cursor: string) => void;
}) {
  return cursor ? (
    <Button variant="outlined" loading={loading} onClick={() => onLoadMore(cursor)}>
      {label}
    </Button>
  ) : null;
}

function Report({
  job,
  props,
  downloadingErrors = false,
  downloadNotice = null,
  onDownloadErrors,
}: {
  job: ImportJob;
  props: ImportDetailViewProps['rows'];
  downloadingErrors?: boolean;
  downloadNotice?: string | null;
  onDownloadErrors?: () => void;
}) {
  const uid = React.useId();
  return (
    <Box component="section" aria-labelledby="report-title" sx={{ mt: 4 }}>
      <Typography id="report-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Informe por fila
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Muestra la fila, el resultado, el motivo y las columnas con problema. Nunca el contenido de
        las celdas.
      </Typography>
      {job.invalidRows > 0 && onDownloadErrors && (
        <Box sx={{ mb: 2 }}>
          <Button variant="outlined" loading={downloadingErrors} onClick={onDownloadErrors}>
            Descargar CSV de errores
          </Button>
          {downloadNotice && (
            <Box sx={{ mt: 1 }}>
              <Notifications
                messages={[{ id: 'download-errors', text: downloadNotice, severity: 'error' }]}
              />
            </Box>
          )}
        </Box>
      )}
      <NoSubmit>
        <Box sx={{ maxWidth: 320, mb: 2 }}>
          <Field
            id={`${uid}-outcome`}
            label="Resultado"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={props.outcome}
            onChange={(event) => props.onOutcomeChange(event.target.value as ImportOutcome | '')}
            fullWidth
          >
            <option value="">Todas las filas</option>
            {outcomeOrder.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomePresentation[outcome].label}
              </option>
            ))}
          </Field>
        </Box>
      </NoSubmit>
      <ResourceView state={props.state} onRetry={props.onRetry}>
        {(page) =>
          page.items.length === 0 ? (
            <UiState
              kind="no-results"
              title="No hay filas con este resultado"
              description="Prueba con otro resultado."
            />
          ) : (
            <>
              <ImportRowsTable
                rows={page.items}
                entity={job.entity}
                caption={`Filas (${number(page.total)})`}
                label="Tabla de filas de la importación"
              />
              {props.notice && (
                <Box sx={{ my: 1 }}>
                  <Notifications
                    messages={[{ id: 'rows-notice', text: props.notice, severity: 'error' }]}
                  />
                </Box>
              )}
              <LoadMore
                cursor={page.nextCursor}
                loading={props.loadingMore ?? false}
                label="Cargar más filas"
                onLoadMore={props.onLoadMore}
              />
            </>
          )
        }
      </ResourceView>
    </Box>
  );
}

function History({ props }: { props: PagedProps<HistoryPage> }) {
  const { state } = props;
  return (
    <Box component="section" aria-labelledby="history-title" sx={{ mt: 4 }}>
      <Typography id="history-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Historial de la importación
      </Typography>
      {state.status === 'ready' ? (
        <>
          <Timeline
            items={state.data.items.map((entry) => ({
              id: String(entry.seq),
              title: eventLabel(entry.kind),
              description: `Por ${entry.actorId}${
                entry.acceptedRows === null || entry.rejectedRows === null
                  ? ''
                  : ` · ${number(entry.acceptedRows)} aceptadas · ${number(entry.rejectedRows)} rechazadas`
              }`,
              date: formatDateTime(entry.at),
            }))}
          />
          {props.notice && (
            <Box sx={{ my: 1 }}>
              <Notifications
                messages={[{ id: 'history-notice', text: props.notice, severity: 'error' }]}
              />
            </Box>
          )}
          <LoadMore
            cursor={state.data.nextCursor}
            loading={props.loadingMore ?? false}
            label="Cargar más historial"
            onLoadMore={props.onLoadMore}
          />
        </>
      ) : (
        <ResourceView state={state} onRetry={props.onRetry}>
          {() => null}
        </ResourceView>
      )}
    </Box>
  );
}

/** Import detail: counts, the per-row report (columns only, never values) and the append-only history of the job. */
export function ImportDetailView({
  state,
  rows,
  history,
  notice = null,
  downloadingErrors = false,
  downloadNotice = null,
  onDownloadErrors,
  onRetry,
}: ImportDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <ImportNotFound />;
  return (
    <>
      <Box sx={{ mb: 2 }}>
        <RouterLink to={importsPath} sx={linkSx}>
          Volver a importaciones
        </RouterLink>
      </Box>
      <ResourceView state={state} onRetry={onRetry}>
        {(job) => (
          <>
            <PageHeader
              title={`Importación de ${entityLabel(job.entity).toLowerCase()}`}
              description={`${modeLabel(job.mode)} · ${formatDateTime(job.createdAt)}`}
            />
            {notice && <FocusNotice text={notice} />}
            {job.status === 'running' && (
              <Box sx={{ mb: 3 }}>
                <UiState
                  kind="loading"
                  title="Importación en curso"
                  description="Sigue procesando filas. Actualiza para ver el avance."
                />
                <Button variant="outlined" onClick={onRetry}>
                  Actualizar
                </Button>
              </Box>
            )}
            {job.status === 'failed' && (
              <Box sx={{ mb: 3 }}>
                <UiState
                  kind="closed"
                  title="No se importó nada"
                  description="El modo «todo o nada» no importa si alguna fila tiene errores. Corrige el archivo en el informe y vuelve a importarlo."
                />
              </Box>
            )}
            <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
              Resumen
            </Typography>
            <Summary job={job} />
            <Report
              job={job}
              props={rows}
              downloadingErrors={downloadingErrors}
              downloadNotice={downloadNotice}
              {...(onDownloadErrors ? { onDownloadErrors } : {})}
            />
            <History props={history} />
          </>
        )}
      </ResourceView>
    </>
  );
}
