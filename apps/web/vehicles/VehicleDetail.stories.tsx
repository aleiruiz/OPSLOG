import React from 'react';
import type { ResourceState } from '../app/resource';
import type { Vehicle } from '../app/types';
import { makeVehicle } from './fixtures';
import { Frame, noop } from './storyFrame';
import { archiveClosed, VehicleDetailView, type VehicleDetailViewProps } from './VehicleDetailView';

export default {
  title: 'Flota/Vehiculos/Detalle',
  parameters: { layout: 'padded' },
};

const ready = (vehicle: Vehicle): ResourceState<Vehicle> => ({ status: 'ready', data: vehicle });
const base = makeVehicle({
  vin: '3N6PD23W05ZB10005',
  statusReason: 'Alta',
  updatedAt: '2026-10-01T16:45:00.000Z',
});
const admin = () => true;
const readOnly = () => false;

const view = (props: Partial<VehicleDetailViewProps> = {}) => (
  <Frame>
    <VehicleDetailView
      state={ready(base)}
      can={admin}
      archive={archiveClosed}
      onRetry={noop}
      onArchiveRequest={noop}
      onArchiveConfirm={noop}
      onArchiveCancel={noop}
      onArchiveErrorAction={noop}
      {...props}
    />
  </Frame>
);

// Stories with the modal open set `harness: 'modal'`: the all-stories axe page skips them (a modal hides the rest of the
// page by design) and the dialog is scanned on its own in e2e/vehicles.spec.ts.
const modal = { layout: 'padded', harness: 'modal' };

export const Default = { render: () => view() };
export const WithoutVin = {
  render: () =>
    view({
      state: ready(makeVehicle({ status: 'out_of_service', statusReason: 'Falla de transmisión' })),
    }),
};
export const ReadOnly = { render: () => view({ can: readOnly }) };
export const EditorWithoutArchive = { render: () => view({ can: (p) => p === 'edit' }) };
export const JustCreated = { render: () => view({ notice: 'Vehículo creado.' }) };
export const JustSaved = { render: () => view({ notice: 'Cambios guardados.' }) };
export const Decommissioned = {
  render: () =>
    view({
      state: ready(makeVehicle({ status: 'decommissioned', statusReason: 'Venta de la unidad' })),
    }),
};
export const Archived = {
  render: () =>
    view({
      state: ready(makeVehicle({ archivedAt: '2026-09-30T10:00:00.000Z', version: 4 })),
      notice: 'Vehículo archivado.',
    }),
};
export const ArchiveConfirmation = {
  parameters: modal,
  render: () => view({ archive: { open: true, busy: false } }),
};
export const ArchiveInProgress = {
  parameters: modal,
  render: () => view({ archive: { open: true, busy: true } }),
};
export const ArchiveConflict = {
  parameters: modal,
  render: () =>
    view({
      archive: {
        open: true,
        busy: false,
        error:
          'Otra persona modificó este vehículo mientras lo revisabas. Recarga los datos y vuelve a decidir.',
        errorActionLabel: 'Recargar datos',
      },
    }),
};
export const Loading = { render: () => view({ state: { status: 'loading' } }) };
export const Error = {
  render: () =>
    view({
      state: {
        status: 'error',
        error: { code: 'internal_error', status: 500, message: 'x', correlationId: 'c' },
      },
    }),
};
export const NotFound = {
  render: () =>
    view({
      state: {
        status: 'error',
        error: { code: 'not_found', status: 404, message: 'x', correlationId: 'c' },
      },
    }),
};
export const NoPermission = {
  render: () => view({ state: { status: 'forbidden' }, can: readOnly }),
};
export const SessionExpired = { render: () => view({ state: { status: 'expired' } }) };
