import axe from 'axe-core';
import type { BffDashboardQuery } from '@opslog/contracts';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  renderApp,
  renderWithSession,
  screen,
  waitFor,
  within,
} from '../../app/test/utils';
import { DashboardScreen } from './DashboardScreen';
import { createFakeDashboard, type FakeDashboard } from './fakePorts';

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map((item) => item.id);
}

const withDashboard = (dashboard: FakeDashboard) => Object.assign(createMockApi(), { dashboard });
const widget = (title: string) => screen.findByRole('article', { name: title });
const hrefOf = (name: string | RegExp) =>
  (screen.getByRole('link', { name }) as HTMLAnchorElement).getAttribute('href');

describe('dashboard of Inicio', () => {
  it('shows every widget to a reader who may see all, with drill-down links, and is accessible', async () => {
    const { container } = await renderWithSession(<DashboardScreen />);
    const active = await widget('Vehículos activos');
    expect(within(active).getByText('40')).toBeInTheDocument();
    expect(hrefOf('Ver vehículos activos: Vehículos activos')).toBe(
      '/flota/vehiculos?status=active',
    );
    expect(hrefOf(/Ver siniestros abiertos/)).toMatch(/^\/incidents\?status=reported%2C/);
    expect(screen.getAllByRole('article')).toHaveLength(15);
    expect(
      screen.getByRole('heading', { name: /Situación de hoy, 06\/10\/2026/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cifras al 06\/10\/2026 06:00/)).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('marks what needs attention with words, not only color', async () => {
    await renderWithSession(<DashboardScreen />);
    const critical = await widget('Siniestros críticos');
    expect(within(critical).getByText('Atención inmediata')).toBeInTheDocument();
    expect(within(critical).getByText(/Los listados filtran por gravedad/)).toBeInTheDocument();
  });

  it('renders no incident or cost widget, nor a placeholder, for a reader without those permissions', async () => {
    const { container } = await renderWithSession(<DashboardScreen />, { account: 'viewer' });
    await widget('Vehículos activos');
    expect(screen.getAllByRole('article')).toHaveLength(10);
    expect(container.textContent).not.toMatch(/siniestro|costo|resolución/i);
    expect(screen.queryByRole('link', { name: /incidents/ })).toBeNull();
  });

  it('explains what to ask for when no widget is visible, without naming any', async () => {
    const api = withDashboard(createFakeDashboard({ can: () => false }));
    await renderWithSession(<DashboardScreen />, { api });
    expect(await screen.findByText('Todavía no tienes indicadores')).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('shows a useful empty state and «Sin datos» when the company has no records', async () => {
    const api = withDashboard(createFakeDashboard({ can: () => true, empty: true }));
    await renderWithSession(<DashboardScreen />, { api });
    expect(
      await screen.findByText('Aún no hay datos para calcular indicadores'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Registrar un vehículo' })).toHaveAttribute(
      'href',
      '/flota/vehiculos/nuevo',
    );
    const docs = await widget('Documentación vigente');
    expect(within(docs).getByText('Sin datos')).toBeInTheDocument();
    expect(within(docs).queryByText(/^0 %$|^100 %$/)).toBeNull();
  });

  it('offers a retry when the dashboard cannot load', async () => {
    const api = createMockApi();
    await renderWithSession(<DashboardScreen />, { api });
    await widget('Vehículos activos');
    api.controls.failNext('dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Hoy' }));
    expect(await screen.findByText(/No pudimos actualizar los indicadores/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Vehículos activos' })).toBeInTheDocument();
    click('Reintentar');
    await waitFor(() =>
      expect(screen.queryByText(/No pudimos actualizar los indicadores/)).toBeNull(),
    );
  });

  it('asks for the range of a shortcut in the company day and for the area it picks', async () => {
    const dashboard = createFakeDashboard({ can: () => true });
    await renderWithSession(<DashboardScreen />, { api: withDashboard(dashboard) });
    await widget('Vehículos activos');
    expect(dashboard.calls.at(-1)).toEqual({});
    click('7 días');
    await waitFor(() =>
      expect(dashboard.calls.at(-1)).toEqual({ from: '2026-09-30', to: '2026-10-06' }),
    );
    fireEvent.mouseDown(screen.getByLabelText('Área'));
    fireEvent.click(await screen.findByRole('option', { name: /Norte/ }));
    await waitFor(() =>
      expect(dashboard.calls.at(-1)).toEqual({
        areaId: 'area-norte',
        from: '2026-09-30',
        to: '2026-10-06',
      }),
    );
    expect(await screen.findByRole('article', { name: 'Vehículos activos' })).toBeInTheDocument();
    await waitFor(() =>
      expect(hrefOf('Ver vehículos activos: Vehículos activos')).toBe(
        '/flota/vehiculos?areaId=area-norte&status=active',
      ),
    );
  });

  it('validates a custom range before asking for it', async () => {
    const dashboard = createFakeDashboard({ can: () => true });
    await renderWithSession(<DashboardScreen />, { api: withDashboard(dashboard) });
    await widget('Vehículos activos');
    click('Personalizado');
    expect(screen.getByText('Indica la fecha inicial y la final.')).toBeInTheDocument();
    const before = dashboard.calls.length;
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-05' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-01' } });
    expect(screen.getByText(/no puede ser posterior/)).toBeInTheDocument();
    expect(dashboard.calls.length).toBe(before);
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-06' } });
    await waitFor(() =>
      expect(dashboard.calls.at(-1)).toEqual({ from: '2026-10-05', to: '2026-10-06' }),
    );
  });

  it('gives the charts a text equivalent', async () => {
    await renderWithSession(<DashboardScreen />);
    const availability = await widget('Disponibilidad de la flota');
    expect(
      within(availability).getByRole('img', { name: /Disponibilidad diaria\. Promedio/ }),
    ).toBeInTheDocument();
    expect(within(availability).getByText('Ver disponibilidad por día')).toBeInTheDocument();
    const monthly = await widget('Siniestros abiertos y cerrados');
    expect(
      within(monthly).getByRole('img', {
        name: /Siniestros por mes\. 12 reportados y 11 cerrados/,
      }),
    ).toBeInTheDocument();
    expect(within(monthly).getAllByText('Reportados')[0]).toBeInTheDocument();
  });

  it('is the home page, with the next step kept below the dashboard', async () => {
    await renderApp({ path: '/' });
    expect(await screen.findByRole('article', { name: 'Vehículos activos' })).toBeInTheDocument();
    const next = screen.getByRole('heading', { name: 'Siguiente paso' });
    const first = screen.getByRole('article', { name: 'Vehículos activos' });
    expect(first.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows «Toda la empresa» in the area select', async () => {
    await renderWithSession(<DashboardScreen />);
    await widget('Vehículos activos');
    expect(screen.getByLabelText('Área')).toHaveTextContent('Toda la empresa');
  });

  it('shows the area warning on lists that cannot filter by area', async () => {
    await renderWithSession(<DashboardScreen />);
    await widget('Vehículos activos');
    fireEvent.mouseDown(screen.getByLabelText('Área'));
    fireEvent.click(await screen.findByRole('option', { name: /Norte/ }));
    const docs = await screen.findByRole('article', { name: 'Documentos por vencer' });
    await waitFor(() =>
      expect(docs).toHaveTextContent('El listado no filtra por área; muestra toda la empresa.'),
    );
  });

  it('drops the answer of an older query that arrives late', async () => {
    const inner = createFakeDashboard({ can: () => true });
    const gate = deferred();
    const dashboard: FakeDashboard = {
      ...inner,
      get: (query) =>
        query?.from === '2026-09-30' ? gate.promise.then(() => inner.get(query)) : inner.get(query),
    };
    await renderWithSession(<DashboardScreen />, { api: withDashboard(dashboard) });
    await widget('Vehículos activos');
    click('7 días');
    click('Hoy');
    await screen.findByRole('heading', {
      name: /Indicadores del periodo, 06\/10\/2026 al 06\/10\/2026/,
    });
    gate.resolve();
    await gate.promise;
    await new Promise((done) => setTimeout(done, 0));
    expect(
      screen.getByRole('heading', {
        name: /Indicadores del periodo, 06\/10\/2026 al 06\/10\/2026/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /30\/09\/2026/ })).toBeNull();
  });

  it('shows the loading state again when retrying a failed first load', async () => {
    const base = createMockApi();
    const inner = base.dashboard;
    const gate = deferred();
    let calls = 0;
    const api = Object.assign(base, {
      dashboard: {
        get: (query?: BffDashboardQuery) => {
          calls += 1;
          return calls === 1 ? inner.get(query) : gate.promise.then(() => inner.get(query));
        },
      },
    });
    api.controls.failNext('dashboard');
    await renderWithSession(<DashboardScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Cargando');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    gate.resolve();
    await widget('Vehículos activos');
  });
});
