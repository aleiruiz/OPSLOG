import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, renderApp, screen, waitFor } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/assignments.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('assignment screens in jsdom', () => {
  it.each([
    ['list', '/flota/asignaciones', 'Asignaciones'],
    ['detail', '/flota/asignaciones/asg-001', 'Asignación de ECO-001'],
    ['closed detail', '/flota/asignaciones/asg-005', 'Asignación de ECO-001'],
    ['close form', '/flota/asignaciones/asg-001/cerrar', 'Cerrar asignación'],
    ['create form', '/flota/asignaciones/nueva', 'Nueva asignación'],
  ] as const)('has no detectable violations on the %s', async (_name, path, heading) => {
    const { container } = await renderApp({ path });
    await screen.findByRole('heading', { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations with field errors and a conflict showing', async () => {
    const form = await renderApp({ path: '/flota/asignaciones/nueva' });
    await screen.findByRole('heading', { name: 'Nueva asignación', level: 1 });
    await screen.findByRole('option', { name: /ECO-001/ });
    click('Crear asignación');
    expect(await violations(form.container)).toEqual([]);
  });

  it('has no detectable violations in the empty, not-found and forbidden states', async () => {
    const empty = await renderApp({ api: createMockApi({ assignments: [] }), path: '/flota/asignaciones' });
    await screen.findByRole('heading', { name: 'Aún no hay asignaciones' });
    expect(await violations(empty.container)).toEqual([]);
    empty.unmount();
    const missing = await renderApp({ path: '/flota/asignaciones/no-existe' });
    await screen.findByRole('heading', { name: 'Asignación no encontrada' });
    expect(await violations(missing.container)).toEqual([]);
    missing.unmount();
    const viewer = await renderApp({ account: 'viewer', path: '/flota/asignaciones/nueva' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(await violations(viewer.container)).toEqual([]);
  });
});
