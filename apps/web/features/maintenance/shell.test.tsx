import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import { click, fireEvent, renderApp, screen, waitFor, within } from '../../app/test/utils';
import { violations } from './testing';

describe('maintenance in the web shell', () => {
  it('is reachable from the navigation and shows exact costs to a role with view_costs', async () => {
    const { container } = await renderApp({ path: '/' });
    const nav = await screen.findByRole('navigation');
    fireEvent.click(within(nav).getByRole('link', { name: 'Mantenimiento' }));
    expect(
      await screen.findByRole('heading', { name: 'Órdenes de mantenimiento' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: '3 órdenes' })).toBeInTheDocument();
    click('Servicio de 10 000 km');
    expect(await screen.findByText('Mano de obra: 1,250.00 MXN')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('hides every amount from a role without view_costs and gives the mechanic their own orders', async () => {
    const dispatch = await renderApp({ path: '/flota/mantenimiento', account: 'dispatch' });
    fireEvent.click(await screen.findByRole('button', { name: 'Servicio de 10 000 km' }));
    await screen.findByText('Filtro de aceite · 1');
    expect(dispatch.container.innerHTML).not.toMatch(/1,250|450|MXN/);
    dispatch.unmount();
    await renderApp({ path: '/flota/mantenimiento', account: 'mechanic' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Mis órdenes' }));
    expect(
      await screen.findByRole('heading', { name: 'Frenos rechinan', level: 2 }),
    ).toBeInTheDocument();
  });

  it('answers a signed-out mock session with 401 and a role without view with 403', async () => {
    const api = createMockApi();
    expect(await api.maintenance.orders.list()).toMatchObject({
      ok: false,
      error: { status: 401 },
    });
    await renderApp({ api, path: '/flota/mantenimiento', account: 'viewer' });
    expect(await screen.findByRole('table', { name: '3 órdenes' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Nueva orden correctiva' })).toBeNull(),
    );
  });
});
