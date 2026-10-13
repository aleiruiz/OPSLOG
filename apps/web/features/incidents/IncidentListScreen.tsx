import React from 'react';
import AddOutlined from '@mui/icons-material/AddOutlined';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import {
  Button,
  DataTable,
  Field,
  FilterBar,
  InlineAlert,
  PageHeader,
  Panel,
  UiState,
} from '@opslog/ui';
import { BFF_INCIDENT_SEVERITIES, BFF_INCIDENT_TYPES } from '@opslog/contracts';
import type {
  BffIncident,
  BffIncidentSeverity,
  BffIncidentStatus,
  BffIncidentType,
  BffIncidentsQuery,
  Page,
} from '@opslog/contracts';
import { RouterButton, useRouter } from '../../app/router';
import { ScrollRegion } from '../../app/ScrollRegion';
import { errorKind } from '../maintenance/useResult';
import { useIncidentEnv } from './context';
import { mayStartIncident } from './model';
import { OPEN_STATUSES, SEVERITY_LABELS, STATUS_LABELS, TYPE_LABELS } from './labels';
import { incidentColumns } from './listColumns';
import { IncidentAlertsPanel } from './IncidentAlertsPanel';
import { newIncidentPath, incidentsPath } from './paths';
import type { ApiError } from '@opslog/contracts';

const SIZES = [25, 50, 100] as const;
type Size = (typeof SIZES)[number];

/** Filters as the address keeps them, so a link or a reload shows the same list. */
interface Filters {
  readonly status: string;
  readonly severity: string;
  readonly type: string;
  readonly responsible: boolean;
  readonly createdBy: boolean;
  readonly limit: Size;
}
const NONE: Filters = {
  status: '',
  severity: '',
  type: '',
  responsible: false,
  createdBy: false,
  limit: 25,
};
const OPEN = OPEN_STATUSES.join(',');

const QUICK: readonly { readonly label: string; readonly filters: Partial<Filters> }[] = [
  { label: 'Mis casos', filters: { responsible: true } },
  { label: 'Mis borradores', filters: { createdBy: true, status: 'draft' } },
  { label: 'Críticos', filters: { severity: 'critical' } },
  { label: 'Abiertos', filters: { status: OPEN } },
];

function readFilters(search: URLSearchParams): Filters {
  const limit = Number(search.get('limit'));
  return {
    status: search.get('status') ?? '',
    severity: search.get('severity') ?? '',
    type: search.get('type') ?? '',
    responsible: search.get('responsible') === 'me',
    createdBy: search.get('createdBy') === 'me',
    limit: SIZES.find((size) => size === limit) ?? 25,
  };
}
function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.type) params.set('type', filters.type);
  if (filters.responsible) params.set('responsible', 'me');
  if (filters.createdBy) params.set('createdBy', 'me');
  if (filters.limit !== 25) params.set('limit', String(filters.limit));
  const text = params.toString();
  return text ? `?${text}` : '';
}
const sameQuick = (filters: Filters, quick: Partial<Filters>): boolean =>
  (Object.keys(quick) as (keyof Filters)[]).every((key) => filters[key] === quick[key]);

function apiQuery(filters: Filters, cursor?: string): BffIncidentsQuery {
  return {
    limit: filters.limit,
    ...(cursor ? { cursor } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.severity ? { severity: filters.severity as BffIncidentSeverity } : {}),
    ...(filters.type ? { type: filters.type as BffIncidentType } : {}),
    ...(filters.responsible ? { responsible: 'me' as const } : {}),
    ...(filters.createdBy ? { createdBy: 'me' as const } : {}),
    sort: 'occurredAt',
    direction: 'desc',
  };
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ApiError }
  | {
      readonly kind: 'ready';
      readonly rows: readonly BffIncident[];
      readonly page: Page<BffIncident>;
    };

/**
 * Siniestros: the company's cases, newest event first, with quick filters ("Mis casos", "Mis borradores",
 * "Críticos", "Abiertos") and selects for state, type and severity. Filters live in the address. The table
 * scrolls inside its own region at 360 px, so the page never does. "Cargar más" follows the server cursor.
 */
export function IncidentListScreen() {
  const env = useIncidentEnv();
  const router = useRouter();
  const filters = readFilters(router.search);
  const key = toQuery(filters);
  const [loaded, setLoaded] = React.useState<Loaded>({ kind: 'loading' });
  const [more, setMore] = React.useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const [attempt, setAttempt] = React.useState(0);
  const generation = React.useRef(0);

  // The list restarts (no stale rows from another filter) before the browser paints the new filters.
  React.useLayoutEffect(() => {
    generation.current += 1;
    setLoaded({ kind: 'loading' });
    setMore({ busy: false, error: null });
  }, [key, attempt]);
  React.useEffect(() => {
    const mine = generation.current;
    void env.ports.list(apiQuery(filters)).then((result) => {
      if (mine !== generation.current) return;
      if (result.ok) setLoaded({ kind: 'ready', rows: result.value.items, page: result.value });
      else {
        if (result.error.status === 401) env.onExpired();
        setLoaded({ kind: 'error', error: result.error });
      }
    });
  }, [env.ports, key, attempt]);

  const apply = (next: Partial<Filters>) =>
    router.navigate(`${incidentsPath}${toQuery({ ...filters, ...next })}`, { replace: true });
  const loadMore = async () => {
    if (loaded.kind !== 'ready' || loaded.page.nextCursor === null || more.busy) return;
    const mine = generation.current;
    setMore({ busy: true, error: null });
    const result = await env.ports.list(apiQuery(filters, loaded.page.nextCursor));
    if (mine !== generation.current) return;
    if (result.ok) {
      setMore({ busy: false, error: null });
      setLoaded({
        kind: 'ready',
        rows: [...loaded.rows, ...result.value.items],
        page: result.value,
      });
    } else {
      if (result.error.status === 401) env.onExpired();
      setMore({ busy: false, error: 'No pudimos cargar más casos. Intenta de nuevo.' });
    }
  };

  const filtered = key !== '';
  const header = (
    <PageHeader
      eyebrow="Operación"
      title="Siniestros"
      description="Casos de accidentes, robos y daños de tu flotilla."
      actions={
        mayStartIncident(env.permissions) ? (
          <RouterButton to={newIncidentPath} variant="contained" startIcon={<AddOutlined />}>
            Nuevo siniestro
          </RouterButton>
        ) : undefined
      }
    />
  );
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
  else if (loaded.rows.length === 0)
    body = filtered ? (
      <UiState
        kind="no-results"
        actionLabel="Limpiar filtros"
        onAction={() => router.navigate(incidentsPath, { replace: true })}
      />
    ) : (
      <UiState
        kind="empty"
        title="Aún no hay siniestros"
        description="Cuando registres uno aparecerá aquí."
        {...(mayStartIncident(env.permissions)
          ? { actionLabel: 'Nuevo siniestro', onAction: () => router.navigate(newIncidentPath) }
          : {})}
      />
    );
  else {
    const rows = loaded.rows.map((incident) => ({ ...incident }));
    body = (
      <>
        <ScrollRegion label="Tabla de siniestros">
          <DataTable
            caption={`${rows.length} siniestros`}
            rows={rows}
            columns={incidentColumns(env.zone)}
          />
        </ScrollRegion>
        {more.error && <InlineAlert severity="error">{more.error}</InlineAlert>}
        {loaded.page.nextCursor !== null && (
          <Button variant="outlined" loading={more.busy} onClick={() => void loadMore()}>
            Cargar más
          </Button>
        )}
      </>
    );
  }
  const select = (
    id: string,
    label: string,
    value: string,
    options: readonly { value: string; label: string }[],
    name: keyof Filters,
  ) => (
    <Field
      id={id}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={value}
      onChange={(event) => apply({ [name]: event.target.value })}
    >
      <option value="">Todos</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Field>
  );
  const statusOptions = [
    ...(Object.keys(STATUS_LABELS) as BffIncidentStatus[]).map((value) => ({
      value,
      label: STATUS_LABELS[value],
    })),
    ...(![...Object.keys(STATUS_LABELS), ''].includes(filters.status)
      ? [{ value: filters.status, label: filters.status === OPEN ? 'Abiertos' : 'Varios estados' }]
      : []),
  ];
  return (
    <Box>
      {header}
      <IncidentAlertsPanel compact />
      <Panel>
        <Stack
          direction="row"
          gap={1}
          flexWrap="wrap"
          sx={{ mb: 2 }}
          role="group"
          aria-label="Vistas rápidas"
        >
          {QUICK.map((quick) => {
            const active = sameQuick(filters, quick.filters);
            return (
              <Button
                key={quick.label}
                size="small"
                variant={active ? 'contained' : 'outlined'}
                aria-pressed={active}
                onClick={() =>
                  apply(
                    active
                      ? undoQuick(quick.filters)
                      : { ...NONE, ...quick.filters, limit: filters.limit },
                  )
                }
              >
                {quick.label}
              </Button>
            );
          })}
        </Stack>
        <FilterBar onClear={() => router.navigate(incidentsPath, { replace: true })}>
          {select('inc-filter-status', 'Estado', filters.status, statusOptions, 'status')}
          {select(
            'inc-filter-type',
            'Tipo',
            filters.type,
            BFF_INCIDENT_TYPES.map((value) => ({ value, label: TYPE_LABELS[value] })),
            'type',
          )}
          {select(
            'inc-filter-severity',
            'Gravedad',
            filters.severity,
            BFF_INCIDENT_SEVERITIES.map((value) => ({ value, label: SEVERITY_LABELS[value] })),
            'severity',
          )}
          <Field
            id="inc-page-size"
            label="Casos por página"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={String(filters.limit)}
            onChange={(event) => apply({ limit: Number(event.target.value) as Size })}
          >
            {SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Field>
        </FilterBar>
        <div role="status" className="sr-only">
          {loaded.kind === 'ready' ? `${loaded.rows.length} siniestros encontrados.` : ''}
        </div>
        {body}
      </Panel>
    </Box>
  );
}

/** Turning a quick filter off restores the defaults of the fields it set. */
function undoQuick(quick: Partial<Filters>): Partial<Filters> {
  const reset: Record<string, unknown> = {};
  for (const name of Object.keys(quick)) reset[name] = NONE[name as keyof Filters];
  return reset as Partial<Filters>;
}
