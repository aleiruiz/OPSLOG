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
import { demoEmployees, makeEmployeeDetail } from './fixtures';
import { EmployeesScreen } from './EmployeesScreen';
import { renderWithSession } from '../app/test/utils';

/** Exact label match: the status badges also carry "Estado: ..." accessible names. */
const exact = (label: string) => screen.getByLabelText(label);
const set = (label: string, value: string) => fireEvent.change(exact(label), { target: { value } });
const rowsOf = () => screen.getAllByRole('row').slice(1);

describe('employee list', () => {
  it('shows a loading state, then the staff with labelled kinds, statuses and no technical ids', async () => {
    const api = createMockApi();
    const real = api.employees.list;
    const gate = deferred();
    api.employees.list = async (query) => {
      await gate.promise;
      return real(query);
    };
    await renderWithSession(<EmployeesScreen />, { api });
    expect(await screen.findByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () => gate.resolve());
    const table = await screen.findByRole('table', { name: 'Empleados (28)' });
    for (const label of [
      'Conductor',
      'Despachador',
      'Otro',
      'Activo',
      'Inactivo',
      'Suspendido',
      'Baja',
    ])
      expect(table).toHaveTextContent(label);
    expect(table).not.toHaveTextContent(/terminated|suspended|dispatcher|driver/);
    expect(rowsOf()).toHaveLength(25);
    // Last name first, like the server's order, with the employee number in the second column.
    expect(within(table).getByRole('link', { name: 'García López, Ana' })).toHaveAttribute(
      'href',
      '/plantilla/empleados/emp-001',
    );
    expect(table).toHaveTextContent('E-0001');
  });

  it('shows the fitness badge for drivers only, with a dash for everyone else', async () => {
    await renderApp({ path: '/plantilla/empleados' });
    const table = await screen.findByRole('table');
    const fit = within(table).getAllByLabelText('Estado: Apto para operar');
    const unfit = within(table).getAllByLabelText('Estado: No apto para operar');
    expect(fit.length).toBeGreaterThan(0);
    expect(unfit.length).toBeGreaterThan(0);
    const dispatcherRow = within(table)
      .getByRole('link', { name: 'Martínez Soto, María' })
      .closest('tr');
    expect(dispatcherRow).toHaveTextContent('Despachador');
    expect(dispatcherRow).toHaveTextContent('—');
    expect(dispatcherRow).not.toHaveTextContent('apto');
  });

  it('names the area of each employee from the structure, and falls back to the id without it', async () => {
    const api = createMockApi();
    const withNames = await renderApp({ api, path: '/plantilla/empleados' });
    await screen.findByRole('table');
    expect(within(screen.getByRole('table')).getAllByText('Norte').length).toBeGreaterThan(0);
    expect(screen.getByRole('table')).not.toHaveTextContent('area-norte');
    withNames.unmount();
    const broken = createMockApi();
    broken.controls.failNext('listAreas');
    await renderApp({ api: broken, path: '/plantilla/empleados' });
    const table = await screen.findByRole('table');
    expect(table).toHaveTextContent('area-norte');
  });

  it('is reached from the navigation group "Plantilla" and highlights it', async () => {
    await renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByText('Plantilla', { exact: true })).toBeInTheDocument();
    const link = within(nav).getByRole('link', { name: 'Empleados' });
    expect(link).not.toHaveAttribute('aria-current');
    link.click();
    await screen.findByRole('heading', { name: 'Empleados', level: 1 });
    expect(screen.getByRole('link', { name: 'Empleados' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Empleados · Transportes Demo SA · OPSLOG');
  });

  it('loads further pages with the cursor and keeps them until a filter changes', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.employees, 'list');
    await renderApp({ api, path: '/plantilla/empleados' });
    await screen.findByRole('table');
    click('Cargar más empleados');
    await waitFor(() => expect(rowsOf()).toHaveLength(28));
    expect(list).toHaveBeenLastCalledWith({ limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más empleados' })).toBeNull();
    set('Estado', 'active');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Empleados \(\d+\)/ })).toBeInTheDocument(),
    );
    expect(list).toHaveBeenLastCalledWith({ limit: 25, status: 'active' });
  });

  it('filters by kind, status, area and archived, and clears the filters', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.employees, 'list');
    await renderApp({ api, path: '/plantilla/empleados' });
    await screen.findByRole('table', { name: 'Empleados (28)' });
    set('Tipo', 'driver');
    await screen.findByRole('table', { name: 'Empleados (17)' });
    set('Estado', 'active');
    await screen.findByRole('table', { name: 'Empleados (11)' });
    set('Área', 'area-norte');
    await screen.findByRole('table', { name: 'Empleados (5)' });
    expect(list).toHaveBeenLastCalledWith({
      limit: 25,
      kind: 'driver',
      status: 'active',
      areaId: 'area-norte',
    });
    set('Archivados', 'true');
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        limit: 25,
        kind: 'driver',
        status: 'active',
        areaId: 'area-norte',
        includeArchived: 'true',
      }),
    );
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Empleados (28)' });
    expect(exact('Tipo')).toHaveValue('');
    expect(exact('Área')).toHaveValue('');
    expect(exact('Archivados')).toHaveValue('false');
  });

  it('offers the areas of the company, inactive ones too, instead of asking for an identifier', async () => {
    await renderApp({ path: '/plantilla/empleados' });
    await screen.findByRole('table');
    const select = exact('Área') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    const options = Array.from(select.options).map((o) => o.textContent?.replace(/ /g, '·'));
    expect(options[0]).toBe('Todas las áreas');
    expect(options).toContain('····Base Guadalupe (inactiva)');
    expect(Array.from(select.options).every((option) => !option.disabled)).toBe(true);
  });

  it('shows archived employees with a badge when asked, without an edit link for them or for terminated ones', async () => {
    const seed = demoEmployees(3);
    seed[1] = { ...seed[1]!, archivedAt: '2026-09-30T10:00:00.000Z' };
    seed[2] = { ...seed[2]!, status: 'terminated' };
    await renderApp({ api: createMockApi({ employees: seed }), path: '/plantilla/empleados' });
    await screen.findByRole('table', { name: 'Empleados (2)' });
    set('Archivados', 'true');
    const table = await screen.findByRole('table', { name: 'Empleados (3)' });
    expect(within(table).getByLabelText('Estado: Archivado')).toBeInTheDocument();
    expect(within(table).getAllByRole('link', { name: /^Editar/ })).toHaveLength(1);
  });

  it('shows no results for filters that match nothing, an empty state without them, and keeps Enter from submitting', async () => {
    await renderApp({
      api: createMockApi({ employees: demoEmployees(2) }),
      path: '/plantilla/empleados',
    });
    await screen.findByRole('table');
    set('Tipo', 'dispatcher');
    set('Estado', 'terminated');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    const form = screen.getByRole('search', { name: 'Filtros' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('invites to register the first employee when the staff is empty, and says so differently to read-only roles', async () => {
    const admin = await renderApp({
      api: createMockApi({ employees: [] }),
      path: '/plantilla/empleados',
    });
    expect(
      await screen.findByRole('heading', { name: 'Aún no hay empleados' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Registra al primer empleado de tu empresa.')).toBeInTheDocument();
    admin.unmount();
    await renderApp({
      api: createMockApi({ employees: [] }),
      account: 'viewer',
      path: '/plantilla/empleados',
    });
    expect(
      await screen.findByText('Cuando se registren empleados aparecerán aquí.'),
    ).toBeInTheDocument();
  });

  it('offers create and edit only to roles that hold those permissions', async () => {
    const admin = await renderApp({ path: '/plantilla/empleados' });
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Nuevo empleado' })).toHaveAttribute(
      'href',
      '/plantilla/empleados/nuevo',
    );
    expect(screen.getByRole('link', { name: 'Editar García López, Ana' })).toBeInTheDocument();
    admin.unmount();
    const pii = await renderApp({ account: 'piiReader', path: '/plantilla/empleados' });
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Nuevo empleado' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Editar/ })).toBeNull();
    pii.unmount();
    await renderApp({ account: 'viewer', path: '/plantilla/empleados' });
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'Nuevo empleado' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Editar/ })).toBeNull();
  });

  it('never shows personal data in the list, not even to a role that may see it', async () => {
    await renderApp({ path: '/plantilla/empleados' });
    const table = await screen.findByRole('table');
    expect(table).not.toHaveTextContent(/ejemplo\.test|EJEM8001|LIC-|\+5255/);
  });

  it('reports a recoverable error with retry, a 403 as no permission and a 401 as an expired session', async () => {
    const { api } = await renderApp({ path: '/plantilla/empleados' });
    await screen.findByRole('table');
    api.controls.failNext('listEmployees');
    set('Estado', 'active');
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('table');
    api.controls.failNext('listEmployees', 403);
    set('Estado', 'suspended');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    api.controls.expireSession();
    set('Estado', 'inactive');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(
      await screen.findByRole('heading', { name: 'Datos no disponibles' }),
    ).toBeInTheDocument();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('table', { name: /Empleados/ });
  });

  it('reports a failure when loading more, and expires the session on a 401', async () => {
    const { api } = await renderApp({ path: '/plantilla/empleados' });
    await screen.findByRole('table');
    api.controls.failNext('listEmployees');
    click('Cargar más empleados');
    expect(await screen.findByText('No pudimos cargar más empleados.')).toBeInTheDocument();
    api.controls.failNext('listEmployees', 401);
    click('Cargar más empleados');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a further page that arrives after the filters changed', async () => {
    const api = createMockApi();
    const real = api.employees.list;
    const gate = deferred();
    await renderApp({ api, path: '/plantilla/empleados' });
    await screen.findByRole('table');
    api.employees.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más empleados');
    set('Tipo', 'other');
    await screen.findByRole('table', { name: 'Empleados (5)' });
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(5);
  });

  it('ignores a further page that arrives after the list was reloaded under the same filters', async () => {
    const api = createMockApi();
    const real = api.employees.list;
    const gate = deferred();
    await renderApp({ api, path: '/plantilla/empleados' });
    await screen.findByRole('table');
    api.employees.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más empleados');
    set('Estado', 'active');
    set('Estado', '');
    await screen.findByRole('table', { name: /Empleados/ });
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(25);
  });

  it('keeps the list when only the structure fails to load, and keeps showing a stale area filter id', async () => {
    const api = createMockApi({ employees: [makeEmployeeDetail({ areaId: 'area-vieja' })] });
    await renderApp({ api, path: '/plantilla/empleados' });
    const table = await screen.findByRole('table');
    expect(table).toHaveTextContent('area-vieja');
    set('Área', 'area-norte');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
  });

  it('navigates from "Nuevo empleado" like a link: plain clicks stay in the app, modified clicks are left to the browser', async () => {
    await renderApp({ path: '/plantilla/empleados' });
    await screen.findByRole('table');
    const link = screen.getByRole('link', { name: 'Nuevo empleado' });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { button: 1 });
    expect(window.location.pathname).toBe('/plantilla/empleados');
    fireEvent.click(link);
    await screen.findByRole('form', { name: 'Nuevo empleado' });
    expect(window.location.pathname).toBe('/plantilla/empleados/nuevo');
  });
});
