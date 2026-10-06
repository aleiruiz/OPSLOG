import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  ConfirmDialog,
  DataTable,
  Notifications,
  opslogTokens,
  PageHeader,
  StatusBadge,
  Timeline,
  UiState,
} from '@opslog/ui';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import type { Area, AreaHistoryEntry } from '../app/types';
import { AreaNotFound } from './AreaMessages';
import { areaPath, areasPath } from './AreaTreeView';
import { areaStatus, count, describeHistory, formatDateTime } from './labels';
import type { AreaContext } from './loadAreas';
import { MAX_AREA_DEPTH } from './rules';
import { ancestors } from './tree';

/** The confirmation dialog the detail can open: deactivate (destructive) or activate (reversible). */
export interface AreaDialogState {
  readonly kind: 'deactivate' | 'activate' | null;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const dialogClosed: AreaDialogState = { kind: null, busy: false };

export interface HistoryPage {
  readonly items: readonly AreaHistoryEntry[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface HistoryProps {
  readonly state: ResourceState<HistoryPage>;
  readonly loadingMore?: boolean;
  readonly notice?: string | null;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

export interface AreaDetailViewProps {
  readonly state: ResourceState<AreaContext>;
  readonly history: HistoryProps;
  readonly can: (permission: 'create' | 'edit' | 'delete') => boolean;
  readonly notice?: string | null;
  readonly dialog: AreaDialogState;
  readonly onRetry: () => void;
  readonly onDialogRequest: (kind: 'deactivate' | 'activate') => void;
  readonly onDialogConfirm: () => void;
  readonly onDialogCancel: () => void;
  readonly onDialogErrorAction: () => void;
}

const { colors } = opslogTokens;
const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Typography component="span" sx={{ fontFamily: opslogTokens.typography.monoFamily }}>
      {children}
    </Typography>
  );
}

function BackLink() {
  return (
    <Box sx={{ mb: 2 }}>
      <RouterLink to={areasPath} sx={linkSx}>
        Volver a áreas
      </RouterLink>
    </Box>
  );
}

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

function Path({ chain }: { chain: readonly Area[] }) {
  if (chain.length === 0) return null;
  return (
    <Box component="nav" aria-label="Ruta del área" sx={{ mb: 2, typography: 'body2' }}>
      <Box
        component="ol"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, listStyle: 'none', p: 0, m: 0 }}
      >
        {chain.map((area, index) => (
          <li key={area.id}>
            <RouterLink to={areaPath(area.id)} sx={linkSx}>
              {area.name}
            </RouterLink>
            {index < chain.length - 1 && <span aria-hidden="true"> ›</span>}
          </li>
        ))}
      </Box>
    </Box>
  );
}

function Detail({ context }: { context: AreaContext }) {
  const { area, areas } = context;
  const status = areaStatus(area);
  const parent = areas.find((item) => item.id === area.parentId);
  const rows: [string, React.ReactNode][] = [
    ['Nombre', area.name],
    ['Código', area.code ? <Mono>{area.code}</Mono> : 'Sin código'],
    ['Estado', <StatusBadge label={status.label} tone={status.tone} />],
    ['Nivel', `${area.depth} de ${MAX_AREA_DEPTH}`],
    [
      'Área superior',
      area.parentId === null ? (
        'Ninguna: es un área raíz'
      ) : (
        <RouterLink to={areaPath(area.parentId)} sx={linkSx}>
          {parent?.name ?? 'Ver área superior'}
        </RouterLink>
      ),
    ],
    [
      'Responsables',
      area.responsibleIds.length === 0 ? (
        'Sin responsables'
      ) : (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {area.responsibleIds.map((id) => (
            <li key={id}>
              <Mono>{id}</Mono>
            </li>
          ))}
        </Box>
      ),
    ],
    ['Vehículos activos', String(area.resourceCounts.vehicles)],
    ['Personas activas', String(area.resourceCounts.people)],
    ['Creada', formatDateTime(area.createdAt)],
    ['Última actualización', formatDateTime(area.updatedAt)],
    ...(area.deactivatedAt === null
      ? []
      : ([['Desactivada', formatDateTime(area.deactivatedAt)]] as [string, React.ReactNode][])),
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
          <Typography
            component="dd"
            variant="body1"
            sx={{ m: 0, mb: { xs: 1.5, sm: 0 }, overflowWrap: 'anywhere' }}
          >
            {value}
          </Typography>
        </React.Fragment>
      ))}
    </Box>
  );
}

function SubAreas({ children }: { children: readonly Area[] }) {
  return (
    <Box component="section" aria-labelledby="sub-areas-title" sx={{ mt: 4 }}>
      <Typography id="sub-areas-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Sub-áreas
      </Typography>
      {children.length === 0 ? (
        <Typography color="text.secondary">Esta área no tiene sub-áreas.</Typography>
      ) : (
        <Box sx={{ overflowX: 'auto', maxWidth: '100%' }}>
          <DataTable<Area>
            caption={`Sub-áreas (${children.length})`}
            columns={[
              {
                key: 'name',
                label: 'Nombre',
                render: (_, row) => (
                  <RouterLink to={areaPath(row.id)} sx={linkSx}>
                    {row.name}
                  </RouterLink>
                ),
              },
              {
                key: 'code',
                label: 'Código',
                render: (value) => (value ? <Mono>{String(value)}</Mono> : '—'),
              },
              {
                key: 'active',
                label: 'Estado',
                render: (_, row) => {
                  const status = areaStatus(row);
                  return <StatusBadge label={status.label} tone={status.tone} />;
                },
              },
              {
                key: 'responsibleIds',
                label: 'Responsables',
                render: (_, row) => String(row.responsibleIds.length),
              },
            ]}
            rows={[...children]}
          />
        </Box>
      )}
    </Box>
  );
}

function History({
  props,
  nameOf,
}: {
  props: HistoryProps;
  nameOf: (areaId: string) => string | null;
}) {
  const { state } = props;
  return (
    <Box component="section" aria-labelledby="history-title" sx={{ mt: 4 }}>
      <Typography id="history-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Historial
      </Typography>
      {state.status === 'ready' ? (
        <>
          <Timeline
            items={state.data.items.map((entry) => ({
              id: entry.id,
              title: describeHistory(entry, nameOf),
              description: `Por ${entry.actorId} · versión ${entry.version}`,
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
          {state.data.nextCursor && (
            <Button
              variant="outlined"
              loading={props.loadingMore ?? false}
              onClick={() => props.onLoadMore(state.data.nextCursor as string)}
            >
              Cargar más historial
            </Button>
          )}
        </>
      ) : (
        <ResourceView state={state} onRetry={props.onRetry}>
          {() => null}
        </ResourceView>
      )}
    </Box>
  );
}

function blockers(counts: { vehicles: number; people: number }, subAreas: number): string[] {
  return [
    ...(subAreas > 0 ? [count(subAreas, 'sub-área activa', 'sub-áreas activas')] : []),
    ...(counts.vehicles > 0
      ? [count(counts.vehicles, 'vehículo activo', 'vehículos activos')]
      : []),
    ...(counts.people > 0 ? [count(counts.people, 'persona activa', 'personas activas')] : []),
  ];
}

/** Area detail: data, responsibles, sub-areas, history and the permission-aware actions. */
export function AreaDetailView({
  state,
  history,
  can,
  notice = null,
  dialog,
  onRetry,
  onDialogRequest,
  onDialogConfirm,
  onDialogCancel,
  onDialogErrorAction,
}: AreaDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <AreaNotFound />;
  return (
    <>
      <BackLink />
      <ResourceView state={state} onRetry={onRetry}>
        {(context) => {
          const { area, areas } = context;
          const subAreas = areas
            .filter((item) => item.parentId === area.id)
            .sort((a, b) => a.name.localeCompare(b.name, 'es'));
          const names = new Map(areas.map((item) => [item.id, item.name]));
          const blocking = blockers(
            area.resourceCounts,
            subAreas.filter((item) => item.active).length,
          );
          return (
            <>
              <PageHeader
                title={area.name}
                description={area.code ? `Código ${area.code}` : 'Área sin código'}
                actions={
                  <>
                    {can('edit') && area.active && (
                      <RouterButton to={`${areaPath(area.id)}/editar`} variant="contained">
                        Editar
                      </RouterButton>
                    )}
                    {can('edit') && area.active && (
                      <RouterButton to={`${areaPath(area.id)}/mover`} variant="outlined">
                        Mover
                      </RouterButton>
                    )}
                    {can('create') && area.active && area.depth < MAX_AREA_DEPTH && (
                      <RouterButton
                        to={`${areasPath}/nueva?padre=${encodeURIComponent(area.id)}`}
                        variant="outlined"
                      >
                        Nueva sub-área
                      </RouterButton>
                    )}
                    {can('edit') && !area.active && (
                      <Button variant="contained" onClick={() => onDialogRequest('activate')}>
                        Activar
                      </Button>
                    )}
                    {can('delete') && area.active && (
                      <Button
                        variant="outlined"
                        color="error"
                        onClick={() => onDialogRequest('deactivate')}
                      >
                        Desactivar
                      </Button>
                    )}
                  </>
                }
              />
              <Path chain={ancestors(areas, area.id)} />
              {notice && <FocusNotice text={notice} />}
              {!area.active && (
                <Box sx={{ mb: 3 }}>
                  <UiState
                    kind="closed"
                    title="Área inactiva"
                    description={`Es de solo lectura${
                      area.deactivatedAt ? ` desde el ${formatDateTime(area.deactivatedAt)}` : ''
                    }. Actívala para editarla, moverla o asignarle recursos.`}
                  />
                </Box>
              )}
              {area.active && blocking.length > 0 && can('delete') && (
                <Box sx={{ mb: 3 }}>
                  <Notifications
                    messages={[
                      {
                        id: 'blockers',
                        severity: 'info',
                        text: `Para desactivar esta área primero resuelve sus recursos activos: ${blocking.join(', ')}.`,
                      },
                    ]}
                  />
                </Box>
              )}
              <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
                Datos del área
              </Typography>
              <Detail context={context} />
              <SubAreas>{subAreas}</SubAreas>
              <History props={history} nameOf={(id) => names.get(id) ?? null} />
              {context.truncated && (
                <Box sx={{ mt: 3, borderTop: `1px solid ${colors.border}`, pt: 2 }}>
                  <Notifications
                    messages={[
                      {
                        id: 'truncated',
                        severity: 'warning',
                        text: 'La estructura es muy grande: la ruta y las sub-áreas pueden estar incompletas.',
                      },
                    ]}
                  />
                </Box>
              )}
              {dialog.kind === 'deactivate' && (
                <ConfirmDialog
                  title={`Desactivar el área ${area.name}`}
                  description="Dejará de estar disponible para asignarle recursos y será de solo lectura hasta que se vuelva a activar. No se puede desactivar si tiene sub-áreas, vehículos o personas activas."
                  confirmLabel="Desactivar área"
                  busy={dialog.busy}
                  {...(dialog.error ? { error: dialog.error } : {})}
                  {...(dialog.errorActionLabel
                    ? {
                        errorActionLabel: dialog.errorActionLabel,
                        onErrorAction: onDialogErrorAction,
                      }
                    : {})}
                  onConfirm={onDialogConfirm}
                  onCancel={onDialogCancel}
                />
              )}
              {dialog.kind === 'activate' && (
                <ConfirmDialog
                  title={`Activar el área ${area.name}`}
                  description="Volverá a estar disponible para asignarle recursos y se podrá editar. Su área superior debe estar activa."
                  confirmLabel="Activar área"
                  confirmTone="primary"
                  busy={dialog.busy}
                  {...(dialog.error ? { error: dialog.error } : {})}
                  {...(dialog.errorActionLabel
                    ? {
                        errorActionLabel: dialog.errorActionLabel,
                        onErrorAction: onDialogErrorAction,
                      }
                    : {})}
                  onConfirm={onDialogConfirm}
                  onCancel={onDialogCancel}
                />
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
