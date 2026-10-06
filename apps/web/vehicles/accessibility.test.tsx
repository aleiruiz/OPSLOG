import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, fireEvent, renderApp, screen, waitFor } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/vehicles.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('vehicle screens in jsdom', () => {
  it.each([
    ['list', '/flota/vehiculos', 'Vehículos'],
    ['detail', '/flota/vehiculos/veh-001', 'Vehículo ECO-001'],
    ['edit form', '/flota/vehiculos/veh-001/editar', 'Editar vehículo'],
    ['create form', '/flota/vehiculos/nuevo', 'Nuevo vehículo'],
  ] as const)('has no detectable violations on the %s', async (_name, path, heading) => {
    const { container } = await renderApp({ path });
    await screen.findByRole('heading', { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations with field errors, an alert and the archive dialog open', async () => {
    const form = await renderApp({ path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo vehículo', level: 1 });
    click('Crear vehículo');
    expect(await violations(form.container)).toEqual([]);
    form.unmount();

    const api = createMockApi();
    const detail = await renderApp({ api, path: '/flota/vehiculos/veh-001' });
    await screen.findByRole('heading', { name: 'Vehículo ECO-001', level: 1 });
    api.controls.changeVehicleExternally('veh-001', { odometerKm: 90000 });
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Archivar vehículo' }));
    await screen.findByText(/Otra persona modificó este vehículo/);
    expect(await violations(document.body)).toEqual([]);
    expect(dialog).toBeInTheDocument();
    detail.unmount();
  });

  it('has no detectable violations in the empty, no-results and forbidden states', async () => {
    const empty = await renderApp({
      api: createMockApi({ vehicles: [] }),
      path: '/flota/vehiculos',
    });
    await screen.findByRole('heading', { name: 'Aún no hay vehículos' });
    expect(await violations(empty.container)).toEqual([]);
    empty.unmount();
    const missing = await renderApp({ path: '/flota/vehiculos/no-existe' });
    await screen.findByRole('heading', { name: 'Vehículo no encontrado' });
    expect(await violations(missing.container)).toEqual([]);
    missing.unmount();
    const viewer = await renderApp({ account: 'viewer', path: '/flota/vehiculos/nuevo' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(await violations(viewer.container)).toEqual([]);
  });
});
