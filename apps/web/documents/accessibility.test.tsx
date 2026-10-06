import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, renderApp, screen, waitFor } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/documents.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('documents screens in jsdom', () => {
  it.each([
    ['list', '/flota/documentos', 'Documentos'],
    ['detail', '/flota/documentos/doc-001', /^Tarjeta/],
    ['edit form', '/flota/documentos/doc-001/editar', 'Editar documento'],
    ['renew form', '/flota/documentos/doc-001/renovar', 'Renovar documento'],
    ['create form', '/flota/documentos/nuevo', 'Nuevo documento'],
  ] as const)('has no detectable violations on the %s', async (_name, path, heading) => {
    const { container } = await renderApp({ path });
    await screen.findByRole('heading', { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations with field errors showing', async () => {
    const form = await renderApp({ path: '/flota/documentos/nuevo' });
    await screen.findByRole('heading', { name: 'Nuevo documento', level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    click('Crear documento');
    expect(await violations(form.container)).toEqual([]);
  });

  it('has no detectable violations in the empty, not-found and forbidden states', async () => {
    const empty = await renderApp({
      api: createMockApi({ documents: [] }),
      path: '/flota/documentos',
    });
    await screen.findByRole('heading', { name: 'Aún no hay documentos' });
    expect(await violations(empty.container)).toEqual([]);
    empty.unmount();
    const missing = await renderApp({ path: '/flota/documentos/no-existe' });
    await screen.findByRole('heading', { name: 'Documento no encontrado' });
    expect(await violations(missing.container)).toEqual([]);
    missing.unmount();
    const viewer = await renderApp({ account: 'viewer', path: '/flota/documentos/nuevo' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(await violations(viewer.container)).toEqual([]);
  });
});
