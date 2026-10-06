import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects } from '../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  renderApp,
  renderWithSession,
  screen,
  type,
  waitFor,
  within,
} from '../app/test/utils';
import { demoVehicles } from './fixtures';
import { VehiclesScreen } from './VehiclesScreen';

/** Exact label match: the status badges also carry "Estado: ..." accessible names. */
const exact = (label: string) => screen.getByLabelText(label);
const set = (label: string, value: string) => fireEvent.change(exact(label), { target: { value } });
const rowsOf = () => screen.getAllByRole('row').slice(1);

describe('vehicle list', () => {
  it('shows a loading state, then the vehicles with labelled statuses and no technical ids', async () => {
    const api = createMockApi();
    const real = api.vehicles.list;
    const gate = deferred();
    api.vehicles.list = async (query) => {
      await gate.promise;
      return real(query);
    };
    await renderWithSession(<VehiclesScreen />, { api });
    expect(await screen.findByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () => gate.resolve());
    const table = await screen.findByRole('table', { name: 'Vehículos (28)' });
    expect(table).toHaveTextContent('ECO-001');
    expect(table).toHaveTextContent('Nissan NP300');
    expect(table).toHaveTextContent('15,150 km');
    for (const label of [
      'Activo',
      'Restringido',
      'En mantenimiento',
      'Fuera de servicio',
      'Inactivo',
      'Baja',
    ])
      expect(table).toHaveTextContent(label);
    expect(table).not.toHaveTextContent(/in_maintenance|out_of_service|decommissioned/);
    expect(rowsOf()).toHaveLength(25);
    expect(screen.getByRole('link', { name: 'ECO-001' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/veh-001',
    );
  });

  it('is reached from the navigation and highlights it', async () => {
    await renderApp();
    const link = await screen.findByRole('link', { name: 'Vehículos' });
    expect(link).not.toHaveAttribute('aria-current');
    link.click();
    await screen.findByRole('heading', { name: 'Vehículos', level: 1 });
    expect(screen.getByRole('link', { name: 'Vehículos' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Vehículos · Transportes Demo SA · OPSLOG');
  });

  it('loads further pages with the cursor and keeps them until a filter changes', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.vehicles, 'list');
    await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    click('Cargar más vehículos');
    await waitFor(() => expect(rowsOf()).toHaveLength(28));
    expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más vehículos' })).toBeNull();
    set('Estado', 'active');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Vehículos \(\d+\)/ })).toBeInTheDocument(),
    );
    expect(list).toHaveBeenLastCalledWith({ limit: 25, status: 'active' });
  });

  it('filters by status, area and archived, and clears the filters', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.vehicles, 'list');
    await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table', { name: 'Vehículos (28)' });
    set('Estado', 'in_maintenance');
    await screen.findByRole('table', { name: 'Vehículos (3)' });
    set('Identificador de área', ' area-norte ');
    await screen.findByRole('table', { name: 'Vehículos (1)' });
    expect(list).toHaveBeenLastCalledWith({
      limit: 25,
      status: 'in_maintenance',
      areaId: 'area-norte',
    });
    set('Archivados', 'true');
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        limit: 25,
        status: 'in_maintenance',
        areaId: 'area-norte',
        includeArchived: 'true',
      }),
    );
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Vehículos (28)' });
    expect(exact('Estado')).toHaveValue('');
  });

  it('shows archived vehicles with a badge when asked to include them', async () => {
    const seed = demoVehicles(3);
    seed[1] = { ...seed[1]!, archivedAt: '2026-09-30T10:00:00.000Z' };
    await renderApp({ api: createMockApi({ vehicles: seed }), path: '/flota/vehiculos' });
    await screen.findByRole('table', { name: 'Vehículos (2)' });
    set('Archivados', 'true');
    const table = await screen.findByRole('table', { name: 'Vehículos (3)' });
    expect(within(table).getByLabelText('Estado: Archivado')).toBeInTheDocument();
    // An archived vehicle cannot be edited: no "Editar" link on its row.
    expect(within(table).queryByRole('link', { name: 'Editar ECO-002' })).toBeNull();
    expect(within(table).getByRole('link', { name: 'Editar ECO-001' })).toBeInTheDocument();
  });

  it('does not query with an invalid area and explains why', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.vehicles, 'list');
    await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    const calls = list.mock.calls.length;
    set('Identificador de área', 'área norte');
    expect(
      await screen.findByText(/El filtro no se aplica hasta que sea válido/),
    ).toBeInTheDocument();
    expect(exact('Identificador de área')).toHaveAttribute('aria-invalid', 'true');
    expect(list.mock.calls.every((call) => call[0]?.areaId === undefined)).toBe(true);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(calls);
    set('Identificador de área', 'area-sur');
    await waitFor(() => expect(screen.queryByText(/El filtro no se aplica/)).toBeNull());
  });

  it('shows no results for filters that match nothing, an empty state without them, and keeps Enter from submitting', async () => {
    await renderApp({ path: '/flota/vehiculos' });
    await screen.findByRole('table');
    set('Identificador de área', 'area-sin-flota');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    const form = screen.getByRole('search', { name: 'Filtros' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('invites to register the first vehicle when the fleet is empty, and says so differently to read-only roles', async () => {
    const admin = await renderApp({
      api: createMockApi({ vehicles: [] }),
      path: '/flota/vehiculos',
    });
    expect(
      await screen.findByRole('heading', { name: 'Aún no hay vehículos' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Registra el primer vehículo de tu flota.')).toBeInTheDocument();
    admin.unmount();
    await renderApp({
      api: createMockApi({ vehicles: [] }),
      account: 'viewer',
      path: '/flota/vehiculos',
    });
    expect(
      await screen.findByText('Cuando se registren vehículos aparecerán aquí.'),
    ).toBeInTheDocument();
  });

  it('offers create and edit only to roles that hold those permissions', async () => {
    const admin = await renderApp({ path: '/flota/vehiculos' });
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Nuevo vehículo' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/nuevo',
    );
    expect(screen.getByRole('link', { name: 'Editar ECO-001' })).toBeInTheDocument();
    admin.unmount();
    await renderApp({ account: 'viewer', path: '/flota/vehiculos' });
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'Nuevo vehículo' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Editar/ })).toBeNull();
  });

  it('reports a recoverable error with retry, a 403 as no permission and a 401 as an expired session', async () => {
    const { api } = await renderApp({ path: '/flota/vehiculos' });
    await screen.findByRole('table');
    api.controls.failNext('listVehicles');
    set('Estado', 'active');
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('table');
    api.controls.failNext('listVehicles', 403);
    set('Estado', 'restricted');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    api.controls.expireSession();
    set('Estado', 'inactive');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(
      await screen.findByRole('heading', { name: 'Datos no disponibles' }),
    ).toBeInTheDocument();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('table', { name: /Vehículos/ });
  });

  it('reports a failure when loading more, and expires the session on a 401', async () => {
    const { api } = await renderApp({ path: '/flota/vehiculos' });
    await screen.findByRole('table');
    api.controls.failNext('listVehicles');
    click('Cargar más vehículos');
    expect(await screen.findByText('No pudimos cargar más vehículos.')).toBeInTheDocument();
    api.controls.failNext('listVehicles', 401);
    click('Cargar más vehículos');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a further page that arrives after the filters changed', async () => {
    const api = createMockApi();
    const real = api.vehicles.list;
    const gate = deferred();
    await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    api.vehicles.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más vehículos');
    set('Estado', 'in_maintenance');
    await screen.findByRole('table', { name: 'Vehículos (3)' });
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(3);
  });

  it('ignores a further page that arrives after the list was reloaded under the same filters', async () => {
    const api = createMockApi();
    const real = api.vehicles.list;
    const gate = deferred();
    await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    api.vehicles.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más vehículos');
    // Changing the filter and changing it back reloads the first page under the original filters.
    set('Estado', 'active');
    set('Estado', '');
    await screen.findByRole('table', { name: /Vehículos/ });
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(25);
  });

  it('navigates from "Nuevo vehículo" like a link: plain clicks stay in the app, modified clicks are left to the browser', async () => {
    await renderApp({ path: '/flota/vehiculos' });
    await screen.findByRole('table');
    const link = screen.getByRole('link', { name: 'Nuevo vehículo' });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { button: 1 });
    expect(window.location.pathname).toBe('/flota/vehiculos');
    fireEvent.click(link);
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    expect(window.location.pathname).toBe('/flota/vehiculos/nuevo');
  });
});
