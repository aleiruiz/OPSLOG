import React from 'react';
import type { ResourceState } from '../app/resource';
import type { ApiError, EmployeeDetail } from '../app/types';
import { demoAreas } from '../areas/fixtures';
import {
  dialogClosed,
  EmployeeDetailView,
  statusPanelClosed,
  type EmployeeDetailViewProps,
  type HistoryPage,
} from './EmployeeDetailView';
import { demoHistory, makeEmployeeDetail, noPii } from './fixtures';
import type { EmployeeContext } from './loadEmployee';
import { Frame, noop } from './storyFrame';

export default {
  title: 'Plantilla/Empleados/Detalle',
  parameters: { layout: 'padded' },
};

const areas = demoAreas();
const context = (employee: EmployeeDetail): ResourceState<EmployeeContext> => ({
  status: 'ready',
  data: { employee, areas },
});
const driver = makeEmployeeDetail();
const page = (
  items = demoHistory(),
  nextCursor: string | null = null,
): ResourceState<HistoryPage> => ({
  status: 'ready',
  data: { items, nextCursor, total: items.length },
});
const admin = () => true;
const readOnly = () => false;
const withoutPii = (permission: string) => permission !== 'view_pii';
const failure = (status: ApiError['status'], code: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
});

const view = (props: Partial<EmployeeDetailViewProps> = {}, historyOverrides = {}) => (
  <Frame>
    <EmployeeDetailView
      state={context(driver)}
      history={{ state: page(), onRetry: noop, onLoadMore: noop, ...historyOverrides }}
      can={admin}
      dialog={dialogClosed}
      statusPanel={statusPanelClosed}
      onRetry={noop}
      onStatusOpen={noop}
      onStatusCancel={noop}
      onStatusSubmit={noop}
      onStatusErrorAction={noop}
      onArchiveRequest={noop}
      onDialogConfirm={noop}
      onDialogCancel={noop}
      onDialogErrorAction={noop}
      {...props}
    />
  </Frame>
);

// Stories with a modal open set `harness: 'modal'`: the all-stories axe page skips them (a modal hides the rest of the
// page by design) and the dialogs are scanned on their own in e2e/employees.spec.ts.
const modal = { layout: 'padded', harness: 'modal' };
const staleMessage =
  'Otra persona modificó este empleado mientras lo revisabas. Recarga los datos y vuelve a decidir.';

export const Default = { render: () => view() };
export const PersonalDataRevealed = { render: () => view({ piiRevealed: true }) };
export const PersonalDataMaskedForRole = { render: () => view({ can: withoutPii }) };
export const ReadOnly = { render: () => view({ can: readOnly }) };
export const EditorWithoutArchive = { render: () => view({ can: (p) => p !== 'delete' }) };
export const Dispatcher = {
  render: () =>
    view({
      state: context(
        makeEmployeeDetail({
          id: 'emp-d',
          kind: 'dispatcher',
          firstName: 'María',
          lastName: 'Martínez Soto',
          position: 'Despachadora',
          licenseType: null,
          licenseExpiresOn: null,
        }),
      ),
    }),
};
export const WithoutOptionalData = {
  render: () =>
    view({
      state: context(
        makeEmployeeDetail(
          {
            id: 'emp-o',
            kind: 'other',
            employeeNumber: null,
            position: null,
            hireDate: null,
            idType: null,
            licenseType: null,
            licenseExpiresOn: null,
          },
          noPii,
        ),
      ),
    }),
};
export const NotFitLicenseExpired = {
  render: () => view({ state: context(makeEmployeeDetail({ licenseExpiresOn: '2026-08-31' })) }),
};
export const NotFitNoLicense = {
  render: () =>
    view({
      state: context(
        makeEmployeeDetail(
          { licenseType: null, licenseExpiresOn: null },
          { ...noPii, phone: '+525555550100' },
        ),
      ),
    }),
};
export const Suspended = {
  render: () =>
    view({
      state: context(
        makeEmployeeDetail({ status: 'suspended', statusReason: 'Revisión interna en curso' }),
      ),
    }),
};
export const Terminated = {
  render: () =>
    view({
      state: context(
        makeEmployeeDetail({ status: 'terminated', statusReason: 'Renuncia voluntaria' }),
      ),
    }),
};
export const Archived = {
  render: () =>
    view({ state: context(makeEmployeeDetail({ archivedAt: '2026-09-30T10:00:00.000Z' })) }),
};
export const UnknownArea = {
  render: () => view({ state: context(makeEmployeeDetail({ areaId: 'area-desconocida' })) }),
};
export const JustCreated = { render: () => view({ notice: 'Empleado creado.' }) };
export const JustSaved = { render: () => view({ notice: 'Cambios guardados.' }) };
export const JustChangedStatus = {
  render: () => view({ notice: 'Estado cambiado a Suspendido.' }),
};
export const HistoryWithMore = {
  render: () => view({}, { state: page(demoHistory(), 'cursor-demo') }),
};
export const HistoryLoadingMore = {
  render: () => view({}, { state: page(demoHistory(), 'cursor-demo'), loadingMore: true }),
};
export const HistoryLoadMoreFailed = {
  render: () =>
    view(
      {},
      {
        state: page(demoHistory(), 'cursor-demo'),
        notice: 'No pudimos cargar más historial.',
      },
    ),
};
export const HistoryLoading = { render: () => view({}, { state: { status: 'loading' } }) };
export const HistoryError = {
  render: () => view({}, { state: { status: 'error', error: failure(500, 'internal_error') } }),
};

export const StatusPanelOpen = {
  render: () => view({ statusPanel: { open: true, busy: false } }),
};
export const StatusPanelFilled = {
  render: () =>
    view({
      statusPanel: { open: true, busy: false },
      statusDraft: { to: 'suspended', reason: 'Revisión interna en curso' },
    }),
};
export const StatusPanelBusy = {
  render: () =>
    view({
      statusPanel: { open: true, busy: true },
      statusDraft: { to: 'inactive', reason: 'Licencia médica' },
    }),
};
export const StatusPanelConflict = {
  render: () =>
    view({
      statusPanel: {
        open: true,
        busy: false,
        error: staleMessage,
        errorActionLabel: 'Recargar datos',
      },
      statusDraft: { to: 'inactive', reason: 'Licencia médica' },
    }),
};
export const StatusPanelFromSuspended = {
  render: () =>
    view({
      state: context(makeEmployeeDetail({ status: 'suspended', statusReason: 'Revisión' })),
      statusPanel: { open: true, busy: false },
    }),
};

export const ArchiveConfirmation = {
  parameters: modal,
  render: () => view({ dialog: { kind: 'archive', busy: false } }),
};
export const ArchiveInProgress = {
  parameters: modal,
  render: () => view({ dialog: { kind: 'archive', busy: true } }),
};
export const ArchiveConflict = {
  parameters: modal,
  render: () =>
    view({
      dialog: {
        kind: 'archive',
        busy: false,
        error: staleMessage,
        errorActionLabel: 'Recargar datos',
      },
    }),
};
export const TerminateConfirmation = {
  parameters: modal,
  render: () =>
    view({
      statusPanel: { open: true, busy: false },
      dialog: { kind: 'terminate', busy: false, reason: 'Renuncia voluntaria' },
    }),
};
export const TerminateInProgress = {
  parameters: modal,
  render: () =>
    view({
      statusPanel: { open: true, busy: false },
      dialog: { kind: 'terminate', busy: true, reason: 'Renuncia voluntaria' },
    }),
};
export const TerminateConflict = {
  parameters: modal,
  render: () =>
    view({
      statusPanel: { open: true, busy: false },
      dialog: {
        kind: 'terminate',
        busy: false,
        reason: 'Renuncia voluntaria',
        error: staleMessage,
        errorActionLabel: 'Recargar datos',
      },
    }),
};

export const Loading = { render: () => view({ state: { status: 'loading' } }) };
export const NotFound = {
  render: () => view({ state: { status: 'error', error: failure(404, 'not_found') } }),
};
export const Error = {
  render: () => view({ state: { status: 'error', error: failure(500, 'internal_error') } }),
};
export const NoPermission = { render: () => view({ state: { status: 'forbidden' } }) };
export const SessionExpired = { render: () => view({ state: { status: 'expired' } }) };
