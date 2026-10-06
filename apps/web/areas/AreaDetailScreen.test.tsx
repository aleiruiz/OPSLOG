import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, type MockApi } from '../app/mockApi';
import { click, deferred, fireEvent, renderApp, screen, waitFor, within } from '../app/test/utils';
import { makeVehicle } from '../vehicles/fixtures';

async function open(id: string, options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: `/plantilla/areas/${id}`, ...options });
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
  return view;
}
const dd = (label: string) =>
  (screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement) ?? null;

describe('area detail: data', () => {
  it('shows the data, the path, responsibles, sub-areas and the history', async () => {
    await open('area-norte-mty');
    expect(screen.getByRole('heading', { name: 'Monterrey', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Código NTE-MTY')).toBeInTheDocument();
    const path = screen.getByRole('navigation', { name: 'Ruta del área' });
    expect(within(path).getByRole('link', { name: 'Norte' })).toHaveAttribute(
      'href',
      '/plantilla/areas/area-norte',
    );
    expect(dd('Nivel')).toHaveTextContent('2 de 4');
    expect(dd('Área superior')).toHaveTextContent('Norte');
    expect(dd('Estado')).toHaveTextContent('Activa');
    expect(dd('Responsables')).toHaveTextContent('user-adminuser-dispatch');
    expect(dd('Vehículos activos')).toHaveTextContent('0');
    expect(dd('Personas activas')).toHaveTextContent('0');
    const subAreas = screen.getByRole('table', { name: 'Sub-áreas (2)' });
    expect(within(subAreas).getByRole('link', { name: 'Base Apodaca' })).toBeInTheDocument();
    expect(within(subAreas).getByText('Inactiva')).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Línea de tiempo' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(4);
    expect(within(history).getByText(/Área creada dentro de «Norte»/)).toBeInTheDocument();
  });

  it('shows a root without a path or code, and a leaf without sub-areas or responsibles', async () => {
    const view = await open('area-sur');
    expect(screen.queryByRole('navigation', { name: 'Ruta del área' })).toBeNull();
    expect(dd('Área superior')).toHaveTextContent('Ninguna: es un área raíz');
    expect(dd('Responsables')).toHaveTextContent('Sin responsables');
    view.unmount();
    await open('area-centro-qro');
    expect(screen.getByText('Área sin código')).toBeInTheDocument();
    expect(dd('Código')).toHaveTextContent('Sin código');
    expect(screen.getByText('Esta área no tiene sub-áreas.')).toBeInTheDocument();
  });

  it('explains what blocks a deactivation using the counts of the area', async () => {
    const api = createMockApi({ vehicles: [makeVehicle({ areaId: 'area-sur-mer' })] });
    api.controls.setAreaPeople('area-sur-mer', 2);
    await open('area-sur-mer', { api });
    expect(dd('Vehículos activos')).toHaveTextContent('1');
    expect(screen.getByText(/1 vehículo activo, 2 personas activas/)).toBeInTheDocument();
    // Only people who can deactivate see the hint.
  });

  it('lists the active sub-areas as a blocker, and hides the hint from roles that cannot deactivate', async () => {
    const view = await open('area-norte');
    expect(screen.getByText(/2 sub-áreas activas/)).toBeInTheDocument();
    view.unmount();
    await open('area-norte', { account: 'dispatch' });
    expect(screen.queryByText(/Para desactivar esta área/)).toBeNull();
  });

  it('shows the not-found state for an unknown area, and an error with retry', async () => {
    const view = await renderApp({ path: '/plantilla/areas/no-existe' });
    await screen.findByRole('heading', { name: 'Área no encontrada' });
    expect(screen.getByRole('link', { name: 'Volver a áreas' })).toHaveAttribute(
      'href',
      '/plantilla/areas',
    );
    view.unmount();
    const api = createMockApi();
    api.controls.failNext('getArea', 500);
    await renderApp({ api, path: '/plantilla/areas/area-sur' });
    await screen.findByRole('heading', { name: 'No pudimos cargar la información' });
    click('Reintentar');
    await screen.findByRole('heading', { name: 'Sur', level: 1 });
  });

  it('shows the no-permission state and fails when the tree cannot be loaded', async () => {
    const api = createMockApi();
    api.controls.failNext('listAreas', 403);
    await renderApp({ api, path: '/plantilla/areas/area-sur' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
  });

  it('shows a one-time notice from the previous screen and removes it from the address', async () => {
    await renderApp({ path: '/plantilla/areas/area-sur?aviso=guardada' });
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.getByText('Cambios guardados.').closest('[tabindex="-1"]')).toHaveFocus();
  });

  it.each([
    ['creada', 'Área creada.'],
    ['movida', 'Área movida con todas sus sub-áreas.'],
  ])('knows the notice "%s"', async (code, text) => {
    await renderApp({ path: `/plantilla/areas/area-sur?aviso=${code}` });
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('ignores an unknown notice code', async () => {
    await renderApp({ path: '/plantilla/areas/area-centro-qro?aviso=constructor' });
    await screen.findByRole('heading', { name: 'Querétaro', level: 1 });
    expect(screen.queryByRole('region', { name: 'Notificaciones' })).toBeNull();
  });
});

describe('area detail: actions by permission', () => {
  it('offers every action to an administrator on an active area', async () => {
    await open('area-norte-mty');
    expect(screen.getByRole('link', { name: 'Editar' })).toHaveAttribute(
      'href',
      '/plantilla/areas/area-norte-mty/editar',
    );
    expect(screen.getByRole('link', { name: 'Mover' })).toHaveAttribute(
      'href',
      '/plantilla/areas/area-norte-mty/mover',
    );
    expect(screen.getByRole('link', { name: 'Nueva sub-área' })).toHaveAttribute(
      'href',
      '/plantilla/areas/nueva?padre=area-norte-mty',
    );
    expect(screen.getByRole('button', { name: 'Desactivar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activar' })).toBeNull();
  });

  it('does not offer sub-areas below the fourth level', async () => {
    await open('area-apodaca-taller');
    expect(screen.getByRole('link', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Nueva sub-área' })).toBeNull();
  });

  it('gives an editor everything except deactivating', async () => {
    await open('area-norte-mty', { account: 'dispatch' });
    expect(screen.getByRole('link', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mover' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nueva sub-área' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Desactivar' })).toBeNull();
  });

  it('gives a read-only role no actions at all', async () => {
    await open('area-norte-mty', { account: 'viewer' });
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Mover' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Nueva sub-área' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Desactivar|Activar/ })).toBeNull();
  });

  it('shows an inactive area as read-only, with only "Activar" for those who can edit', async () => {
    const view = await open('area-mty-guadalupe');
    expect(screen.getByRole('heading', { name: 'Área inactiva' })).toBeInTheDocument();
    expect(screen.getByText(/Es de solo lectura desde el/)).toBeInTheDocument();
    expect(dd('Desactivada')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activar' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Mover' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desactivar' })).toBeNull();
    view.unmount();
    await open('area-mty-guadalupe', { account: 'viewer' });
    expect(screen.queryByRole('button', { name: 'Activar' })).toBeNull();
  });

  it('warns when the structure is too large to show the whole path', async () => {
    const api = createMockApi();
    const list = api.areas.list;
    vi.spyOn(api.areas, 'list').mockImplementation(async (query) => {
      const result = await list(query);
      return result.ok ? { ok: true, value: { ...result.value, nextCursor: 'mock:0' } } : result;
    });
    await open('area-sur', { api });
    expect(screen.getByText(/La estructura es muy grande/)).toBeInTheDocument();
  });
});

describe('area detail: history', () => {
  it('loads further history on request and keeps what is already shown', async () => {
    const api = createMockApi();
    const history = vi.spyOn(api.areas, 'history');
    await open('area-norte', { api });
    const timeline = screen.getByRole('list', { name: 'Línea de tiempo' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(25);
    click('Cargar más historial');
    await waitFor(() => expect(within(timeline).getAllByRole('listitem')).toHaveLength(28));
    expect(history).toHaveBeenLastCalledWith('area-norte', { limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más historial' })).toBeNull();
  });

  it('reports a failed page without losing the shown ones, and retries', async () => {
    const api = createMockApi();
    await open('area-norte', { api });
    api.controls.failNext('areaHistory', 500);
    click('Cargar más historial');
    expect(await screen.findByText('No pudimos cargar más historial.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Línea de tiempo' })).getAllByRole('listitem'),
    ).toHaveLength(25);
    click('Cargar más historial');
    await waitFor(() => expect(screen.queryByText('No pudimos cargar más historial.')).toBeNull());
  });

  it('expires the session when a further page answers 401', async () => {
    const api = createMockApi();
    await open('area-norte', { api });
    api.controls.failNext('areaHistory', 401);
    click('Cargar más historial');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('shows the history section on its own when it fails, with a retry', async () => {
    const api = createMockApi();
    api.controls.failNext('areaHistory', 500);
    await renderApp({ api, path: '/plantilla/areas/area-sur' });
    await screen.findByRole('heading', { name: 'Sur', level: 1 });
    const section = await screen.findByRole('region', { name: 'Historial' });
    await within(section).findByRole('heading', { name: 'No pudimos cargar la información' });
    fireEvent.click(within(section).getByRole('button', { name: 'Reintentar' }));
    await within(section).findByRole('list', { name: 'Línea de tiempo' });
    expect(screen.getByRole('heading', { name: 'Sur', level: 1 })).toBeInTheDocument();
  });

  it('drops a further page that was requested before the history was reloaded', async () => {
    const api = createMockApi();
    await open('area-norte', { api });
    const gate = deferred();
    const history = api.areas.history;
    vi.spyOn(api.areas, 'history').mockImplementationOnce(async (id, query) => {
      await gate.promise;
      return history(id, query);
    });
    click('Cargar más historial');
    // "Recargar datos" in a failed dialog reloads the first page: the pending one belongs to an older list.
    fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desactivar el área Norte' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Recargar datos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const timeline = await screen.findByRole('list', { name: 'Línea de tiempo' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(25);
  });
});

const confirmDialog = async (title: string) => screen.findByRole('dialog', { name: title });
const openDeactivate = async (api: MockApi, id: string, title: string) => {
  await open(id, { api });
  fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
  return confirmDialog(title);
};

describe('area detail: deactivate', () => {
  it('asks for confirmation, can be cancelled and closed with Escape', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.areas, 'deactivate');
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    expect(dialog).toHaveAccessibleDescription(/solo lectura/);
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    fireEvent.keyDown(await confirmDialog('Desactivar el área Mérida'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
  });

  it('deactivates, announces the result in a focused notice and swaps the actions', async () => {
    const api = createMockApi();
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    expect(await screen.findByText('Área desactivada.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Área desactivada.').closest('[tabindex="-1"]')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Activar' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Área inactiva' })).toBeInTheDocument();
    expect(api.controls.areas().find((area) => area.id === 'area-sur-mer')?.active).toBe(false);
    // The history was refreshed with the new entry.
    await waitFor(() => expect(screen.getByText('Área desactivada')).toBeInTheDocument());
    // The resource counts survive the swap.
    expect(dd('Vehículos activos')).toHaveTextContent('0');
  });

  it('shows the busy state while the request is running and cannot be dismissed', async () => {
    const api = createMockApi();
    const gate = deferred();
    const deactivate = api.areas.deactivate;
    vi.spyOn(api.areas, 'deactivate').mockImplementation(async (id, version) => {
      await gate.promise;
      return deactivate(id, version);
    });
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    expect(await within(dialog).findByRole('button', { name: 'Cargando…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    act(() => gate.resolve());
    await screen.findByText('Área desactivada.');
  });

  it('names sub-areas as the blocker and keeps the dialog open with a way to reload', async () => {
    const api = createMockApi();
    const dialog = await openDeactivate(api, 'area-norte', 'Desactivar el área Norte');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No se puede desactivar: esta área todavía tiene sub-áreas activas.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recargar datos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByRole('heading', { name: 'Norte', level: 1 });
  });

  it('names vehicles as the blocker', async () => {
    const api = createMockApi({ vehicles: [makeVehicle({ areaId: 'area-sur-mer' })] });
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /vehículos activos asignados/,
    );
  });

  it('names people as the blocker even when they were assigned after the page loaded', async () => {
    const api = createMockApi();
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    api.controls.setAreaPeople('area-sur-mer', 3);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /personas activas asignadas/,
    );
  });

  it('reports a version conflict and reloads the current data on request', async () => {
    const api = createMockApi();
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    api.controls.changeAreaExternally('area-sur-mer', { name: 'Mérida y Cancún' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Otra persona modificó esta área',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recargar datos' }));
    await screen.findByRole('heading', { name: 'Mérida y Cancún', level: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    [403, /No tienes permiso para desactivar/],
    [404, /ya no existe/],
    [500, /No pudimos desactivar el área/],
  ] as const)('explains a %s answer inside the dialog', async (status, message) => {
    const api = createMockApi();
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    api.controls.failNext('deactivateArea', status);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
  });

  it('closes the dialog and locks the screen when the session expires', async () => {
    const api = createMockApi();
    const dialog = await openDeactivate(api, 'area-sur-mer', 'Desactivar el área Mérida');
    api.controls.expireSession();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar área' }));
    await screen.findByRole('group', { name: 'Sesión expirada' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('area detail: activate', () => {
  it('activates an inactive area with a confirmation that is not styled as destructive', async () => {
    const api = createMockApi();
    await open('area-mty-guadalupe', { api });
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));
    const dialog = await confirmDialog('Activar el área Base Guadalupe');
    expect(within(dialog).getByRole('button', { name: 'Activar área' }).className).toMatch(
      /colorPrimary/,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activar área' }));
    expect(await screen.findByText('Área activada.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desactivar' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Área inactiva' })).toBeNull();
    // The sub-area table of the parent is not affected; this area is back in the tree.
    expect(api.controls.areas().find((area) => area.id === 'area-mty-guadalupe')?.active).toBe(
      true,
    );
  });

  it('explains that the parent must be active first (422 invalid_hierarchy)', async () => {
    const api = createMockApi();
    await open('area-mty-guadalupe', { api });
    api.controls.deactivateAreaExternally('area-norte-mty');
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));
    const dialog = await confirmDialog('Activar el área Base Guadalupe');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No se puede activar: el área superior está inactiva.',
    );
  });

  it('reports a version conflict when activating', async () => {
    const api = createMockApi();
    await open('area-mty-guadalupe', { api });
    api.controls.changeAreaExternally('area-mty-guadalupe', { name: 'Base Guadalupe II' });
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));
    const dialog = await confirmDialog('Activar el área Base Guadalupe');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Otra persona modificó esta área',
    );
  });

  it('is refused for an administrator-less role by the server even if the button were reached (403)', async () => {
    const api = createMockApi();
    await open('area-mty-guadalupe', { api });
    api.controls.failNext('activateArea', 403);
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));
    const dialog = await confirmDialog('Activar el área Base Guadalupe');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activar área' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /No tienes permiso para activar/,
    );
  });
});
