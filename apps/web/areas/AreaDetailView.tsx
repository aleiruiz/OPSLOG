import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {
  Button,
  ConfirmDialog,
  Notifications,
  opslogTokens,
  PageHeader,
  UiState,
} from '@opslog/ui';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton } from '../app/router';
import { Detail, SubAreas } from './AreaDetailData';
import { BackLink, FocusNotice, Path } from './AreaDetailParts';
import {
  dialogClosed,
  type AreaDialogState,
  type HistoryPage,
  type HistoryProps,
} from './areaDetailState';
import { History } from './AreaHistory';
import { AreaNotFound } from './AreaMessages';
import { areaPath, areasPath } from './AreaTreeView';
import { count, formatDateTime } from './labels';
import type { AreaContext } from './loadAreas';
import { MAX_AREA_DEPTH } from './rules';
import { ancestors } from './tree';

export { dialogClosed };
export type { AreaDialogState, HistoryPage, HistoryProps };

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
