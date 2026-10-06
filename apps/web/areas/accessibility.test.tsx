import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, fireEvent, renderApp, screen, waitFor } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/areas.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('area screens in jsdom', () => {
  it.each([
    ['tree', '/plantilla/areas', 'Áreas'],
    ['detail', '/plantilla/areas/area-norte-mty', 'Monterrey'],
    ['inactive detail', '/plantilla/areas/area-mty-guadalupe', 'Base Guadalupe'],
    ['edit form', '/plantilla/areas/area-norte-mty/editar', 'Editar área'],
    ['move form', '/plantilla/areas/area-norte-mty/mover', 'Mover área'],
    ['create form', '/plantilla/areas/nueva', 'Nueva área'],
  ] as const)('has no detectable violations on the %s', async (_name, path, heading) => {
    const { container } = await renderApp({ path });
    await screen.findByRole('heading', { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations in the fully expanded tree with inactive areas', async () => {
    const { container } = await renderApp({ path: '/plantilla/areas' });
    await screen.findByRole('tree');
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'true' } });
    await screen.findByText('13 áreas');
    click('Expandir todo');
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations with field errors, an alert and both dialogs open', async () => {
    const form = await renderApp({ path: '/plantilla/areas/nueva' });
    await screen.findByRole('form', { name: 'Nueva área' });
    click('Crear área');
    expect(await violations(form.container)).toEqual([]);
    form.unmount();

    const api = createMockApi();
    const detail = await renderApp({ api, path: '/plantilla/areas/area-norte' });
    await screen.findByRole('heading', { name: 'Norte', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Desactivar área' }));
    await screen.findByText(/todavía tiene sub-áreas activas/);
    expect(await violations(document.body)).toEqual([]);
    detail.unmount();

    const inactive = await renderApp({ api, path: '/plantilla/areas/area-mty-guadalupe' });
    await screen.findByRole('heading', { name: 'Base Guadalupe', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));
    await screen.findByRole('dialog');
    expect(await violations(document.body)).toEqual([]);
    inactive.unmount();
  });

  it('has no detectable violations in the empty, not-found and forbidden states', async () => {
    const empty = await renderApp({ api: createMockApi({ areas: [] }), path: '/plantilla/areas' });
    await screen.findByRole('heading', { name: 'Aún no hay áreas' });
    expect(await violations(empty.container)).toEqual([]);
    empty.unmount();
    const missing = await renderApp({ path: '/plantilla/areas/no-existe' });
    await screen.findByRole('heading', { name: 'Área no encontrada' });
    expect(await violations(missing.container)).toEqual([]);
    missing.unmount();
    const viewer = await renderApp({ account: 'viewer', path: '/plantilla/areas/nueva' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(await violations(viewer.container)).toEqual([]);
  });
});
