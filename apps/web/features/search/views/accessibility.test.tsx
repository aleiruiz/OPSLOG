import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi, demoCredentials } from '../../../app/mockApi';
import { fireEvent, renderApp, screen, waitFor } from '../../../app/test/utils';

// Rules that need layout (colour contrast) run in a real browser.
async function violations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

describe('saved views and columns in jsdom', () => {
  it.each([
    ['vehicles', '/flota/vehiculos?status=active&yearFrom=2020', 'Vehículos'],
    ['employees', '/plantilla/empleados?hiredFrom=2022-01-01', 'Empleados'],
    ['documents', '/flota/documentos?expiresTo=2027-01-01', 'Documentos'],
    ['insurance', '/flota/seguros?endsTo=2027-01-01', 'Seguros'],
    ['maintenance', '/flota/mantenimiento?overdue=true', 'Órdenes de mantenimiento'],
    ['incidents', '/incidents?occurredFrom=2026-10-01&sort=-folio', 'Siniestros'],
  ] as const)(
    'has no detectable violations on the %s list with the views bar and the column picker open',
    async (_name, path, heading) => {
      const { container } = await renderApp({ path });
      await screen.findByRole('heading', { name: heading, level: 1 });
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cargando' })).toBeNull());
      await waitFor(() => expect(screen.getByLabelText('Vista guardada')).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: 'Columnas' }));
      fireEvent.click(screen.getByRole('button', { name: 'Guardar vista' }));
      await screen.findByLabelText('Nombre de la vista');
      expect(await violations(container)).toEqual([]);
    },
  );

  it('has no detectable violations with a notice of left-out filters, a form error and the delete dialog', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    await api.views.create({
      module: 'vehicles',
      name: 'Con filtro viejo',
      filters: { status: 'active', ghost: '1' },
    });
    const view = await renderApp({ api, path: '/flota/vehiculos' });
    await screen.findByRole('table');
    const select = await screen.findByLabelText('Vista guardada');
    await waitFor(() => expect(select).toContainHTML('Con filtro viejo'));
    fireEvent.change(select, { target: { value: 'view-1' } });
    await screen.findByText(/Se omitió lo que no puedes usar/);
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar vista' }));
    await screen.findByRole('dialog');
    expect(await violations(document.body)).toEqual([]);
    view.unmount();
  });
});
