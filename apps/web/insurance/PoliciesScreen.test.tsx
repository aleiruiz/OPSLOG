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
import { demoPolicies, makePolicy } from './fixtures';

/** Exact label match: the status badges also carry "Estado: ..." accessible names. */
const exact = (label: string) => screen.getByLabelText(label);
const set = (label: string, value: string) => fireEvent.change(exact(label), { target: { value } });
const rowsOf = () => screen.getAllByRole('row').slice(1);
const list = (options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: '/flota/seguros', ...options });

describe('policy list', () => {
  it('shows the policies with labelled coverage and statuses, the period and the days, and no technical ids', async () => {
    await list();
    const table = await screen.findByRole('table', { name: 'Pólizas (28)' });
    expect(rowsOf()).toHaveLength(25);
    for (const label of ['Vigente', 'Por vencer', 'Vencida'])
      expect(table).toHaveTextContent(label);
    for (const label of ['Responsabilidad civil obligatoria', 'Daños a terceros', 'Todo riesgo'])
      expect(table).toHaveTextContent(label);
    expect(table).not.toHaveTextContent(/mandatory_liability|third_party|expiring|expired/);
    expect(rowsOf()[0]).toHaveTextContent('Venció hace 40 días');
    expect(table).toHaveTextContent('Vence hoy');
    // Policies that start later sort last, on the second page.
    click('Cargar más pólizas');
    await waitFor(() => expect(rowsOf()).toHaveLength(28));
    expect(table).toHaveTextContent('Aún no inicia');
    expect(screen.getAllByRole('link', { name: 'Aseguradora Demo Norte' })[0]).toHaveAttribute(
      'href',
      '/flota/seguros/pol-001',
    );
    expect(
      within(table).getAllByRole('link', { name: /^Vehículo ECO-\d+$/ }).length,
    ).toBeGreaterThan(0);
  });

  it('never shows a deductible amount in the list', async () => {
    await list();
    const table = await screen.findByRole('table');
    expect(table).not.toHaveTextContent(/1,?250,?000|12,500|15 %|MXN/);
  });

  it('names the vehicle by its economic number, or generically when the vehicles cannot be loaded', async () => {
    const api = createMockApi();
    api.controls.failNext('listVehicles');
    await list({ api });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('Vehículo').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Vehículo')).toBeNull();
  });

  it('is reached from the navigation under "Flota" and highlights it', async () => {
    await renderApp();
    const link = await screen.findByRole('link', { name: 'Seguros' });
    link.click();
    await screen.findByRole('heading', { name: 'Seguros', level: 1 });
    expect(screen.getByRole('link', { name: 'Seguros' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Seguros · Transportes Demo SA · OPSLOG');
  });

  it('loads further pages with the cursor and keeps them until a filter changes', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.insurance, 'list');
    await list({ api });
    await screen.findByRole('table');
    click('Cargar más pólizas');
    await waitFor(() => expect(rowsOf()).toHaveLength(28));
    expect(spy).toHaveBeenLastCalledWith({ limit: 25, cursor: 'mock:25' });
    expect(screen.queryByRole('button', { name: 'Cargar más pólizas' })).toBeNull();
    set('Estado', 'valid');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Pólizas \(\d+\)/ })).toBeInTheDocument(),
    );
    expect(spy).toHaveBeenLastCalledWith({ limit: 25, status: 'valid' });
  });

  it('filters by status, vehicle, coverage, covered day and archived, and clears the filters', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.insurance, 'list');
    await list({ api });
    await screen.findByRole('table', { name: 'Pólizas (28)' });
    await waitFor(() =>
      expect(within(exact('Vehículo')).getAllByRole('option').length).toBeGreaterThan(20),
    );
    set('Estado', 'valid');
    set('Vehículo', 'veh-001');
    set('Cobertura', 'comprehensive');
    set('Vigente a la fecha', '2026-10-06');
    set('Archivadas', 'true');
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith({
        limit: 25,
        status: 'valid',
        vehicleId: 'veh-001',
        coverageType: 'comprehensive',
        coversOn: '2026-10-06',
        includeArchived: 'true',
      }),
    );
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Pólizas (28)' });
    expect(exact('Estado')).toHaveValue('');
    expect(exact('Vigente a la fecha')).toHaveValue('');
  });

  it('lists the policies that cover a given day, both ends included', async () => {
    const seed = [
      makePolicy({ id: 'a', insurer: 'Cubre Uno', startsOn: '2026-10-06', endsOn: '2027-10-05' }),
      makePolicy({ id: 'b', insurer: 'Cubre Dos', startsOn: '2025-10-06', endsOn: '2026-10-06' }),
      makePolicy({ id: 'c', insurer: 'No Cubre', startsOn: '2026-10-07', endsOn: '2027-10-06' }),
    ];
    await list({ api: createMockApi({ policies: seed }) });
    await screen.findByRole('table', { name: 'Pólizas (3)' });
    set('Vigente a la fecha', '2026-10-06');
    const table = await screen.findByRole('table', { name: 'Pólizas (2)' });
    expect(table).toHaveTextContent('Cubre Uno');
    expect(table).toHaveTextContent('Cubre Dos');
    expect(table).not.toHaveTextContent('No Cubre');
  });

  it('does not query with a day outside the supported range and explains why', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.insurance, 'list');
    await list({ api });
    await screen.findByRole('table');
    set('Vigente a la fecha', '1900-01-01');
    expect(await screen.findByText(/El filtro no se aplica hasta entonces/)).toBeInTheDocument();
    expect(exact('Vigente a la fecha')).toHaveAttribute('aria-invalid', 'true');
    expect(spy.mock.calls.every((call) => call[0]?.coversOn === undefined)).toBe(true);
    set('Vigente a la fecha', '2026-10-06');
    await waitFor(() => expect(screen.queryByText(/El filtro no se aplica/)).toBeNull());
  });

  it('shows archived policies with a badge when asked, without edit or renew links', async () => {
    const seed = demoPolicies(3);
    seed[1] = { ...seed[1]!, archivedAt: '2026-09-30T10:00:00.000Z' };
    await list({ api: createMockApi({ policies: seed }) });
    await screen.findByRole('table', { name: 'Pólizas (2)' });
    set('Archivadas', 'true');
    const table = await screen.findByRole('table', { name: 'Pólizas (3)' });
    expect(within(table).getByLabelText('Estado: Archivada')).toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: 'Editar POL-2026-0002' })).toBeNull();
    expect(within(table).getByRole('link', { name: 'Editar POL-2026-0001' })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Renovar POL-2026-0001' })).toBeInTheDocument();
  });

  it('shows no results for filters that match nothing, and keeps Enter from submitting', async () => {
    await list({ api: createMockApi({ policies: [makePolicy()] }) });
    await screen.findByRole('table');
    set('Estado', 'expired');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    const form = screen.getByRole('search', { name: 'Filtros' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('invites to register the first policy, and says so differently to read-only roles', async () => {
    const admin = await list({ api: createMockApi({ policies: [] }) });
    expect(await screen.findByRole('heading', { name: 'Aún no hay pólizas' })).toBeInTheDocument();
    expect(screen.getByText(/Registra la primera póliza/)).toBeInTheDocument();
    admin.unmount();
    await list({ api: createMockApi({ policies: [] }), account: 'viewer' });
    expect(
      await screen.findByText('Cuando se registren pólizas aparecerán aquí.'),
    ).toBeInTheDocument();
  });

  it('offers create, edit and renew only to roles that hold those permissions', async () => {
    const admin = await list();
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Nueva póliza' })).toHaveAttribute(
      'href',
      '/flota/seguros/nueva',
    );
    expect(screen.getAllByRole('link', { name: /^Editar / }).length).toBeGreaterThan(0);
    admin.unmount();
    await list({ account: 'viewer' });
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'Nueva póliza' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^(Editar|Renovar) / })).toBeNull();
  });

  it('reports a recoverable error with retry, a 403 as no permission and a 401 as an expired session', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listPolicies');
    set('Estado', 'valid');
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('table');
    api.controls.failNext('listPolicies', 403);
    set('Estado', 'expiring');
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
    api.controls.expireSession();
    set('Estado', 'expired');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await screen.findByRole('table', { name: /Pólizas/ });
  });

  it('reports a failure when loading more, and expires the session on a 401', async () => {
    const { api } = await list();
    await screen.findByRole('table');
    api.controls.failNext('listPolicies');
    click('Cargar más pólizas');
    expect(await screen.findByText('No pudimos cargar más pólizas.')).toBeInTheDocument();
    api.controls.failNext('listPolicies', 401);
    click('Cargar más pólizas');
    await screen.findByRole('group', { name: 'Sesión expirada' });
  });

  it('ignores a further page that arrives after the filters changed', async () => {
    const api = createMockApi();
    const real = api.insurance.list;
    const gate = deferred();
    await list({ api });
    await screen.findByRole('table');
    api.insurance.list = async (query) => {
      if (query?.cursor) await gate.promise;
      return real(query);
    };
    click('Cargar más pólizas');
    set('Estado', 'expired');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Pólizas \(\d+\)/ })).toBeVisible(),
    );
    const filtered = rowsOf().length;
    await act(async () => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowsOf()).toHaveLength(filtered);
  });

  it('navigates from "Nueva póliza" like a link', async () => {
    await list();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('link', { name: 'Nueva póliza' }));
    await screen.findByRole('heading', { name: 'Nueva póliza', level: 1 });
    expect(window.location.pathname).toBe('/flota/seguros/nueva');
  });
});
