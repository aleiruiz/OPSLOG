import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, renderApp, screen, waitFor } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/alerts.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('alert screens in jsdom', () => {
  it.each([
    ['list', '/flota/alertas', 'Alertas'],
    ['settings form', '/configuracion/alertas', 'Ajustes de alertas'],
  ] as const)('has no detectable violations on the %s', async (_name, path, heading) => {
    const { container } = await renderApp({ path });
    await screen.findByRole('heading', { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations on the home summary', async () => {
    const { container } = await renderApp({ path: '/' });
    await screen.findByText('12 vencidos');
    expect(await violations(container)).toEqual([]);
  });

  it('has no detectable violations with field errors showing', async () => {
    const form = await renderApp({ path: '/configuracion/alertas' });
    await screen.findByRole('form', { name: 'Ajustes de alertas' });
    click('Guardar ajustes');
    expect(await violations(form.container)).toEqual([]);
  });

  it('has no detectable violations read-only, empty or forbidden', async () => {
    const readOnly = await renderApp({ account: 'viewer', path: '/configuracion/alertas' });
    await screen.findByText(/Solo quien administra la configuración/);
    expect(await violations(readOnly.container)).toEqual([]);
    readOnly.unmount();
    const empty = await renderApp({
      api: createMockApi({ documents: [], policies: [] }),
      path: '/flota/alertas',
    });
    await screen.findByRole('heading', { name: 'Sin vencimientos pendientes' });
    expect(await violations(empty.container)).toEqual([]);
  });
});
