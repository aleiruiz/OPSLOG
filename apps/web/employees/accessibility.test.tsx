import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, fireEvent, renderApp, screen, waitFor } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/employees.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('employee screens in jsdom', () => {
  it.each([
    ['list', '/plantilla/empleados', 'Empleados'],
    ['driver detail', '/plantilla/empleados/emp-001', 'Ana García López'],
    ['terminated detail', '/plantilla/empleados/emp-007', 'Elena Domínguez Paz'],
    ['edit form', '/plantilla/empleados/emp-001/editar', 'Editar empleado'],
    ['create form', '/plantilla/empleados/nuevo', 'Nuevo empleado'],
  ] as const)('has no detectable violations on the %s', async (_name, path, heading) => {
    const { container } = await renderApp({ path });
    await screen.findByRole('heading', { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations with the personal data revealed, and with it masked', async () => {
    const admin = await renderApp({ path: '/plantilla/empleados/emp-001' });
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    click('Mostrar datos personales');
    expect(await violations(admin.container)).toEqual([]);
    admin.unmount();
    const viewer = await renderApp({ path: '/plantilla/empleados/emp-001', account: 'viewer' });
    await screen.findByRole('heading', { name: 'Ana García López', level: 1 });
    expect(await violations(viewer.container)).toEqual([]);
  });

  it('has no detectable violations with field errors in the form', async () => {
    const form = await renderApp({ path: '/plantilla/empleados/nuevo' });
    await screen.findByRole('form', { name: 'Nuevo empleado' });
    click('Crear empleado');
    expect(await violations(form.container)).toEqual([]);
  });

  it('has no detectable violations with the status panel errors and both dialogs open', async () => {
    const api = createMockApi();
    const detail = await renderApp({ api, path: '/plantilla/empleados/emp-002' });
    await screen.findByRole('heading', { name: 'Luis Hernández Ruiz', level: 1 });
    click('Cambiar estado');
    fireEvent.click(screen.getAllByRole('button', { name: 'Cambiar estado' }).at(-1)!);
    expect(await violations(document.body)).toEqual([]);
    fireEvent.change(screen.getByLabelText(/^Nuevo estado/), { target: { value: 'terminated' } });
    fireEvent.change(screen.getByLabelText(/^Motivo/), { target: { value: 'Renuncia' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Cambiar estado' }).at(-1)!);
    await screen.findByRole('dialog');
    expect(await violations(document.body)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar', description: '' }));
    detail.unmount();

    await renderApp({ api, path: '/plantilla/empleados/emp-003' });
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    await screen.findByRole('dialog');
    expect(await violations(document.body)).toEqual([]);
  });
});
