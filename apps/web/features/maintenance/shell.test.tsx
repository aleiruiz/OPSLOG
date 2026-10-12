import { act, cleanup } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('answers a signed-out mock session with 401', async () => {
    const api = createMockApi();
    for (const call of [
      () => api.maintenance.orders.list(),
      () => api.maintenance.plans.list(),
      () => api.maintenance.alerts.list(),
    ])
      expect(await call()).toMatchObject({ ok: false, error: { status: 401 } });
  });

  it('gives a role without view a 403 from every maintenance route and no access in the shell', async () => {
    const api = createMockApi();
    api.controls.setRolePermissions('role-viewer', []);
    const orders = vi.spyOn(api.maintenance.orders, 'list');
    const alerts = vi.spyOn(api.maintenance.alerts, 'list');
    await renderApp({ api, path: '/flota/mantenimiento', account: 'viewer' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(screen.queryByRole('link', { name: 'Mantenimiento' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(orders).not.toHaveBeenCalled();
    // The server answers the same way when the screen is bypassed.
    for (const call of [
      () => api.maintenance.orders.list(),
      () => api.maintenance.plans.list(),
      () => api.maintenance.alerts.list(),
      () => api.maintenance.mechanics.list(),
    ])
      expect(await call()).toMatchObject({ ok: false, error: { status: 403 } });
    // The alerts area needs `view` too, so the maintenance records are never requested.
    cleanup();
    await renderApp({ api, path: '/flota/alertas', account: 'viewer' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(alerts).toHaveBeenCalledTimes(1);
  });

  it('lets a view-only role read orders and cannot register them', async () => {
    await renderApp({ path: '/flota/mantenimiento', account: 'viewer' });
    expect(await screen.findByRole('table', { name: '3 órdenes' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Nueva orden correctiva' })).toBeNull(),
    );
  });

  it('opens an order at its own address and the browser back button returns to the list', async () => {
    await renderApp({ path: '/flota/mantenimiento' });
    fireEvent.click(await screen.findByRole('button', { name: 'Servicio de 10 000 km' }));
    expect(
      await screen.findByRole('heading', { name: 'Servicio de 10 000 km', level: 1 }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/flota/mantenimiento/ordenes/wo-003');
    // The entry "Mantenimiento" stays highlighted on the order's own route.
    expect(screen.getByRole('link', { name: 'Mantenimiento' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // People and vehicles by name, never by id.
    expect(document.body.textContent).not.toMatch(/veh-00\d|user-\w+|mec-00\d|ws-00\d/);
    act(() => window.history.back());
    expect(
      await screen.findByRole('heading', { name: 'Órdenes de mantenimiento' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/flota/mantenimiento');
    act(() => window.history.forward());
    expect(
      await screen.findByRole('heading', { name: 'Servicio de 10 000 km', level: 1 }),
    ).toBeInTheDocument();
  });

  it('opens straight on a linked order, answers an unknown one neutrally and keeps the section tabs', async () => {
    const { unmount } = await renderApp({ path: '/flota/mantenimiento/ordenes/wo-001' });
    expect(
      await screen.findByRole('heading', { name: 'Frenos rechinan', level: 1 }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a órdenes' }));
    expect(window.location.pathname).toBe('/flota/mantenimiento');
    expect(await screen.findByRole('table', { name: '3 órdenes' })).toBeInTheDocument();
    unmount();
    await renderApp({ path: '/flota/mantenimiento/ordenes/inexistente' });
    expect(await screen.findByText('No encontramos esta orden')).toBeInTheDocument();
  });

  it('shows the plan alerts with the odometer age on the plan detail', async () => {
    await renderApp({ path: '/flota/mantenimiento' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Planes' }));
    fireEvent.click(await screen.findByRole('button', { name: /^ECO-\d+/ }));
    const table = await screen.findByRole('table', { name: /^Alertas de ECO-\d+.* \(2\)$/ });
    expect(table).toHaveTextContent('Lectura del odómetro de hace 2 días');
  });

  it('offers the vehicles and members as pickers: the corrective form lists vehicles by name', async () => {
    await renderApp({ path: '/flota/mantenimiento' });
    fireEvent.click(await screen.findByRole('button', { name: 'Nueva orden correctiva' }));
    const form = await screen.findByRole('form', { name: 'Nueva orden correctiva' });
    const select = within(form).getByLabelText(/^Vehículo/) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(5));
    expect(select.options[1]?.textContent).toMatch(/^ECO-\d+ · /);
    expect(select.tagName).toBe('SELECT');
  });

  it('names every member of a large company when assigning, across all user pages', async () => {
    await renderApp({ path: '/flota/mantenimiento/ordenes/wo-002' });
    fireEvent.click(await screen.findByRole('button', { name: 'Asignar' }));
    const select = (await screen.findByLabelText('Persona responsable')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(20));
    const labels = [...select.options].map((option) => option.textContent ?? '');
    expect(labels[1]).toMatch(/\(tú\)$/);
    expect(labels.join('|')).not.toMatch(/user-/);
    expect(labels.filter((label) => /^Mecánico \d+$/.test(label)).length).toBeGreaterThanOrEqual(
      20,
    );
  });
});
