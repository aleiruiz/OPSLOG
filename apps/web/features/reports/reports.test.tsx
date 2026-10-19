import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  fireEvent,
  renderApp,
  renderWithSession,
  screen,
  waitFor,
  within,
} from '../../app/test/utils';
import { createFakeReports, type FakeReports } from './fakePorts';
import { ReportsScreen } from './ReportsScreen';

const BASE = '/analisis/reportes';
const withReports = (options: Parameters<typeof createFakeReports>[0] = {}) => {
  const reports = createFakeReports(options);
  return { reports, api: Object.assign(createMockApi(), { reports }) };
};
const at = (query = '') => window.history.replaceState(null, '', `${BASE}${query}`);
const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const previewTable = () => screen.findByRole('region', { name: /Tabla del reporte/ });
const lastCall = (reports: FakeReports, name: string) =>
  reports.calls.filter((call) => call.name === name).at(-1);

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map((item) => item.id);
}

describe('catalog', () => {
  it('groups the reports by family with a heading each and is accessible', async () => {
    const { api } = withReports();
    at();
    const { container } = await renderWithSession(<ReportsScreen />, { api });
    expect(await screen.findByRole('heading', { name: 'Plantilla', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vehículos', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir reporte: Conductores' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Abrir reporte: Inventario de vehículos' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Mis exportaciones' })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('opens a report into the address and goes back to the catalog', async () => {
    const { api } = withReports();
    at();
    await renderWithSession(<ReportsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir reporte: Conductores' }));
    await previewTable();
    expect(window.location.search).toBe('?reporte=drivers');
    click('Volver al catálogo');
    expect(await screen.findByRole('heading', { name: 'Plantilla' })).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('shows an empty state when the role has no reports and an error that can be retried', async () => {
    const { api, reports } = withReports();
    at();
    reports.failNext('catalog', 500);
    await renderWithSession(<ReportsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByRole('heading', { name: 'Plantilla' })).toBeInTheDocument();
  });
});

describe('report preview', () => {
  it('pages the preview 25 rows at a time and is accessible', async () => {
    const { api, reports } = withReports({ rowCount: 60 });
    at('?reporte=drivers');
    const { container } = await renderWithSession(<ReportsScreen />, { api });
    const table = await previewTable();
    expect(rows(table)).toHaveLength(25);
    expect(table).toHaveTextContent('Conductor 001');
    expect(screen.getByText('1–25 de 60')).toBeInTheDocument();
    click('Siguiente');
    await waitFor(() => expect(screen.getByText('26–50 de 60')).toBeInTheDocument());
    expect(lastCall(reports, 'preview')?.args[1]).toMatchObject({ offset: 25, limit: 25 });
    click('Siguiente');
    await waitFor(() => expect(screen.getByText('51–60 de 60')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    click('Anterior');
    await waitFor(() => expect(screen.getByText('26–50 de 60')).toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('lets the reader pick columns, keeps at least one and starts over from the first page', async () => {
    const { api, reports } = withReports({ rowCount: 60 });
    at('?reporte=drivers');
    await renderWithSession(<ReportsScreen />, { api });
    await previewTable();
    click('Siguiente');
    await waitFor(() => expect(screen.getByText('26–50 de 60')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Área' }));
    await waitFor(() => expect(screen.getByText('1–25 de 60')).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: 'Área' })).toBeNull();
    expect(lastCall(reports, 'preview')?.args[1]).toMatchObject({
      columns: 'name,status,licenseExpiresOn',
      offset: 0,
    });
    for (const name of ['Estatus', 'Vigencia de licencia'])
      fireEvent.click(screen.getByRole('checkbox', { name }));
    await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Nombre' })).toBeDisabled();
  });

  it('applies and clears filters', async () => {
    const { api, reports } = withReports({ rowCount: 8 });
    at('?reporte=vehicle_inventory');
    await renderWithSession(<ReportsScreen />, { api });
    await previewTable();
    fireEvent.change(screen.getByRole('textbox', { name: 'Placa' }), {
      target: { value: 'PLA-003' },
    });
    click('Aplicar filtros');
    await waitFor(() => expect(screen.getByText('1–1 de 1')).toBeInTheDocument());
    expect(lastCall(reports, 'preview')?.args[1]).toMatchObject({ plate: 'PLA-003', offset: 0 });
    click('Limpiar filtros');
    await waitFor(() => expect(screen.getByText('1–8 de 8')).toBeInTheDocument());
    expect(lastCall(reports, 'preview')?.args[1]).not.toHaveProperty('plate');
  });

  it('waits for a required filter before it loads the report or lets the reader export', async () => {
    const { api, reports } = withReports({ rowCount: 8 });
    at('?reporte=vehicle_sheet');
    await renderWithSession(<ReportsScreen />, { api });
    expect(await screen.findByText(/Indica los filtros obligatorios/)).toBeInTheDocument();
    expect(reports.calls.some((call) => call.name === 'preview')).toBe(false);
    expect(screen.getByRole('button', { name: 'Exportar' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /Vehículo/ }), {
      target: { value: 'ECO-001' },
    });
    click('Aplicar filtros');
    await previewTable();
    expect(lastCall(reports, 'preview')?.args[1]).toMatchObject({ vehicle: 'ECO-001' });
    expect(screen.getByRole('button', { name: 'Exportar' })).toBeEnabled();
  });

  it('sorts by another column and direction', async () => {
    const { api, reports } = withReports({ rowCount: 8 });
    at('?reporte=drivers');
    await renderWithSession(<ReportsScreen />, { api });
    await previewTable();
    fireEvent.change(screen.getByLabelText('Ordenar por'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('Orden'), { target: { value: 'desc' } });
    await waitFor(() =>
      expect(lastCall(reports, 'preview')?.args[1]).toMatchObject({
        sort: 'status',
        direction: 'desc',
      }),
    );
  });

  it('says so when nothing matches and offers a retry when the preview fails', async () => {
    const { api, reports } = withReports({ rowCount: 0 });
    at('?reporte=drivers');
    await renderWithSession(<ReportsScreen />, { api });
    expect(
      await screen.findByText('Ningún registro coincide con los filtros.'),
    ).toBeInTheDocument();
    reports.failNext('preview', 500);
    reports.rowCount = 3;
    fireEvent.change(screen.getByLabelText('Orden'), { target: { value: 'desc' } });
    fireEvent.click(await screen.findByRole('button', { name: /Reintentar/ }));
    expect(await previewTable()).toBeInTheDocument();
  });
});

describe('export', () => {
  it('exports directly with the columns on screen and offers the download', async () => {
    const { api, reports } = withReports({ rowCount: 60 });
    at('?reporte=drivers');
    await renderWithSession(<ReportsScreen />, { api });
    await previewTable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Área' }));
    fireEvent.change(screen.getByLabelText('Formato'), { target: { value: 'xlsx' } });
    click('Exportar');
    const link = await screen.findByRole('link', { name: 'Descargar archivo' });
    expect(link).toHaveAttribute('href', '/api/v1/exports/exp-1/download');
    expect(screen.getByText(/Tu archivo está listo \(60 filas\)/)).toBeInTheDocument();
    const [, body, key] = lastCall(reports, 'exportReport')?.args ?? [];
    expect(body).toMatchObject({
      format: 'xlsx',
      columns: ['name', 'status', 'licenseExpiresOn'],
      sort: 'name',
      direction: 'asc',
    });
    expect(key).toMatch(/^exp-[A-Za-z0-9_-]{8,}$/);
  });

  it('reuses the idempotency key while the request does not change', async () => {
    const { api, reports } = withReports({ rowCount: 60 });
    at('?reporte=drivers');
    await renderWithSession(<ReportsScreen />, { api });
    await previewTable();
    reports.failNext('exportReport', 500);
    click('Exportar');
    expect(
      await screen.findByText('No se pudo iniciar la exportación. Inténtalo de nuevo.'),
    ).toBeInTheDocument();
    click('Exportar');
    await screen.findByRole('link', { name: 'Descargar archivo' });
    const keys = reports.calls.filter((c) => c.name === 'exportReport').map((c) => c.args[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(reports.items).toHaveLength(1);
  });

  it('queues a large report and follows it in «Mis exportaciones» until it is ready', async () => {
    const { api, reports } = withReports({ rowCount: 60, directLimit: 10 });
    at('?reporte=vehicle_inventory');
    await renderWithSession(<ReportsScreen pollMs={0} />, { api });
    await previewTable();
    click('Exportar');
    expect(await screen.findByText(/se está preparando/)).toBeInTheDocument();
    click('Ver mis exportaciones');
    const table = await screen.findByRole('table', { name: 'Mis exportaciones (1)' });
    expect(table).toHaveTextContent('Inventario de vehículos');
    expect(table).toHaveTextContent('En cola');
    expect(within(table).queryByRole('link')).toBeNull();
    expect(screen.getByText(/Esta lista se actualiza sola/)).toBeInTheDocument();
    reports.finishJobs();
    click('Actualizar');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Mis exportaciones (1)' })).toHaveTextContent(
        'Listo',
      ),
    );
    expect(
      screen.getByRole('link', { name: /Descargar archivo: Inventario de vehículos, CSV/ }),
    ).toHaveAttribute('href', '/api/v1/exports/exp-1/download');
  });

  it('polls an open export by itself', async () => {
    const { api, reports } = withReports({ rowCount: 60, directLimit: 10 });
    at('?pestana=exportaciones');
    await renderWithSession(<ReportsScreen pollMs={20} />, { api });
    expect(await screen.findByText('Todavía no has exportado ningún reporte.')).toBeInTheDocument();
    await reports.exportReport('drivers', { format: 'csv' });
    click('Actualizar');
    await screen.findByText('En cola');
    reports.finishJobs();
    expect(await screen.findByText('Listo', {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('hides the export for a role without it and maps the refusals', async () => {
    const view = withReports({ canExport: false });
    at('?reporte=drivers');
    await renderWithSession(<ReportsScreen />, { api: view.api });
    await previewTable();
    expect(
      screen.getByText('Tu rol puede consultar este reporte, pero no exportarlo.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exportar' })).toBeNull();
  });

  it('explains a refusal for too many open exports and a revoked permission', async () => {
    const { api, reports } = withReports();
    at('?reporte=drivers');
    await renderWithSession(<ReportsScreen />, { api });
    await previewTable();
    reports.failNext('exportReport', 429);
    click('Exportar');
    expect(await screen.findByText(/demasiadas exportaciones en curso/)).toBeInTheDocument();
    reports.failNext('exportReport', 403);
    click('Exportar');
    expect(
      await screen.findByText('Tu rol puede consultar este reporte, pero no exportarlo.'),
    ).toBeInTheDocument();
  });
});

describe('exports list', () => {
  it('shows the failure reason of a failed export and pages the list', async () => {
    const { api, reports } = withReports({ rowCount: 5 });
    for (let i = 0; i < 30; i += 1) await reports.exportReport('drivers', { format: 'csv' });
    reports.items[0] = {
      ...(reports.items[0] as (typeof reports.items)[number]),
      status: 'failed',
      failure: 'permission_revoked',
      fileName: null,
    };
    at('?pestana=exportaciones');
    const { container } = await renderWithSession(<ReportsScreen pollMs={0} />, { api });
    const table = await screen.findByRole('table', { name: 'Mis exportaciones (30)' });
    expect(rows(table)).toHaveLength(25);
    expect(table).toHaveTextContent('Falló');
    expect(table).toHaveTextContent('Ya no tienes permiso para este reporte.');
    expect(screen.getByText('1–25 de 30')).toBeInTheDocument();
    click('Siguiente');
    await waitFor(() => expect(screen.getByText('26–30 de 30')).toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('marks expired exports without a download link', async () => {
    const { api, reports } = withReports({ rowCount: 5 });
    await reports.exportReport('drivers', { format: 'csv' });
    reports.items[0] = {
      ...(reports.items[0] as (typeof reports.items)[number]),
      status: 'expired',
    };
    at('?pestana=exportaciones');
    await renderWithSession(<ReportsScreen pollMs={0} />, { api });
    const table = await screen.findByRole('table', { name: 'Mis exportaciones (1)' });
    expect(table).toHaveTextContent('Vencido');
    expect(within(table).queryByRole('link')).toBeNull();
  });

  it('retries a failed list', async () => {
    const { api, reports } = withReports({ rowCount: 5 });
    await reports.exportReport('drivers', { format: 'csv' });
    reports.failNext('exports', 500);
    at('?pestana=exportaciones');
    await renderWithSession(<ReportsScreen pollMs={0} />, { api });
    fireEvent.click(await screen.findByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByRole('table', { name: 'Mis exportaciones (1)' })).toBeInTheDocument();
  });
});

describe('in the application', () => {
  it('is reachable from the navigation and keeps the reader out without view', async () => {
    await renderApp({ path: BASE });
    expect(await screen.findByRole('heading', { name: 'Plantilla' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Reportes' }).length).toBeGreaterThan(0);
  });
});
