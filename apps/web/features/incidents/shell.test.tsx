import { cleanup } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import { fireEvent, renderApp, screen, within } from '../../app/test/utils';
import { violations } from './testing';

describe('incidents in the web shell', () => {
  it('adds "Siniestros" to the navigation and opens the list, a case and the wizard', async () => {
    const { container } = await renderApp({ path: '/' });
    const nav = await screen.findByRole('navigation');
    fireEvent.click(within(nav).getByRole('link', { name: 'Siniestros' }));
    expect(
      await screen.findByRole('heading', { name: 'Siniestros', level: 1 }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: '2 siniestros' });
    expect(await violations(container)).toEqual([]);
    fireEvent.click(within(table).getByRole('link', { name: 'SIN-2026-000002' }));
    expect(
      await screen.findByRole('heading', { name: 'SIN-2026-000002', level: 1 }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/incidents/inc-002');
    fireEvent.click(
      within(screen.getByRole('navigation')).getByRole('link', { name: 'Siniestros' }),
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Nuevo siniestro' }));
    expect(
      await screen.findByRole('heading', { name: 'Nuevo siniestro', level: 1 }),
    ).toBeInTheDocument();
  });

  it('opens a case on its own tab from a link and answers an unknown case neutrally', async () => {
    await renderApp({ path: '/incidents/inc-002/timeline' });
    await screen.findByRole('heading', { name: 'SIN-2026-000002', level: 1 });
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    cleanup();
    await renderApp({ path: '/incidents/otra-empresa-123' });
    expect(await screen.findByText('No encontramos este siniestro')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/otra-empresa-123/);
  });

  it('gives a role without incidents:view no menu entry and no screen, even by address', async () => {
    const api = createMockApi();
    await renderApp({ api, path: '/', account: 'viewer' });
    const nav = await screen.findByRole('navigation');
    expect(within(nav).queryByRole('link', { name: 'Siniestros' })).toBeNull();
    cleanup();
    for (const path of ['/incidents', '/incidents/inc-001', '/incidents/new']) {
      await renderApp({ api, path, account: 'viewer' });
      await screen.findByRole('heading', { name: 'No tienes acceso' });
      expect(screen.queryByRole('table')).toBeNull();
      cleanup();
    }
  });

  it('shows the list but no "Nuevo siniestro" to a fleet editor with generic grants plus incidents:view', async () => {
    await renderApp({ path: '/incidents', account: 'mechanic' });
    await screen.findByRole('table', { name: '2 siniestros' });
    expect(
      within(screen.getByRole('navigation')).getByRole('link', { name: 'Siniestros' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Nuevo siniestro' })).toBeNull();
    cleanup();
    await renderApp({ path: '/incidents/new', account: 'mechanic' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
  });

  it('lets a reporter start a case but not run the commands of an editor', async () => {
    await renderApp({ path: '/incidents', account: 'dispatch' });
    expect(await screen.findByRole('link', { name: 'Nuevo siniestro' })).toBeInTheDocument();
    await screen.findByRole('table');
    cleanup();
    await renderApp({ path: '/incidents/inc-002', account: 'dispatch' });
    await screen.findByRole('heading', { name: 'SIN-2026-000002', level: 1 });
    expect(await screen.findByText(/Solo puedes consultar este caso/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Asignar responsable' })).toBeNull();
  });

  it('answers a signed-out session with 401 and a role without incidents:view with 403', async () => {
    const api = createMockApi();
    expect(await api.incidents.list()).toMatchObject({ ok: false, error: { status: 401 } });
    expect(await api.incidents.thirdParties.list('inc-001')).toMatchObject({
      ok: false,
      error: { status: 401 },
    });
    await renderApp({ api, path: '/', account: 'viewer' });
    expect(await api.incidents.list()).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it('says so when the vehicles cannot be loaded and keeps the wizard usable', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles', 500);
    await renderApp({ api, path: '/incidents/new' });
    expect(
      await screen.findByText('No pudimos cargar los vehículos de tu empresa.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText(/Vehículo/)).toBeInTheDocument();
  });

  it('hands an expired session to the shell when the vehicles answer 401', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles', 401);
    await renderApp({ api, path: '/incidents/new' });
    expect(await screen.findByText(/Sesión expirada|expir/i)).toBeInTheDocument();
  });
});
