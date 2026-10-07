import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoSubjects } from '../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  renderApp,
  screen,
  type,
  waitFor,
  within,
} from '../app/test/utils';
import { makeDocument } from '../documents/fixtures';
import { makePolicy } from '../insurance/fixtures';

/** Exact label match: the status badges also carry "Estado: ..." accessible names. */
const exact = (label: string) => screen.getByLabelText(label);
const set = (label: string, value: string) => fireEvent.change(exact(label), { target: { value } });
const rowsOf = () => screen.getAllByRole('row').slice(1);
const list = (options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: '/flota/alertas', ...options });

describe('alert list', () => {
  it('shows what expires or has expired with labelled kinds, dates and days, and no technical ids', async () => {
    await list();
    const table = await screen.findByRole('table', { name: 'Alertas (34)' });
    expect(rowsOf()).toHaveLength(25);
    expect(rowsOf()[0]).toHaveTextContent('Venció hace 40 días');
    for (const label of ['Vencido', 'Por vencer', 'Vence hoy', 'Faltan 5 días'])
      expect(table).toHaveTextContent(label);
    for (const label of ['Documento de vehículo', 'Seguro', 'Tarjeta de circulación'])
      expect(table).toHaveTextContent(label);
    expect(table).not.toHaveTextContent(
      /vehicle_document|insurance_policy|registration_card|expiring|expired|comprehensive/,
    );
    expect(screen.getByText(/al 6 oct 2026/)).toHaveTextContent(
      'que vencen en los próximos 30 días o que ya vencieron',
    );
  });

  it('links each alert to its source record and to its vehicle', async () => {
    await list();
    const table = await screen.findByRole('table');
    expect(
      within(table).getAllByRole('link', { name: /^Ver documento de vehículo: / })[0],
    ).toHaveAttribute('href', '/flota/documentos/doc-001');
    expect(within(table).getAllByRole('link', { name: /^Ver seguro: / })[0]).toHaveAttribute(
      'href',
      '/flota/seguros/pol-001',
    );
    await waitFor(() =>
      expect(
        within(table).getAllByRole('link', { name: /^Vehículo ECO-\d+$/ }).length,
      ).toBeGreaterThan(0),
    );
  });

  it('names the vehicle generically when the vehicles cannot be loaded, and then offers no vehicle filter', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles');
    await list({ api });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('Vehículo').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Vehículo')).toBeNull();
  });

  it('is reached from the navigation under "Flota" and highlights it', async () => {
    await renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    within(nav).getByRole('link', { name: 'Alertas' }).click();
    await screen.findByRole('heading', { name: 'Alertas', level: 1 });
    expect(
      within(screen.getByRole('navigation', { name: 'Principal' })).getByRole('link', {
        name: 'Alertas',
      }),
    ).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Alertas · Transportes Demo SA · OPSLOG');
  });

  it('loads further pages with the cursor and keeps them until a filter changes', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.alerts, 'list');
    await list({ api });
    await screen.findByRole('table');
    click('Cargar más alertas');
    await waitFor(() => expect(rowsOf()).toHaveLength(34));
    expect(spy).toHaveBeenLastCalledWith({ limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más alertas' })).toBeNull();
    set('Estado', 'expired');
    await screen.findByRole('table', { name: 'Alertas (12)' });
    expect(spy).toHaveBeenLastCalledWith({ limit: 25, severity: 'expired' });
  });

  it('filters by origin, state and vehicle, and clears the filters', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.alerts, 'list');
    await list({ api });
    await screen.findByRole('table', { name: 'Alertas (34)' });
    await waitFor(() =>
      expect(within(exact('Vehículo')).getAllByRole('option').length).toBeGreaterThan(20),
    );
    set('Origen', 'insurance_policy');
    set('Estado', 'expiring');
    set('Vehículo', 'veh-001');
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith({
        limit: 25,
        source: 'insurance_policy',
        severity: 'expiring',
        vehicleId: 'veh-001',
      }),
    );
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Alertas (34)' });
    expect(exact('Origen')).toHaveValue('');
    expect(exact('Estado')).toHaveValue('');
    expect(exact('Vehículo')).toHaveValue('');
  });

  it('shows no results for filters that match nothing, and keeps Enter from submitting', async () => {
    await list({
      api: createMockApi({
        documents: [makeDocument({ expiresOn: '2026-10-10' })],
        policies: [],
      }),
    });
    await screen.findByRole('table');
    set('Estado', 'expired');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    const form = screen.getByRole('search', { name: 'Filtros' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('says nothing is pending when there are no alerts, with the company window', async () => {
    await list({
      api: createMockApi({
        documents: [makeDocument({ expiresOn: '2027-10-10' })],
        policies: [makePolicy({ endsOn: '2027-10-10' })],
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Sin vencimientos pendientes' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Ningún documento ni seguro vence en los próximos 30 días/),
    ).toBeInTheDocument();
  });

  it('uses the window the company saved, in the description and the empty state', async () => {
    const api = createMockApi({ documents: [], policies: [] });
    const { unmount } = await list({ api });
    await screen.findByRole('heading', { name: 'Sin vencimientos pendientes' });
    await api.alerts.saveSettings({ version: 0, expiryWindowDays: 1, recipientRoles: ['admin'] });
    unmount();
    await list({ api });
    expect((await screen.findAllByText(/en los próximos 1 día\b/)).length).toBe(2);
  });

  it('links to the settings from the header for every role, and from the navigation only for manage_config', async () => {
    const admin = await list();
    await screen.findByRole('table');
    const links = screen.getAllByRole('link', { name: 'Ajustes de alertas' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute('href', '/configuracion/alertas');
    admin.unmount();
    await list({ account: 'viewer' });
    await screen.findByRole('table');
    const only = screen.getByRole('link', { name: 'Ajustes de alertas' });
    expect(
      within(screen.getByRole('navigation', { name: 'Principal' })).queryByRole('link', {
        name: 'Ajustes de alertas',
      }),
    ).toBeNull();
    fireEvent.click(only);
    await screen.findByRole('heading', { name: 'Ajustes de alertas', level: 1 });
    expect(window.location.pathname).toBe('/configuracion/alertas');
  });

  it('reports a recoverable error with retry, a 403 as no permission and a 401 as an expired session', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listAlerts');
    set('Estado', 'expired');
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('table');
    api.controls.failNext('listAlerts', 403);
    set('Estado', 'expiring');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    api.controls.expireSession();
    set('Estado', 'expired');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('table', { name: /Alertas/ });
  });

  it('reports a failure when loading more, and expires the session on a 401', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listAlerts');
    click('Cargar más alertas');
    expect(await screen.findByText('No pudimos cargar más alertas.')).toBeInTheDocument();
    api.controls.failNext('listAlerts', 401);
    click('Cargar más alertas');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a further page that arrives after the filters changed', async () => {
    const api = createMockApi();
    const real = api.alerts.list;
    const gate = deferred();
    await list({ api });
    await screen.findByRole('table');
    api.alerts.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más alertas');
    set('Estado', 'expired');
    await screen.findByRole('table', { name: 'Alertas (12)' });
    const filtered = rowsOf().length;
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(filtered);
  });

  it('shows no alert details beyond ids, kinds and dates (no titles, numbers or insurers)', async () => {
    await list();
    const table = await screen.findByRole('table');
    expect(table).not.toHaveTextContent(/POL-2026|TC-2025|Aseguradora Demo|Seguros Demo/);
  });
});
