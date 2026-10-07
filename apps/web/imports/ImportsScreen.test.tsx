import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, fireEvent, renderApp, screen, waitFor, within } from '../app/test/utils';

const set = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const rowsOf = () => screen.getAllByRole('row').slice(1);
const list = (options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: '/flota/importaciones', ...options });

describe('import history', () => {
  it('lists the jobs with what, mode and state in words and pages with a cursor', async () => {
    await list();
    const table = await screen.findByRole('table', { name: 'Importaciones (28)' });
    expect(rowsOf()).toHaveLength(25);
    for (const text of ['Vehículos', 'Empleados', 'Importada', 'Validada', 'Fallida', 'En curso'])
      expect(table).toHaveTextContent(text);
    expect(table).not.toHaveTextContent(/commit_valid|dry_run|imported|failed/);
    expect(within(table).getAllByRole('link')[0]).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/flota\/importaciones\/imp-/),
    );
    click('Cargar más importaciones');
    await waitFor(() => expect(rowsOf()).toHaveLength(28));
    expect(screen.queryByRole('button', { name: 'Cargar más importaciones' })).toBeNull();
  });

  it('filters by what was imported and by state, and clears the filters', async () => {
    await list();
    await screen.findByRole('table');
    set('Qué se importó', 'employee');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /Importaciones \(\d\)/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('table')).not.toHaveTextContent('Vehículos');
    set('Estado', 'failed');
    expect(
      await screen.findByText(/No encontramos resultados|Sin resultados/i),
    ).toBeInTheDocument();
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Importaciones (28)' });
  });

  it('offers a new import only to those who can create', async () => {
    await list();
    expect(await screen.findByRole('link', { name: 'Nueva importación' })).toHaveAttribute(
      'href',
      '/flota/importaciones/nueva',
    );
    expect(screen.getByRole('link', { name: 'Importaciones' })).toBeInTheDocument();
  });

  it('hides it from a read-only role', async () => {
    await list({ account: 'viewer' });
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'Nueva importación' })).toBeNull();
  });

  it('explains an empty history according to the role', async () => {
    await list({ api: createMockApi({ imports: [] }) });
    expect(await screen.findByText('Aún no hay importaciones')).toBeInTheDocument();
    expect(screen.getByText(/Valida un archivo CSV para empezar/)).toBeInTheDocument();
  });

  it('says so to a read-only role with an empty history', async () => {
    await list({ api: createMockApi({ imports: [] }), account: 'viewer' });
    expect(await screen.findByText(/Cuando se importen archivos/)).toBeInTheDocument();
  });

  it('recovers from a failed load and keeps the list when a next page fails', async () => {
    const api = createMockApi();
    api.controls.failNext('listImports');
    await list({ api });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('table');
    api.controls.failNext('listImports');
    click('Cargar más importaciones');
    expect(await screen.findByText('No pudimos cargar más importaciones.')).toBeInTheDocument();
    expect(rowsOf()).toHaveLength(25);
  });

  it('opens the detail of a job', async () => {
    await list();
    const table = await screen.findByRole('table');
    fireEvent.click(within(table).getAllByRole('link')[0] as HTMLElement);
    await screen.findByRole('heading', { name: /^Importación de /, level: 1 });
  });
});
