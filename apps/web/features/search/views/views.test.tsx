import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoCredentials, type MockApi } from '../../../app/mockApi';
import { click, fireEvent, renderApp, screen, waitFor, within } from '../../../app/test/utils';

const set = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const clickText = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const headers = () => screen.getAllByRole('columnheader').map((cell) => cell.textContent);

async function signInAs(api: MockApi, account: keyof typeof demoCredentials) {
  await api.auth.login(demoCredentials[account]);
}

describe('filters in the address', () => {
  it('restores the vehicle filters from the address and sends them to the server', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.vehicles, 'list');
    await renderApp({
      api,
      path: '/flota/vehiculos?status=active&yearFrom=2020&kmTo=50000&limit=50',
    });
    await screen.findByRole('table');
    expect(list).toHaveBeenCalledWith({
      limit: 50,
      status: 'active',
      yearFrom: 2020,
      kmTo: 50000,
    });
    expect(screen.getByLabelText('Estado')).toHaveValue('active');
    expect(screen.getByLabelText('Año desde')).toHaveValue(2020);
    expect(screen.getByLabelText('Vehículos por página')).toHaveValue('50');
  });

  it('writes a change to the address, keeps the rest and clears everything at once', async () => {
    await renderApp({ path: '/flota/vehiculos?yearFrom=2020' });
    await screen.findByRole('table');
    set('Estado', 'in_maintenance');
    await waitFor(() =>
      expect(window.location.search).toBe('?status=in_maintenance&yearFrom=2020'),
    );
    clickText('Limpiar filtros');
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.getByLabelText('Año desde')).toHaveValue(null);
  });

  it('applies a range only once it is valid and says so while it is not', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.vehicles, 'list');
    await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    list.mockClear();
    set('Año desde', '19');
    expect(await screen.findByText('Entre 1,950 y 2,100.')).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(list).not.toHaveBeenCalled();
    set('Año desde', '2021');
    await waitFor(() => expect(window.location.search).toBe('?yearFrom=2021'));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ limit: 25, yearFrom: 2021 }));
  });

  it('ignores keys and values the list does not know', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.vehicles, 'list');
    await renderApp({ api, path: '/flota/vehiculos?status=flying&sort=plate&x=1&yearTo=3000' });
    await screen.findByRole('table');
    expect(list).toHaveBeenCalledWith({ limit: 25 });
  });

  it.each([
    ['/plantilla/empleados?hiredFrom=2022-06-01&licenseExpiresTo=2027-01-31', 'employees'],
    ['/flota/documentos?expiresFrom=2026-10-01&expiresTo=2026-12-31&status=expiring', 'documents'],
    ['/flota/seguros?endsFrom=2026-10-01&endsTo=2027-01-31', 'insurance'],
  ] as const)('sends the range filters of %s', async (path, port) => {
    const api = createMockApi();
    const list = vi.spyOn(api[port], 'list' as never) as unknown as ReturnType<typeof vi.fn>;
    await renderApp({ api, path });
    await screen.findByRole('table');
    const query = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
    expect(list).toHaveBeenCalledWith(expect.objectContaining(query));
    expect(window.location.search).toBe(`?${new URLSearchParams(query).toString()}`);
  });

  it('keeps the maintenance filters in the address, including overdue orders', async () => {
    await renderApp({ path: '/flota/mantenimiento?overdue=true&kind=corrective' });
    await screen.findByRole('heading', { name: 'Órdenes de mantenimiento', level: 1 });
    await waitFor(() => expect(screen.getByLabelText('Tipo')).toHaveTextContent('Correctiva'));
    expect(screen.getByLabelText('Vencimiento')).toHaveTextContent('Solo vencidas');
    expect(window.location.search).toBe('?overdue=true&kind=corrective');
  });

  it('sends the dates and the order of the incident list', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.incidents, 'list');
    await renderApp({
      api,
      path: '/incidents?occurredFrom=2026-10-01&occurredTo=2026-10-31&sort=-createdAt',
    });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith({
      limit: 25,
      occurredFrom: '2026-10-01',
      occurredTo: '2026-10-31',
      sort: 'createdAt',
      direction: 'desc',
    });
    expect(screen.getByLabelText('Ordenar por')).toHaveValue('-createdAt');
    set('Ordenar por', 'folio');
    await waitFor(() => expect(window.location.search).toContain('sort=folio'));
    expect(window.location.search).toContain('occurredFrom=2026-10-01');
  });
});

describe('saved views', () => {
  async function saveView(name: string, shared = false) {
    clickText('Guardar vista');
    fireEvent.change(await screen.findByLabelText('Nombre de la vista'), {
      target: { value: name },
    });
    if (shared) fireEvent.click(screen.getByLabelText('Compartir con la empresa'));
    clickText('Guardar');
  }

  it('saves the current filters, applies them later and updates and deletes the view', async () => {
    await renderApp({ path: '/flota/vehiculos?status=active&yearFrom=2020' });
    await screen.findByRole('table');
    await saveView('Activos recientes');
    await waitFor(() => expect(screen.getByLabelText('Vista guardada')).toHaveValue('view-1'));
    expect(screen.queryByLabelText('Nombre de la vista')).toBeNull();

    clickText('Limpiar filtros');
    await waitFor(() => expect(window.location.search).toBe(''));
    set('Vista guardada', 'view-1');
    await waitFor(() => expect(window.location.search).toBe('?status=active&yearFrom=2020'));

    set('Estado', 'restricted');
    await waitFor(() => expect(window.location.search).toContain('restricted'));
    clickText('Actualizar vista');
    expect(screen.getByLabelText('Nombre de la vista')).toHaveValue('Activos recientes');
    fireEvent.change(screen.getByLabelText('Nombre de la vista'), {
      target: { value: 'Restringidos' },
    });
    clickText('Guardar cambios');
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Vista guardada')).getByText('Restringidos'),
      ).toBeInTheDocument(),
    );

    clickText('Eliminar vista');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Vista guardada')).toHaveValue('');
    expect(screen.queryByText('Restringidos')).toBeNull();
  });

  it('refuses a repeated name and shows the limit of views in Spanish', async () => {
    const api = createMockApi();
    await renderApp({ api, path: '/flota/vehiculos?status=active' });
    await screen.findByRole('table');
    await saveView('Mi vista');
    await waitFor(() => expect(screen.queryByLabelText('Nombre de la vista')).toBeNull());
    await saveView('mi vista');
    expect(
      await screen.findByText('Ya tienes una vista con ese nombre en este listado.'),
    ).toBeInTheDocument();
    for (let index = 0; index < 49; index += 1)
      await api.views.create({ module: 'vehicles', name: `Extra ${index}` });
    fireEvent.change(screen.getByLabelText('Nombre de la vista'), { target: { value: 'Una más' } });
    clickText('Guardar');
    expect(await screen.findByText(/Llegaste al límite de 50 vistas/)).toBeInTheDocument();
  });

  it('shows a shared view to others without the parts they cannot use, and says what was left out', async () => {
    const api = createMockApi();
    await signInAs(api, 'admin');
    await api.views.create({
      module: 'maintenance',
      name: 'Costosas del mes',
      shared: true,
      filters: { status: 'assigned', costFrom: '1000', bogus: 'x' },
      columns: ['order', 'cost'],
    });
    await renderApp({ api, account: 'viewer', path: '/flota/mantenimiento' });
    await screen.findByRole('heading', { name: 'Órdenes de mantenimiento', level: 1 });
    const select = await screen.findByLabelText('Vista guardada');
    await waitFor(() => expect(within(select).getByText('Costosas del mes')).toBeInTheDocument());
    set('Vista guardada', 'view-1');
    expect(
      await screen.findByText(/Se omitió lo que no puedes usar o ya no existe: .*Costo desde/),
    ).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe('?status=assigned'));
    expect(screen.queryByLabelText('Costo desde')).toBeNull();
    // A viewer cannot edit someone else's shared view.
    expect(screen.queryByRole('button', { name: 'Eliminar vista' })).toBeNull();
  });

  it('does not show the private views of another user', async () => {
    const api = createMockApi();
    await signInAs(api, 'admin');
    await api.views.create({ module: 'vehicles', name: 'Solo mía', filters: { status: 'active' } });
    await renderApp({ api, account: 'viewer', path: '/flota/vehiculos' });
    await screen.findByRole('table');
    const select = screen.getByLabelText('Vista guardada');
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(within(select).queryByText('Solo mía')).toBeNull();
    const direct = await api.views.update('view-1', { version: 1, name: 'Mía ahora' });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error.status).toBe(404);
  });

  it('expires the session when the server answers 401', async () => {
    const api = createMockApi();
    await renderApp({ api, path: '/flota/vehiculos?status=active' });
    await screen.findByRole('table');
    api.controls.failNext('views', 401);
    await saveView('Se vence');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });
});

describe('persistent columns', () => {
  it('hides a column, keeps the choice for the user and restores the defaults', async () => {
    const api = createMockApi();
    const { unmount } = await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    expect(headers()).toContain('Placa');
    clickText('Columnas');
    fireEvent.click(await screen.findByLabelText('Placa'));
    await waitFor(() => expect(headers()).not.toContain('Placa'));
    // Identifying and action columns cannot be hidden.
    expect(screen.queryByLabelText('Número económico')).toBeNull();
    expect(headers()).toContain('Número económico');
    expect(headers()).toContain('Acciones');
    const saved = await api.views.columns('vehicles');
    expect(saved.ok && saved.value.columns).toEqual(expect.not.arrayContaining(['plate']));
    unmount();

    await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    await waitFor(() => expect(headers()).not.toContain('Placa'));
    clickText('Columnas');
    clickText('Restablecer columnas');
    await waitFor(() => expect(headers()).toContain('Placa'));
    const reset = await api.views.columns('vehicles');
    expect(reset.ok && reset.value.columns).toBeNull();
  });

  it('offers the cost column only to who may see costs and keeps working when saving fails', async () => {
    const api = createMockApi();
    await renderApp({ api, path: '/flota/mantenimiento' });
    await screen.findByRole('table');
    click('Columnas');
    const picker = await screen.findByRole('group', { name: 'Columnas visibles' });
    expect(within(picker).getByLabelText('Costo')).toBeInTheDocument();
    api.controls.failNext('views', 500);
    fireEvent.click(within(picker).getByLabelText('Tipo'));
    expect(await screen.findByText(/No pudimos guardar tus columnas/)).toBeInTheDocument();
  });

  it('does not offer the cost column or filters without view_costs', async () => {
    await renderApp({ account: 'viewer', path: '/flota/mantenimiento' });
    await screen.findByRole('table');
    click('Columnas');
    const picker = await screen.findByRole('group', { name: 'Columnas visibles' });
    expect(within(picker).getByLabelText('Estado')).toBeInTheDocument();
    expect(within(picker).queryByLabelText('Costo')).toBeNull();
    expect(screen.queryByLabelText('Costo desde')).toBeNull();
  });
});
