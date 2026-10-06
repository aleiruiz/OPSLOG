import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects, type MockApi } from '../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  renderApp,
  screen,
  type,
  waitFor,
  within,
} from '../app/test/utils';
import type { Result, Vehicle } from '../app/types';
import { demoVehicles, makeVehicle } from './fixtures';

const open = (id = 'veh-001', options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: `/flota/vehiculos/${id}`, ...options });

async function openArchiveDialog() {
  await screen.findByRole('heading', { name: /^Vehículo ECO-/, level: 1 });
  const trigger = screen.getByRole('button', { name: 'Archivar' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  return { trigger, dialog };
}

const failing = (api: MockApi, status: number, code: string) => {
  api.vehicles.archive = async (): Promise<Result<Vehicle>> => ({
    ok: false,
    error: { code, status: status as 409, message: 'x', correlationId: 'c' },
  });
};

describe('vehicle detail', () => {
  it('shows every field with Spanish labels, the status badge and the VIN or its absence', async () => {
    const seed = demoVehicles(5);
    await open('veh-005', { api: createMockApi({ vehicles: seed }) });
    expect(
      await screen.findByRole('heading', { name: 'Vehículo ECO-005', level: 1 }),
    ).toBeInTheDocument();
    const data = screen.getByText('Número económico').closest('dl') as HTMLElement;
    expect(
      screen.getByRole('heading', { name: 'Datos del vehículo', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Mercedes-Benz Sprinter 2022')).toBeInTheDocument();
    expect(data).toHaveTextContent('ECO-005');
    expect(data).toHaveTextContent('ABC-105');
    expect(data).toHaveTextContent('Mercedes-Benz');
    expect(data).toHaveTextContent('area-centro');
    expect(data).toHaveTextContent('En mantenimiento');
    expect(data).toHaveTextContent('Cambio de estado de demostración');
    expect(data).toHaveTextContent('27,750 km');
    expect(data).toHaveTextContent('3N6PD23W05ZB10005');
    expect(data).not.toHaveTextContent('in_maintenance');
    expect(screen.getByRole('link', { name: 'Volver a vehículos' })).toHaveAttribute(
      'href',
      '/flota/vehiculos',
    );
  });

  it('shows "Sin VIN registrado" when there is none', async () => {
    await open('veh-001');
    expect(await screen.findByText('Sin VIN registrado')).toBeInTheDocument();
  });

  it('shows edit and archive to an administrator, only edit to a dispatcher and neither to a viewer', async () => {
    const admin = await open('veh-001');
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    expect(screen.getByRole('link', { name: 'Editar' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/veh-001/editar',
    );
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
    admin.unmount();
    const dispatch = await open('veh-001', { account: 'dispatch' });
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    expect(screen.getByRole('link', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    dispatch.unmount();
    await open('veh-001', { account: 'viewer' });
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
  });

  it('explains archived and decommissioned vehicles instead of offering changes', async () => {
    const seed = [
      makeVehicle({
        id: 'a',
        economicNumber: 'ECO-A',
        plate: 'AAA-1',
        archivedAt: '2026-09-30T10:00:00.000Z',
      }),
      makeVehicle({ id: 'd', economicNumber: 'ECO-D', plate: 'DDD-1', status: 'decommissioned' }),
    ];
    const archived = await open('a', { api: createMockApi({ vehicles: seed }) });
    expect(await screen.findByRole('heading', { name: 'Vehículo archivado' })).toBeInTheDocument();
    expect(screen.getByText(/no se puede restaurar desde la aplicación/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    archived.unmount();
    await open('d', { api: createMockApi({ vehicles: seed }) });
    expect(
      await screen.findByRole('heading', { name: 'Vehículo dado de baja' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    // A decommissioned vehicle can still be archived.
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
  });

  it('answers the same message for an unknown vehicle, and offers a retry for other errors', async () => {
    const { api, unmount } = await open('no-existe');
    expect(
      await screen.findByRole('heading', { name: 'Vehículo no encontrado' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a vehículos' })).toBeInTheDocument();
    unmount();
    const failingApi = createMockApi();
    failingApi.controls.failNext('getVehicle');
    await open('veh-001', { api: failingApi });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    expect(api).toBeDefined();
  });

  it('shows the result of the previous screen once and removes it from the address bar', async () => {
    await renderApp({ path: '/flota/vehiculos/veh-001?aviso=creado' });
    expect(await screen.findByText('Vehículo creado.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/flota/vehiculos/veh-001');
    expect(screen.getByText('Vehículo creado.')).toBeInTheDocument();
  });

  it('ignores an unknown notice code', async () => {
    await renderApp({ path: '/flota/vehiculos/veh-001?aviso=otro' });
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    expect(screen.queryByRole('region', { name: 'Notificaciones' })).toBeNull();
  });
});

describe('archive confirmation', () => {
  it('opens a labelled modal with focus on the safe choice, and Escape closes it and restores focus', async () => {
    await open();
    const { trigger, dialog } = await openArchiveDialog();
    expect(dialog).toHaveAccessibleName('Archivar el vehículo ECO-001');
    expect(dialog).toHaveAccessibleDescription(/no se podrá editar/);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus(),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('archives with the version it read, closes the dialog and shows the archived state', async () => {
    const { api } = await open();
    const spy = vi.spyOn(api.vehicles, 'archive');
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar vehículo' }));
    expect(await screen.findByText('Vehículo archivado.')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('veh-001', 1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Vehículo archivado' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivar' })).toBeNull();
    expect(api.controls.vehicles()[0]?.archivedAt).not.toBeNull();
  });

  it('cancels without archiving', async () => {
    const { api } = await open();
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.controls.vehicles()[0]?.archivedAt).toBeNull();
  });

  it('disables both actions while archiving', async () => {
    const api = createMockApi();
    const real = api.vehicles.archive;
    const gate = deferred();
    api.vehicles.archive = async (id, version) => {
      await gate.promise;
      return real(id, version);
    };
    await open('veh-001', { api });
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar vehículo' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled(),
    );
    expect(within(dialog).getByRole('button', { name: 'Cargando…' })).toBeDisabled();
    // The dialog cannot be dismissed while the request runs.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => gate.resolve());
    await screen.findByText('Vehículo archivado.');
  });

  it('keeps the dialog open with a recoverable message when someone else changed the vehicle', async () => {
    const { api } = await open();
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    api.controls.changeVehicleExternally('veh-001', { odometerKm: 90000 });
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar vehículo' }));
    expect(
      await within(dialog).findByText(/Otra persona modificó este vehículo/),
    ).toBeInTheDocument();
    expect(api.controls.vehicles()[0]?.archivedAt).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recargar datos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('90,000 km')).toBeInTheDocument();
    // With the current version the second attempt succeeds.
    const second = await openArchiveDialog();
    fireEvent.click(within(second.dialog).getByRole('button', { name: 'Archivar vehículo' }));
    expect(await screen.findByText('Vehículo archivado.')).toBeInTheDocument();
  });

  it.each([
    ['immutable', 409, /ya estaba archivado/, 'Recargar datos'],
    ['forbidden', 403, /No tienes permiso para archivar/, null],
    ['not_found', 404, /ya no existe/, null],
    ['internal_error', 500, /No pudimos archivar el vehículo/, null],
  ] as const)('explains a %s answer inside the dialog', async (code, status, message, action) => {
    const api = createMockApi();
    failing(api, status, code);
    await open('veh-001', { api });
    const { dialog } = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar vehículo' }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    if (action) expect(within(dialog).getByRole('button', { name: action })).toBeInTheDocument();
    else expect(within(dialog).queryByRole('button', { name: 'Recargar datos' })).toBeNull();
    // Confirming again is possible after a failure (the dialog is not stuck).
    expect(within(dialog).getByRole('button', { name: 'Archivar vehículo' })).toBeEnabled();
  });

  it('closes the dialog and shows the expired-session panel on a 401', async () => {
    const { api } = await open();
    const { dialog } = await openArchiveDialog();
    api.controls.expireSession();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar vehículo' }));
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.queryByRole('dialog')).toBeNull();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    expect(await screen.findByRole('button', { name: 'Archivar' })).toBeInTheDocument();
  });
});
