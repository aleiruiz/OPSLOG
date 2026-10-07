import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { fireEvent, renderApp, screen } from '../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser: e2e/imports.spec.ts.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('imports accessibility', () => {
  it.each([
    ['history', '/flota/importaciones', () => screen.findByRole('table')],
    [
      'detail',
      '/flota/importaciones/imp-001',
      () => screen.findByRole('table', { name: /^Filas/ }),
    ],
    ['form', '/flota/importaciones/nueva', () => screen.findByRole('form')],
  ] as const)('has no violations in the %s', async (_name, path, wait) => {
    const view = await renderApp({ path });
    await wait();
    expect(await violations(view.container)).toEqual([]);
  });

  it('has no violations with a validation result', async () => {
    const view = await renderApp({ path: '/flota/importaciones/nueva' });
    await screen.findByRole('form');
    fireEvent.change(screen.getByLabelText(/^Contenido CSV/), {
      target: {
        value:
          'economicNumber,plate,make,model,year,areaId,odometerKm\nECO-Z1,ZZZ-100,Nissan,NP300,2022,area-norte,1\nECO-Z2,,Nissan,NP300,2022,area-norte,1',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validar archivo' }));
    await screen.findByRole('table', { name: /Filas con error/ });
    expect(await violations(view.container)).toEqual([]);
  });
});
