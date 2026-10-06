import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoCredentials, demoSubjects } from '../app/mockApi';
import {
  click,
  fireEvent,
  getField,
  renderApp,
  screen,
  type,
  waitFor,
  within,
} from '../app/test/utils';

async function create(
  path = '/plantilla/areas/nueva',
  options: Parameters<typeof renderApp>[0] = {},
) {
  const view = await renderApp({ path, ...options });
  await screen.findByRole('heading', { name: 'Nueva área', level: 1 });
  await screen.findByRole('form', { name: 'Nueva área' });
  return view;
}
const parent = () => getField('Área superior') as HTMLSelectElement;
const optionLabels = () => [...parent().options].map((option) => option.textContent ?? '');
const addResponsible = (id: string) => {
  type('Agregar responsable', id);
  click('Agregar');
};

describe('create area', () => {
  it('explains the missing name, focuses it and does not call the API', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'create');
    await create('/plantilla/areas/nueva', { api });
    click('Crear área');
    expect(screen.getByText('Escribe el nombre del área.')).toBeInTheDocument();
    expect(getField('Nombre')).toHaveFocus();
    expect(getField('Nombre')).toHaveAttribute('aria-invalid', 'true');
    expect(spy).not.toHaveBeenCalled();
    type('Nombre', 'Oeste');
    expect(screen.queryByText('Escribe el nombre del área.')).toBeNull();
  });

  it('checks the code format and the unavailable parents in the form', async () => {
    await create();
    type('Nombre', 'Oeste');
    type('Código', '-mal');
    click('Crear área');
    expect(screen.getByText(/32 caracteres: letras, números/)).toBeInTheDocument();
    expect(getField('Código')).toHaveFocus();
    type('Código', 'oeste');
    fireEvent.change(parent(), { target: { value: 'area-mty-guadalupe' } });
    click('Crear área');
    expect(screen.getByText(/Esa área no está disponible: inactiva/)).toBeInTheDocument();
    expect(parent()).toHaveFocus();
    fireEvent.change(parent(), { target: { value: 'area-apodaca-taller' } });
    expect(screen.queryByText(/no está disponible: inactiva/)).toBeNull();
  });

  it('offers the tree as the parent list, disabling what cannot host a new area', async () => {
    await create();
    expect(optionLabels()[0]).toBe('Ninguna: área raíz');
    const taller = [...parent().options].find((option) => option.value === 'area-apodaca-taller');
    expect(taller).toBeDisabled();
    expect(taller?.textContent).toMatch(/superaría los 4 niveles/);
    const guadalupe = [...parent().options].find((option) => option.value === 'area-mty-guadalupe');
    expect(guadalupe).toBeDisabled();
    expect(
      [...parent().options].find((option) => option.value === 'area-norte'),
    ).not.toBeDisabled();
  });

  it('creates the area with normalized values and opens its detail with a confirmation', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'create');
    await create('/plantilla/areas/nueva', { api });
    type('Nombre', '  Base   Oeste ');
    type('Código', 'oes-1');
    fireEvent.change(parent(), { target: { value: 'area-sur' } });
    addResponsible('user-dispatch');
    click('Crear área');
    expect(
      await screen.findByRole('heading', { name: 'Base Oeste', level: 1 }),
    ).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({
      name: 'Base Oeste',
      code: 'OES-1',
      parentId: 'area-sur',
      responsibleIds: ['user-dispatch'],
    });
    expect(screen.getByText('Área creada.')).toBeInTheDocument();
    expect(dd('Nivel')).toHaveTextContent('2 de 4');
    expect(window.location.search).toBe('');
  });

  it('opens with the parent of "Nueva sub-área", and ignores a parent that cannot host it', async () => {
    const view = await create('/plantilla/areas/nueva?padre=area-norte-mty');
    expect(parent()).toHaveValue('area-norte-mty');
    view.unmount();
    for (const padre of ['area-mty-guadalupe', 'area-apodaca-taller', 'no-existe', 'mal id!']) {
      const again = await create(`/plantilla/areas/nueva?padre=${encodeURIComponent(padre)}`);
      expect(parent()).toHaveValue('');
      again.unmount();
    }
  });

  it('manages the responsibles: add with Enter or the button, remove, add yourself, and explain problems', async () => {
    await create();
    expect(screen.getByText('0 responsables de 20 como máximo')).toBeInTheDocument();
    type('Agregar responsable', 'user-dispatch');
    fireEvent.keyDown(getField('Agregar responsable'), { key: 'Enter' });
    expect(screen.getByText('user-dispatch')).toBeInTheDocument();
    expect(getField('Agregar responsable')).toHaveValue('');
    fireEvent.keyDown(getField('Agregar responsable'), { key: 'a' });
    // Enter never submits the whole form.
    expect(screen.getByRole('form', { name: 'Nueva área' })).toBeInTheDocument();
    addResponsible('user-dispatch');
    expect(screen.getByText('Esa persona ya es responsable.')).toBeInTheDocument();
    type('Agregar responsable', 'no válido');
    click('Agregar');
    expect(screen.getByText(/Usa letras, números, guion o guion bajo/)).toBeInTheDocument();
    type('Agregar responsable', '');
    click('Agregar');
    expect(screen.getByText('Escribe el identificador de la persona.')).toBeInTheDocument();
    type('Agregar responsable', 'x');
    expect(screen.queryByText('Escribe el identificador de la persona.')).toBeNull();
    click('Agregarme como responsable');
    expect(screen.getByText('user-admin')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agregarme como responsable' })).toBeNull();
    expect(screen.getByText('2 responsables de 20 como máximo')).toBeInTheDocument();
    click('Quitar a user-dispatch');
    expect(screen.queryByText('user-dispatch')).toBeNull();
  });

  it('refuses an identifier that was typed but never added', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'create');
    await create('/plantilla/areas/nueva', { api });
    type('Nombre', 'Oeste');
    type('Agregar responsable', 'user-dispatch');
    click('Crear área');
    expect(screen.getByText(/Escribiste un identificador sin agregarlo/)).toBeInTheDocument();
    expect(getField('Agregar responsable')).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks a repeated name next to the field and focuses it', async () => {
    await create();
    type('Nombre', 'norte');
    click('Crear área');
    expect(await screen.findByText(/Ya existe otra área con este nombre/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hay datos que ya existen' })).toBeInTheDocument();
    await waitFor(() => expect(getField('Nombre')).toHaveFocus());
  });

  it('marks a repeated code next to its field', async () => {
    await create();
    type('Nombre', 'Otra');
    type('Código', 'nte');
    click('Crear área');
    expect(await screen.findByText(/Ya existe un área con este código/)).toBeInTheDocument();
    await waitFor(() => expect(getField('Código')).toHaveFocus());
  });

  it('explains a placement the server refuses, and offers to reload the tree', async () => {
    const api = createMockApi();
    await create('/plantilla/areas/nueva?padre=area-norte-chih', { api });
    type('Nombre', 'Nueva');
    api.controls.deactivateAreaExternally('area-norte-chih');
    click('Crear área');
    expect(
      await screen.findByRole('heading', { name: 'Esa ubicación no es válida' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Elige otra área superior.')).toBeInTheDocument();
    await waitFor(() => expect(parent()).toHaveFocus());
    click('Cargar datos actuales');
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Esa ubicación no es válida' })).toBeNull(),
    );
    await screen.findByRole('form', { name: 'Nueva área' });
  });

  it('explains a responsible who is not an active member', async () => {
    await create();
    type('Nombre', 'Nueva');
    addResponsible('user-fantasma');
    click('Crear área');
    expect(
      await screen.findByRole('heading', { name: 'Responsables no válidos' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Alguno de los identificadores no corresponde a un miembro activo/),
    ).toBeInTheDocument();
    await waitFor(() => expect(getField('Agregar responsable')).toHaveFocus());
  });

  it.each([
    [403, 'No tienes permiso'],
    [500, 'No pudimos crear el área'],
  ] as const)('explains a %s answer and keeps what was typed', async (status, title) => {
    const api = createMockApi();
    await create('/plantilla/areas/nueva', { api });
    type('Nombre', 'Nueva');
    api.controls.failNext('createArea', status);
    click('Crear área');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(getField('Nombre')).toHaveValue('Nueva');
  });

  it('keeps what was typed when the session expires, and creates after signing in again', async () => {
    const { api } = await create();
    type('Nombre', 'Oeste');
    addResponsible('user-dispatch');
    api.controls.expireSession();
    click('Crear área');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.queryByRole('heading', { name: 'No pudimos crear el área' })).toBeNull();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    await waitFor(() => expect(getField('Nombre')).toHaveValue('Oeste'));
    expect(screen.getByText('user-dispatch')).toBeInTheDocument();
    click('Crear área');
    expect(await screen.findByRole('heading', { name: 'Oeste', level: 1 })).toBeInTheDocument();
  });

  it('cancels back to the tree and is not available without the create permission', async () => {
    const dispatch = await create('/plantilla/areas/nueva', { account: 'dispatch' });
    expect(screen.getByRole('link', { name: 'Cancelar' })).toHaveAttribute(
      'href',
      '/plantilla/areas',
    );
    dispatch.unmount();
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'list');
    await renderApp({ api, account: 'viewer', path: '/plantilla/areas/nueva' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows the load failures of the tree the form needs', async () => {
    const api = createMockApi();
    api.controls.failNext('listAreas', 500);
    await renderApp({ api, path: '/plantilla/areas/nueva' });
    await screen.findByRole('heading', { name: 'No pudimos cargar la información' });
    click('Reintentar');
    await screen.findByRole('form', { name: 'Nueva área' });
  });
});

const dd = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

async function edit(id = 'area-norte-mty', options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: `/plantilla/areas/${id}/editar`, ...options });
  await screen.findByRole('heading', { name: 'Editar área', level: 1 });
  await screen.findByRole('form', { name: 'Editar área' });
  return view;
}

describe('edit area', () => {
  it('opens with the loaded values, without the parent (that is "Mover")', async () => {
    await edit();
    expect(getField('Nombre')).toHaveValue('Monterrey');
    expect(getField('Código')).toHaveValue('NTE-MTY');
    expect(screen.getByText('user-admin')).toBeInTheDocument();
    expect(screen.queryByLabelText('Área superior')).toBeNull();
    expect(screen.getByRole('link', { name: 'Cancelar' })).toHaveAttribute(
      'href',
      '/plantilla/areas/area-norte-mty',
    );
  });

  it('says there is nothing to save when nothing changed', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'update');
    await edit('area-norte-mty', { api });
    click('Guardar cambios');
    expect(await screen.findByText('No hay cambios que guardar.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('saves only the changed fields against the loaded version and opens the detail', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'update');
    await edit('area-norte-mty', { api });
    type('Nombre', 'Monterrey Metropolitano');
    type('Código', '');
    click('Quitar a user-dispatch');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'Monterrey Metropolitano', level: 1 }),
    ).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('area-norte-mty', {
      version: 4,
      name: 'Monterrey Metropolitano',
      code: null,
      responsibleIds: ['user-admin'],
    });
    expect(screen.getByText('Cambios guardados.')).toBeInTheDocument();
    expect(dd('Código')).toHaveTextContent('Sin código');
  });

  it('marks a repeated name among siblings next to the field', async () => {
    await edit('area-norte-mty');
    type('Nombre', 'chihuahua');
    click('Guardar cambios');
    expect(await screen.findByText(/Ya existe otra área con este nombre/)).toBeInTheDocument();
  });

  it('tells the person someone else changed the area and offers the current data', async () => {
    const api = createMockApi();
    await edit('area-sur-mer', { api });
    api.controls.changeAreaExternally('area-sur-mer', { name: 'Mérida Norte' });
    type('Código', 'MER');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona modificó esta área' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Tus cambios no se guardaron/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert').closest('[tabindex="-1"]')).toHaveFocus());
    click('Cargar datos actuales');
    await waitFor(() => expect(getField('Nombre')).toHaveValue('Mérida Norte'));
    expect(getField('Código')).toHaveValue('SUR-MER');
  });

  it('explains that the area was deactivated while editing', async () => {
    const api = createMockApi();
    await edit('area-sur-mer', { api });
    api.controls.deactivateAreaExternally('area-sur-mer');
    type('Nombre', 'Otro');
    click('Guardar cambios');
    expect(
      await screen.findByRole('heading', { name: 'El área ya no admite cambios' }),
    ).toBeInTheDocument();
  });

  it('explains an inactive area instead of showing the form', async () => {
    await renderApp({ path: '/plantilla/areas/area-mty-guadalupe/editar' });
    await screen.findByRole('heading', { name: 'Esta área no se puede modificar' });
    expect(screen.getByRole('link', { name: 'Volver al área' })).toHaveAttribute(
      'href',
      '/plantilla/areas/area-mty-guadalupe',
    );
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('shows not-found for an unknown area, and a server error with retry', async () => {
    const view = await renderApp({ path: '/plantilla/areas/no-existe/editar' });
    await screen.findByRole('heading', { name: 'Área no encontrada' });
    view.unmount();
    const api = createMockApi();
    api.controls.failNext('getArea', 500);
    await renderApp({ api, path: '/plantilla/areas/area-sur/editar' });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('form', { name: 'Editar área' });
  });

  it('is not available without the edit permission', async () => {
    await renderApp({ account: 'viewer', path: '/plantilla/areas/area-sur/editar' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
  });

  it('keeps unsaved edits through an expired session when the area did not change meanwhile', async () => {
    const { api } = await edit('area-sur-mer');
    type('Nombre', 'Mérida Centro');
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    await waitFor(() => expect(getField('Nombre')).toHaveValue('Mérida Centro'));
    expect(screen.queryByText(/El área cambió desde que empezaste/)).toBeNull();
    click('Guardar cambios');
    await screen.findByText('Cambios guardados.');
    expect(api.controls.areas().find((a) => a.id === 'area-sur-mer')?.name).toBe('Mérida Centro');
  });

  it('drops unsaved edits after re-login if the area changed meanwhile, and says so', async () => {
    const { api } = await edit('area-sur-mer');
    type('Nombre', 'Mérida Centro');
    api.controls.expireSession();
    click('Guardar cambios');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    await api.auth.login(demoCredentials.admin);
    api.controls.changeAreaExternally('area-sur-mer', { name: 'Mérida Otra' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    expect(
      await screen.findByText(/El área cambió desde que empezaste a editar/),
    ).toBeInTheDocument();
    expect(getField('Nombre')).toHaveValue('Mérida Otra');
  });
});

async function move(id = 'area-norte-mty', options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: `/plantilla/areas/${id}/mover`, ...options });
  await screen.findByRole('heading', { name: 'Mover área', level: 1 });
  await screen.findByRole('form', { name: 'Mover área' });
  return view;
}

describe('move area', () => {
  it('shows only the parent, says how many sub-areas travel along and blocks impossible places', async () => {
    await move();
    expect(screen.queryByLabelText(/^Nombre/)).toBeNull();
    expect(screen.queryByText('Responsables', { selector: 'legend' })).toBeNull();
    expect(
      screen.getByText('Se moverán también sus 4 sub-áreas con la misma estructura.'),
    ).toBeInTheDocument();
    expect(parent()).toHaveValue('area-norte');
    const optionOf = (id: string) => [...parent().options].find((option) => option.value === id);
    expect(optionOf('area-norte-mty')).toBeDisabled();
    expect(optionOf('area-apodaca-taller')).toBeDisabled();
    expect(optionOf('area-sur-mer')).toBeDisabled();
    expect(optionOf('area-sur')).not.toBeDisabled();
  });

  it('says when nothing travels along', async () => {
    await move('area-sur-mer');
    expect(
      screen.getByText('Esta área no tiene sub-áreas: solo ella cambia de lugar.'),
    ).toBeInTheDocument();
  });

  it('moves the whole subtree and opens the detail with the new path and levels', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'update');
    await move('area-norte-mty', { api });
    fireEvent.change(parent(), { target: { value: 'area-sur' } });
    click('Mover área');
    expect(await screen.findByRole('heading', { name: 'Monterrey', level: 1 })).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('area-norte-mty', { version: 4, parentId: 'area-sur' });
    expect(screen.getByText('Área movida con todas sus sub-áreas.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Ruta del área' })).getByRole('link', {
        name: 'Sur',
      }),
    ).toBeInTheDocument();
    const depths = Object.fromEntries(api.controls.areas().map((area) => [area.id, area.depth]));
    expect(depths['area-mty-apodaca']).toBe(3);
    expect(depths['area-apodaca-taller']).toBe(4);
  });

  it('moves an area to the root level', async () => {
    const api = createMockApi();
    await move('area-norte-mty', { api });
    fireEvent.change(parent(), { target: { value: '' } });
    click('Mover área');
    await screen.findByText('Área movida con todas sus sub-áreas.');
    expect(dd('Área superior')).toHaveTextContent('Ninguna: es un área raíz');
  });

  it('says so when the area is already there', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'update');
    await move('area-norte-mty', { api });
    click('Mover área');
    expect(await screen.findByText('El área ya está en esa ubicación.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a destination the form already knows is unavailable', async () => {
    await move();
    fireEvent.change(parent(), { target: { value: 'area-mty-apodaca' } });
    click('Mover área');
    expect(
      screen.getByText(/Esa área no está disponible: esta área o una de sus sub-áreas/),
    ).toBeInTheDocument();
  });

  it('explains a destination the server refuses (it became inactive meanwhile)', async () => {
    const api = createMockApi();
    await move('area-norte-mty', { api });
    fireEvent.change(parent(), { target: { value: 'area-sur' } });
    api.controls.deactivateAreaExternally('area-sur');
    click('Mover área');
    expect(
      await screen.findByRole('heading', { name: 'Esa ubicación no es válida' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(parent()).toHaveFocus());
  });

  it('explains a sibling with the same name at the destination', async () => {
    const api = createMockApi();
    await move('area-norte-mty', { api });
    await api.areas.create({ name: 'Monterrey', parentId: 'area-sur' });
    fireEvent.change(parent(), { target: { value: 'area-sur' } });
    click('Mover área');
    expect(
      await screen.findByRole('heading', { name: 'Ya hay un área con ese nombre allí' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ya existe un área con este nombre dentro de esa área superior.'),
    ).toBeInTheDocument();
  });

  it('reports a version conflict and reloads on request', async () => {
    const api = createMockApi();
    await move('area-norte-mty', { api });
    api.controls.changeAreaExternally('area-norte-mty', { name: 'Monterrey 2' });
    fireEvent.change(parent(), { target: { value: 'area-sur' } });
    click('Mover área');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona modificó esta área' }),
    ).toBeInTheDocument();
    click('Cargar datos actuales');
    await screen.findByRole('form', { name: 'Mover área' });
    expect(parent()).toHaveValue('area-norte');
  });

  it('shows an inactive area as not movable, an unknown one as not found, and blocks read-only roles', async () => {
    const inactive = await renderApp({ path: '/plantilla/areas/area-mty-guadalupe/mover' });
    await screen.findByRole('heading', { name: 'Esta área no se puede modificar' });
    inactive.unmount();
    const missing = await renderApp({ path: '/plantilla/areas/no-existe/mover' });
    await screen.findByRole('heading', { name: 'Área no encontrada' });
    missing.unmount();
    await renderApp({ account: 'viewer', path: '/plantilla/areas/area-sur/mover' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
  });
});
