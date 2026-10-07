import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Notifications, PageHeader, StatusBadge, Timeline, UiState } from '@opslog/ui';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import type { AssignmentEvent, VehicleAssignment } from '../app/types';
import { AssignmentNotFound, assignmentPath, assignmentsPath } from './AssignmentMessages';
import {
  endKindLabels,
  eventLabel,
  formatDateTime,
  isCurrent,
  statusPresentation,
  typeLabel,
} from './labels';

export interface HistoryPage {
  readonly items: readonly AssignmentEvent[];
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

export interface AssignmentDetailViewProps {
  readonly state: ResourceState<VehicleAssignment>;
  readonly history: HistoryProps;
  /** Economic number of the vehicle and name of the driver, when they could be read. */
  readonly vehicleName?: string | null;
  readonly driverName?: string | null;
  readonly can: (permission: 'edit') => boolean;
  readonly notice?: string | null;
  readonly onRetry: () => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

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

function Detail({
  assignment,
  vehicleName,
  driverName,
}: {
  assignment: VehicleAssignment;
  vehicleName: string | null;
  driverName: string | null;
}) {
  const status = statusPresentation[isCurrent(assignment) ? 'current' : 'ended'];
  const rows: [string, React.ReactNode][] = [
    [
      'Vehículo',
      <RouterLink to={`/flota/vehiculos/${encodeURIComponent(assignment.vehicleId)}`} sx={linkSx}>
        {vehicleName ?? 'Ver vehículo'}
      </RouterLink>,
    ],
    [
      'Conductor',
      <RouterLink to={`/plantilla/empleados/${encodeURIComponent(assignment.employeeId)}`} sx={linkSx}>
        {driverName ?? 'Ver conductor'}
      </RouterLink>,
    ],
    ['Tipo', typeLabel(assignment.type)],
    ['Estado', <StatusBadge label={status.label} tone={status.tone} />],
    ['Inicio', formatDateTime(assignment.startedAt)],
    ['Asignada por', assignment.assignedBy],
    ['Motivo de la asignación', assignment.reason],
    ...(assignment.endedAt === null
      ? []
      : ([
          ['Fin', formatDateTime(assignment.endedAt)],
          ['Cómo terminó', assignment.endKind ? endKindLabels[assignment.endKind] : '—'],
          ['Motivo del cierre', assignment.endReason ?? '—'],
          ['Cerrada por', assignment.endedBy ?? '—'],
        ] as [string, React.ReactNode][])),
    ['Última actualización', formatDateTime(assignment.updatedAt)],
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

function History({ props }: { props: HistoryProps }) {
  const { state } = props;
  return (
    <Box component="section" aria-labelledby="history-title" sx={{ mt: 4 }}>
      <Typography id="history-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Historial de la asignación
      </Typography>
      {state.status === 'ready' ? (
        <>
          <Timeline
            items={state.data.items.map((entry) => ({
              id: String(entry.seq),
              title: eventLabel(entry.kind),
              description: `Por ${entry.actorId} · Motivo: ${entry.reason}`,
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

/** Assignment detail: data, the append-only history of the assignment and the permission-aware action (close). */
export function AssignmentDetailView({
  state,
  history,
  vehicleName = null,
  driverName = null,
  can,
  notice = null,
  onRetry,
}: AssignmentDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <AssignmentNotFound />;
  return (
    <>
      <Box sx={{ mb: 2 }}>
        <RouterLink to={assignmentsPath} sx={linkSx}>
          Volver a asignaciones
        </RouterLink>
      </Box>
      <ResourceView state={state} onRetry={onRetry}>
        {(assignment) => (
          <>
            <PageHeader
              title={`Asignación${vehicleName ? ` de ${vehicleName}` : ''}`}
              description={`${typeLabel(assignment.type)}${driverName ? ` · Conductor ${driverName}` : ''}`}
              actions={
                can('edit') && isCurrent(assignment) ? (
                  <RouterButton to={`${assignmentPath(assignment.id)}/cerrar`} variant="contained">
                    Cerrar asignación
                  </RouterButton>
                ) : undefined
              }
            />
            {notice && <FocusNotice text={notice} />}
            {!isCurrent(assignment) && (
              <Box sx={{ mb: 3 }}>
                <UiState
                  kind="closed"
                  title="Asignación cerrada"
                  description="Es un registro histórico de solo lectura. Para cambiarla, asigna de nuevo."
                />
              </Box>
            )}
            <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
              Datos de la asignación
            </Typography>
            <Detail assignment={assignment} vehicleName={vehicleName} driverName={driverName} />
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 2 }}>
              <RouterLink
                to={`${assignmentsPath}?vehiculo=${encodeURIComponent(assignment.vehicleId)}`}
                sx={linkSx}
              >
                Ver todas las asignaciones del vehículo
              </RouterLink>
              <RouterLink
                to={`${assignmentsPath}?conductor=${encodeURIComponent(assignment.employeeId)}`}
                sx={linkSx}
              >
                Ver todas las asignaciones del conductor
              </RouterLink>
            </Box>
            <History props={history} />
          </>
        )}
      </ResourceView>
    </>
  );
}
