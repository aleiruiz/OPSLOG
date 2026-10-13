import LinkOffOutlined from '@mui/icons-material/LinkOffOutlined';
import Box from '@mui/material/Box';
import React from 'react';
import {
  Button,
  DescriptionList,
  Notifications,
  PageHeader,
  Panel,
  StatusBadge,
  Timeline,
  UiState,
} from '@opslog/ui';
import { BackLink } from '../app/BackLink';
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

const linkSx = {
  color: 'primary.main',
  fontWeight: 500,
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
} as const;

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
  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: 'Vehículo',
      value: (
        <RouterLink to={`/flota/vehiculos/${encodeURIComponent(assignment.vehicleId)}`} sx={linkSx}>
          {vehicleName ?? 'Ver vehículo'}
        </RouterLink>
      ),
    },
    {
      label: 'Conductor',
      value: (
        <RouterLink
          to={`/plantilla/empleados/${encodeURIComponent(assignment.employeeId)}`}
          sx={linkSx}
        >
          {driverName ?? 'Ver conductor'}
        </RouterLink>
      ),
    },
    { label: 'Tipo', value: typeLabel(assignment.type) },
    { label: 'Estado', value: <StatusBadge label={status.label} tone={status.tone} /> },
    { label: 'Inicio', value: formatDateTime(assignment.startedAt) },
    { label: 'Asignada por', value: assignment.assignedBy },
    { label: 'Motivo de la asignación', value: assignment.reason },
    ...(assignment.endedAt === null
      ? []
      : [
          { label: 'Fin', value: formatDateTime(assignment.endedAt) },
          {
            label: 'Cómo terminó',
            value: assignment.endKind ? endKindLabels[assignment.endKind] : '—',
          },
          { label: 'Motivo del cierre', value: assignment.endReason ?? '—' },
          { label: 'Cerrada por', value: assignment.endedBy ?? '—' },
        ]),
    { label: 'Última actualización', value: formatDateTime(assignment.updatedAt) },
  ];
  return <DescriptionList columns={3} items={rows} />;
}

function History({ props }: { props: HistoryProps }) {
  const { state } = props;
  return (
    <Panel title="Historial de la asignación">
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
            <Notifications
              messages={[{ id: 'history-notice', text: props.notice, severity: 'error' }]}
            />
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
    </Panel>
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
      <BackLink to={assignmentsPath}>Volver a asignaciones</BackLink>
      <ResourceView state={state} onRetry={onRetry}>
        {(assignment) => (
          <>
            <PageHeader
              eyebrow="Flota"
              title={`Asignación${vehicleName ? ` de ${vehicleName}` : ''}`}
              description={`${typeLabel(assignment.type)}${driverName ? ` · Conductor ${driverName}` : ''}`}
              actions={
                can('edit') && isCurrent(assignment) ? (
                  <RouterButton
                    to={`${assignmentPath(assignment.id)}/cerrar`}
                    variant="contained"
                    startIcon={<LinkOffOutlined />}
                  >
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
            <Panel title="Datos de la asignación">
              <Detail assignment={assignment} vehicleName={vehicleName} driverName={driverName} />
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  columnGap: 3,
                  rowGap: 1,
                  pt: 2,
                  borderTop: 1,
                  borderColor: 'divider',
                }}
              >
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
            </Panel>
            <History props={history} />
          </>
        )}
      </ResourceView>
    </>
  );
}
