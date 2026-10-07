import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ConfirmDialog, PageHeader, Button, UiState } from '@opslog/ui';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton } from '../app/router';
import type { EmployeeStatus } from '../app/types';
import { Detail } from './EmployeeDetailData';
import { BackLink, FocusNotice } from './EmployeeDetailShared';
import {
  dialogClosed,
  statusPanelClosed,
  type EmployeeDialogState,
  type HistoryPage,
  type HistoryProps,
  type StatusPanelState,
} from './employeeDetailState';
import { EmployeeNotFound, employeePath } from './EmployeeMessages';
import { History } from './EmployeeHistory';
import { PersonalData } from './EmployeePersonalData';
import { StatusPanel } from './EmployeeStatusPanel';
import {
  canChangeStatus,
  formatDateTime,
  fullName,
  isArchivable,
  isEditable,
  kindLabels,
} from './labels';
import type { EmployeeContext } from './loadEmployee';

export { dialogClosed, statusPanelClosed };
export type { EmployeeDialogState, HistoryPage, HistoryProps, StatusPanelState };

export interface EmployeeDetailViewProps {
  readonly state: ResourceState<EmployeeContext>;
  readonly history: HistoryProps;
  readonly can: (permission: 'edit' | 'delete' | 'view_pii') => boolean;
  readonly notice?: string | null;
  readonly dialog: EmployeeDialogState;
  readonly statusPanel: StatusPanelState;
  /** Initial values of the status panel (stories and tests); the person types over them. */
  readonly statusDraft?: { readonly to: EmployeeStatus | ''; readonly reason: string };
  /** Start with the personal data shown (stories and tests). It always starts hidden for a person. */
  readonly piiRevealed?: boolean;
  readonly onRetry: () => void;
  readonly onStatusOpen: () => void;
  readonly onStatusCancel: () => void;
  readonly onStatusSubmit: (to: EmployeeStatus, reason: string) => void;
  readonly onStatusErrorAction: () => void;
  readonly onArchiveRequest: () => void;
  readonly onDialogConfirm: () => void;
  readonly onDialogCancel: () => void;
  readonly onDialogErrorAction: () => void;
}

/** Employee detail: data, fitness, personal data (masked without `view_pii`), history and the permission-aware actions. */
export function EmployeeDetailView({
  state,
  history,
  can,
  notice = null,
  dialog,
  statusPanel,
  statusDraft = { to: '', reason: '' },
  piiRevealed = false,
  onRetry,
  onStatusOpen,
  onStatusCancel,
  onStatusSubmit,
  onStatusErrorAction,
  onArchiveRequest,
  onDialogConfirm,
  onDialogCancel,
  onDialogErrorAction,
}: EmployeeDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <EmployeeNotFound />;
  return (
    <>
      <BackLink />
      <ResourceView state={state} onRetry={onRetry}>
        {({ employee, areas }) => {
          const names = new Map(areas.map((item) => [item.id, item.name]));
          const changeable = can('edit') && canChangeStatus(employee);
          return (
            <>
              <PageHeader
                title={fullName(employee)}
                description={`${kindLabels[employee.kind]}${employee.position ? ` · ${employee.position}` : ''}`}
                actions={
                  <>
                    {can('edit') && isEditable(employee) && (
                      <RouterButton to={`${employeePath(employee.id)}/editar`} variant="contained">
                        Editar
                      </RouterButton>
                    )}
                    {changeable && !statusPanel.open && (
                      <Button variant="outlined" onClick={onStatusOpen}>
                        Cambiar estado
                      </Button>
                    )}
                    {can('delete') && isArchivable(employee) && (
                      <Button variant="outlined" color="error" onClick={onArchiveRequest}>
                        Archivar
                      </Button>
                    )}
                  </>
                }
              />
              {notice && <FocusNotice text={notice} />}
              {employee.archivedAt !== null ? (
                <Box sx={{ mb: 3 }}>
                  <UiState
                    kind="closed"
                    title="Empleado archivado"
                    description={`Se archivó el ${formatDateTime(employee.archivedAt)}. Es de solo lectura y no se puede restaurar desde la aplicación.`}
                  />
                </Box>
              ) : (
                employee.status === 'terminated' && (
                  <Box sx={{ mb: 3 }}>
                    <UiState
                      kind="closed"
                      title="Empleado dado de baja"
                      description="Es un registro histórico y no admite cambios."
                    />
                  </Box>
                )
              )}
              {changeable && statusPanel.open && (
                <StatusPanel
                  employee={employee}
                  state={statusPanel}
                  draft={statusDraft}
                  onCancel={onStatusCancel}
                  onSubmit={onStatusSubmit}
                  onErrorAction={onStatusErrorAction}
                />
              )}
              <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
                Datos del empleado
              </Typography>
              <Detail employee={employee} areas={areas} />
              <PersonalData
                // A new version remounts this section on purpose: it re-hides the personal data after any change.
                key={`${employee.id}:${employee.version}`}
                employee={employee}
                canView={can('view_pii')}
                initiallyRevealed={piiRevealed}
              />
              <History props={history} areaName={(id) => names.get(id) ?? null} />
              {dialog.kind === 'archive' && (
                <ConfirmDialog
                  title={`Archivar a ${fullName(employee)}`}
                  description="Dejará de aparecer en el listado y no se podrá editar. Esta acción no se puede deshacer desde la aplicación."
                  confirmLabel="Archivar empleado"
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
              {dialog.kind === 'terminate' && (
                <ConfirmDialog
                  title={`Dar de baja a ${fullName(employee)}`}
                  description={`La baja es definitiva: el empleado quedará de solo lectura y no podrá volver a otro estado.${
                    dialog.reason ? ` Motivo: ${dialog.reason}` : ''
                  }`}
                  confirmLabel="Dar de baja"
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
