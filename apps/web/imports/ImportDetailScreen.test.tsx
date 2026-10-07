import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, fireEvent, renderApp, screen, waitFor } from '../app/test/utils';

const open = (id: string, options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: `/flota/importaciones/${id}`, ...options });

describe('import detail', () => {
  it('shows the summary, the per-row report without cell values and the history', async () => {
    await open('imp-001');
    await screen.findByRole('heading', { name: 'Importación de vehículos', level: 1 });
    expect(screen.getAllByText('Importada').length).toBeGreaterThan(0);
    expect(screen.getByText('Registros creados')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /^Filas \(/ });
    expect(table).toHaveTextContent('Falta un valor obligatorio');
    expect(table).toHaveTextContent('Placa');
    expect(table).not.toHaveTextContent(/ECO-|ABC-|@/);
    expect(await screen.findByText('Historial de la importación')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a importaciones' })).toHaveAttribute(
      'href',
      '/flota/importaciones',
    );
  });

  it('filters the report by outcome and pages it', async () => {
    await open('imp-001');
    await screen.findByRole('table', { name: /^Filas \(/ });
    fireEvent.change(screen.getByLabelText('Resultado'), { target: { value: 'skipped' } });
    expect(await screen.findByText('No hay filas con este resultado')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Resultado'), { target: { value: '' } });
    await screen.findByRole('table', { name: /^Filas \(/ });
    click('Cargar más filas');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cargar más filas' })).toBeNull(),
    );
  });

  it('explains a failed all-or-nothing job and a job still running', async () => {
    await open('imp-003');
    expect(await screen.findByText('No se importó nada')).toBeInTheDocument();
    expect(screen.getAllByText('Fallida').length).toBeGreaterThan(0);
  });

  it('can refresh a running job', async () => {
    const api = createMockApi();
    const running = api.controls.imports().find((job) => job.status === 'running');
    await open(running?.id ?? 'imp-006', { api });
    expect(await screen.findByText('Importación en curso')).toBeInTheDocument();
    click('Actualizar');
    expect(await screen.findByText('Importación en curso')).toBeInTheDocument();
  });

  it('shows the notice of the previous screen once and removes it from the address', async () => {
    await open('imp-001?aviso=repetida');
    expect(await screen.findByText(/ya se había procesado/)).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('ignores an unknown notice', async () => {
    await open('imp-001?aviso=otra');
    await screen.findByRole('heading', { name: 'Importación de vehículos', level: 1 });
    expect(screen.queryByText(/ya se había procesado/)).toBeNull();
  });

  it('uniformly says not found', async () => {
    await open('imp-nope');
    expect(await screen.findByText('Importación no encontrada')).toBeInTheDocument();
  });

  it('keeps what is loaded when a further page fails', async () => {
    const api = createMockApi();
    await open('imp-001', { api });
    await screen.findByRole('table', { name: /^Filas \(/ });
    api.controls.failNext('importRows');
    click('Cargar más filas');
    expect(await screen.findByText('No pudimos cargar más filas.')).toBeInTheDocument();
  });

  it('retries a failed load', async () => {
    const api = createMockApi();
    api.controls.failNext('getImport');
    await open('imp-001', { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('heading', { name: 'Importación de vehículos', level: 1 });
  });
});
