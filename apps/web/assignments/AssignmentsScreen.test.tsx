import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects } from '../app/mockApi';
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
import { filtersFromSearch } from './AssignmentsScreen';

/** Exact label match: the status badges also carry "Estado: ..." accessible names. */
const exact = (label: string) => screen.getByLabelText(label);
const set = (label: string, value: string) => fireEvent.change(exact(label), { target: { value } });
const rowsOf = () => screen.getAllByRole('row').slice(1);
const list = (options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: '/flota/asignaciones', ...options });

describe('assignment list', () => {
  it('shows the assignments with the vehicle, the driver, the type and the state in words', async () => {
    await list();
    const table = await screen.findByRole('table', { name: 'Asignaciones (28)' });
    expect(rowsOf()).toHaveLength(25);
    for (const text of ['Principal', 'Secundario', 'Temporal', 'Vigente', 'Finalizada'])
      expect(table).toHaveTextContent(text);
    expect(table).toHaveTextContent('Reemplazada por un nuevo principal');
    expect(table).not.toHaveTextContent(/principal_taken|replaced|secondary|temporary/);
    expect(rowsOf()[0]).toHaveTextContent('Vigente');
    await waitFor(() => expect(table).toHaveTextContent('Ana García López'));
    expect(
      within(table).getAllByRole('link', { name: /^Vehículo ECO-\d+$/ }).length,
    ).toBeGreaterThan(0);
    expect(
      within(table).getAllByRole('link', { name: /^Conductor Ana García López$/ })[0],
    ).toHaveAttribute('href', '/plantilla/empleados/emp-001');
    click('Cargar más asignaciones');
    await waitFor(() => expect(rowsOf()).toHaveLength(28));
    expect(screen.queryByRole('button', { name: 'Cargar más asignaciones' })).toBeNull();
  });

  it('names the vehicle and the driver generically when they cannot be loaded', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles');
    api.controls.failNext('listEmployees');
    await list({ api });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('Vehículo').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Conductor').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Conductor')).toBeNull();
  });

  it('is reached from the navigation under "Flota" and highlights it', async () => {
    await renderApp();
    const link = await screen.findByRole('link', { name: 'Asignaciones' });
    link.click();
    await screen.findByRole('heading', { name: 'Asignaciones', level: 1 });
    expect(screen.getByRole('link', { name: 'Asignaciones' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(document.title).toBe('Asignaciones · Transportes Demo SA · OPSLOG');
  });

  it('filters by state, vehicle, driver and type, and clears the filters', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.assignments, 'list');
    await list({ api });
    await screen.findByRole('table', { name: 'Asignaciones (28)' });
    await waitFor(() =>
      expect(within(exact('Vehículo')).getAllByRole('option').length).toBeGreaterThan(20),
    );
    await waitFor(() =>
      expect(within(exact('Conductor')).getAllByRole('option').length).toBeGreaterThan(5),
    );
    set('Estado', 'current');
    set('Vehículo', 'veh-001');
    set('Conductor', 'emp-001');
    set('Tipo', 'principal');
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith({
        limit: 25,
        status: 'current',
        vehicleId: 'veh-001',
        employeeId: 'emp-001',
        type: 'principal',
      }),
    );
    const table = await screen.findByRole('table', { name: 'Asignaciones (1)' });
    expect(rowsOf()).toHaveLength(1);
    expect(table).toHaveTextContent('Vigente');
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Asignaciones (28)' });
    expect(exact('Estado')).toHaveValue('');
  });

  it('starts from the vehicle or the driver another screen linked to, and shows the history of that one', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.assignments, 'list');
    await renderApp({ api, path: '/flota/asignaciones?vehiculo=veh-001&estado=finalizada' });
    const table = await screen.findByRole('table', { name: 'Asignaciones (1)' });
    expect(spy).toHaveBeenCalledWith({ limit: 25, status: 'ended', vehicleId: 'veh-001' });
    expect(table).toHaveTextContent('Reemplazada por un nuevo principal');
    expect(exact('Estado')).toHaveValue('ended');
    expect(
      filtersFromSearch(new URLSearchParams('conductor=emp-001&estado=vigente')),
    ).toMatchObject({
      employeeId: 'emp-001',
      status: 'current',
    });
    // Anything that is not an identifier or a known state is ignored.
    expect(
      filtersFromSearch(new URLSearchParams('vehiculo=../x&conductor=%20&estado=otro')),
    ).toEqual({
      status: '',
      vehicleId: '',
      employeeId: '',
      type: '',
    });
  });

  it('shows no results for filters that match nothing, and keeps Enter from submitting', async () => {
    await list({ api: createMockApi({ assignments: [] }) });
    expect(
      await screen.findByRole('heading', { name: 'Aún no hay asignaciones' }),
    ).toBeInTheDocument();
    set('Tipo', 'temporary');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    const form = screen.getByRole('search', { name: 'Filtros' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('invites to assign the first driver, and says so differently to read-only roles', async () => {
    const admin = await list({ api: createMockApi({ assignments: [] }) });
    expect(await screen.findByText(/Asigna el primer conductor/)).toBeInTheDocument();
    admin.unmount();
    await list({ api: createMockApi({ assignments: [] }), account: 'viewer' });
    expect(
      await screen.findByText('Cuando se asignen conductores aparecerán aquí.'),
    ).toBeInTheDocument();
  });

  it('offers to assign and to close only to roles that hold create and edit', async () => {
    const admin = await list();
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Nueva asignación' })).toHaveAttribute(
      'href',
      '/flota/asignaciones/nueva',
    );
    expect(screen.getAllByRole('link', { name: /^Cerrar asignación de / }).length).toBeGreaterThan(
      0,
    );
    // Only current assignments can be closed.
    const rows = rowsOf();
    const ended = rows.find((row) => within(row).queryByText('Finalizada'));
    expect(ended && within(ended).queryByRole('link', { name: /^Cerrar / })).toBeNull();
    admin.unmount();
    const piiReader = await list({ account: 'piiReader' });
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Nueva asignación' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Cerrar / })).toBeNull();
    piiReader.unmount();
    await list({ account: 'viewer' });
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'Nueva asignación' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Cerrar / })).toBeNull();
    expect(screen.getAllByRole('link', { name: /^Ver asignación de / }).length).toBeGreaterThan(0);
  });

  it('reports a recoverable error with retry, a 403 as no permission and a 401 as an expired session', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listAssignments');
    set('Estado', 'current');
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('table');
    api.controls.failNext('listAssignments', 403);
    set('Estado', 'ended');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    api.controls.expireSession();
    set('Tipo', 'secondary');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('table', { name: /Asignaciones/ });
  });

  it('reports a failure when loading more, and expires the session on a 401', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listAssignments');
    click('Cargar más asignaciones');
    expect(await screen.findByText('No pudimos cargar más asignaciones.')).toBeInTheDocument();
    api.controls.failNext('listAssignments', 401);
    click('Cargar más asignaciones');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a further page that arrives after the filters changed', async () => {
    const api = createMockApi();
    const real = api.assignments.list;
    const gate = deferred();
    await list({ api });
    await screen.findByRole('table');
    api.assignments.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más asignaciones');
    set('Estado', 'current');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Asignaciones \(\d+\)/ })).toBeVisible(),
    );
    const filtered = rowsOf().length;
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(filtered);
  });

  it('navigates from "Nueva asignación" like a link', async () => {
    await list();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('link', { name: 'Nueva asignación' }));
    await screen.findByRole('heading', { name: 'Nueva asignación', level: 1 });
    expect(window.location.pathname).toBe('/flota/asignaciones/nueva');
  });
});
