import React from 'react';
import type { ResourceState } from '../app/resource';
import type { ApiError, Area } from '../app/types';
import {
  AreaDetailView,
  dialogClosed,
  type AreaDetailViewProps,
  type HistoryPage,
} from './AreaDetailView';
import { demoAreas, demoHistory, makeAreaDetail } from './fixtures';
import type { AreaContext } from './loadAreas';
import { Frame, noop } from './storyFrame';

export default {
  title: 'Plantilla/Areas/Detalle',
  parameters: { layout: 'padded' },
};

const areas = demoAreas();
const area = (id: string): Area => areas.find((item) => item.id === id) as Area;
const context = (
  id: string,
  counts = { vehicles: 0, people: 0 },
  truncated = false,
): ResourceState<AreaContext> => ({
  status: 'ready',
  data: { area: makeAreaDetail(area(id), counts), areas, truncated },
});
const page = (
  items = demoHistory(),
  nextCursor: string | null = null,
): ResourceState<HistoryPage> => ({
  status: 'ready',
  data: { items, nextCursor, total: items.length },
});
const admin = () => true;
const readOnly = () => false;
const failure = (status: ApiError['status'], code: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
});

const view = (props: Partial<AreaDetailViewProps> = {}, historyOverrides = {}) => (
  <Frame>
    <AreaDetailView
      state={context('area-norte-mty', { vehicles: 4, people: 0 })}
      history={{ state: page(), onRetry: noop, onLoadMore: noop, ...historyOverrides }}
      can={admin}
      dialog={dialogClosed}
      onRetry={noop}
      onDialogRequest={noop}
      onDialogConfirm={noop}
      onDialogCancel={noop}
      onDialogErrorAction={noop}
      {...props}
    />
  </Frame>
);

// Stories with the modal open set `harness: 'modal'`: the all-stories axe page skips them (a modal hides the rest of the
// page by design) and the dialogs are scanned on their own in e2e/areas.spec.ts.
const modal = { layout: 'padded', harness: 'modal' };

export const Default = { render: () => view() };
export const Root = {
  render: () => view({ state: context('area-norte') }),
};
export const Leaf = {
  render: () => view({ state: context('area-apodaca-taller') }),
};
export const LongName = {
  render: () => view({ state: context('area-apodaca-patio') }),
};
export const WithoutResponsibles = {
  render: () => view({ state: context('area-sur-mer') }),
};
export const BlockedByPeople = {
  render: () => view({ state: context('area-centro-cdmx', { vehicles: 0, people: 12 }) }),
};
export const Inactive = {
  render: () => view({ state: context('area-mty-guadalupe') }),
};
export const ReadOnly = { render: () => view({ can: readOnly }) };
export const EditorWithoutDeactivate = {
  render: () => view({ can: (p) => p !== 'delete' }),
};
export const JustCreated = { render: () => view({ notice: 'Área creada.' }) };
export const JustSaved = { render: () => view({ notice: 'Cambios guardados.' }) };
export const JustMoved = {
  render: () => view({ notice: 'Área movida con todas sus sub-áreas.' }),
};
export const JustActivated = {
  render: () => view({ notice: 'Área activada.' }),
};
export const DeactivateConfirmation = {
  parameters: modal,
  render: () =>
    view({ state: context('area-apodaca-taller'), dialog: { kind: 'deactivate', busy: false } }),
};
export const DeactivateInProgress = {
  parameters: modal,
  render: () =>
    view({ state: context('area-apodaca-taller'), dialog: { kind: 'deactivate', busy: true } }),
};
export const DeactivateBlockedBySubAreas = {
  parameters: modal,
  render: () =>
    view({
      dialog: {
        kind: 'deactivate',
        busy: false,
        error:
          'No se puede desactivar: esta área todavía tiene sub-áreas activas. Desactívalas o muévelas a otra área primero.',
        errorActionLabel: 'Recargar datos',
      },
    }),
};
export const DeactivateBlockedByVehicles = {
  parameters: modal,
  render: () =>
    view({
      dialog: {
        kind: 'deactivate',
        busy: false,
        error:
          'No se puede desactivar: esta área todavía tiene vehículos activos asignados. Reasígnalos a otra área primero.',
        errorActionLabel: 'Recargar datos',
      },
    }),
};
export const DeactivateBlockedByPeople = {
  parameters: modal,
  render: () =>
    view({
      state: context('area-centro-cdmx', { vehicles: 0, people: 12 }),
      dialog: {
        kind: 'deactivate',
        busy: false,
        error:
          'No se puede desactivar: esta área todavía tiene personas activas asignadas. Reasígnalas a otra área primero.',
        errorActionLabel: 'Recargar datos',
      },
    }),
};
export const DeactivateConflict = {
  parameters: modal,
  render: () =>
    view({
      dialog: {
        kind: 'deactivate',
        busy: false,
        error:
          'Otra persona modificó esta área mientras la revisabas. Recarga los datos y vuelve a decidir.',
        errorActionLabel: 'Recargar datos',
      },
    }),
};
export const ActivateConfirmation = {
  parameters: modal,
  render: () =>
    view({ state: context('area-mty-guadalupe'), dialog: { kind: 'activate', busy: false } }),
};
export const ActivateParentInactive = {
  parameters: modal,
  render: () =>
    view({
      state: context('area-mty-guadalupe'),
      dialog: {
        kind: 'activate',
        busy: false,
        error:
          'No se puede activar: el área superior está inactiva. Actívala primero y vuelve a intentarlo.',
        errorActionLabel: 'Recargar datos',
      },
    }),
};
export const HistoryMore = {
  render: () => view({}, { state: page(demoHistory(), 'mock:6') }),
};
export const HistoryLoadingMore = {
  render: () => view({}, { state: page(demoHistory(), 'mock:6'), loadingMore: true }),
};
export const HistoryLoadMoreFailed = {
  render: () =>
    view(
      {},
      {
        state: page(demoHistory(), 'mock:6'),
        notice: 'No pudimos cargar más historial.',
      },
    ),
};
export const HistoryLoading = {
  render: () => view({}, { state: { status: 'loading' } }),
};
export const HistoryError = {
  render: () => view({}, { state: { status: 'error', error: failure(500, 'internal_error') } }),
};
export const Loading = { render: () => view({ state: { status: 'loading' } }) };
export const Error = {
  render: () => view({ state: { status: 'error', error: failure(500, 'internal_error') } }),
};
export const NotFound = {
  render: () => view({ state: { status: 'error', error: failure(404, 'not_found') } }),
};
export const NoPermission = {
  render: () => view({ state: { status: 'forbidden' }, can: readOnly }),
};
export const SessionExpired = { render: () => view({ state: { status: 'expired' } }) };
