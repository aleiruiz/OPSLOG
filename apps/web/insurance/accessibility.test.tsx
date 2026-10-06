import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, renderApp, screen, waitFor } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/insurance.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('insurance screens in jsdom', () => {
  it.each([
    ['list', '/flota/seguros', 'Seguros'],
    ['detail', '/flota/seguros/pol-001', 'Póliza POL-2026-0001'],
    ['edit form', '/flota/seguros/pol-001/editar', 'Editar póliza'],
    ['renew form', '/flota/seguros/pol-002/renovar', 'Renovar póliza'],
    ['create form', '/flota/seguros/nueva', 'Nueva póliza'],
  ] as const)('has no detectable violations on the %s', async (_name, path, heading) => {
    const { container } = await renderApp({ path });
    await screen.findByRole('heading', { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations with field errors showing', async () => {
    const form = await renderApp({ path: '/flota/seguros/nueva' });
    await screen.findByRole('heading', { name: 'Nueva póliza', level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    click('Crear póliza');
    expect(await violations(form.container)).toEqual([]);
  });

  it('has no detectable violations in the empty, not-found and forbidden states', async () => {
    const empty = await renderApp({ api: createMockApi({ policies: [] }), path: '/flota/seguros' });
    await screen.findByRole('heading', { name: 'Aún no hay pólizas' });
    expect(await violations(empty.container)).toEqual([]);
    empty.unmount();
    const missing = await renderApp({ path: '/flota/seguros/no-existe' });
    await screen.findByRole('heading', { name: 'Póliza no encontrada' });
    expect(await violations(missing.container)).toEqual([]);
    missing.unmount();
    const viewer = await renderApp({ account: 'viewer', path: '/flota/seguros/nueva' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(await violations(viewer.container)).toEqual([]);
  });
});
