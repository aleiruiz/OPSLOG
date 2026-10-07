import { describe, expect, it } from 'vitest';
import { createMockApi } from '../app/mockApi';
import { click, renderApp, screen, waitFor } from '../app/test/utils';
import { closed, makeAssignment } from './fixtures';

const open = (id: string, options: Parameters<typeof renderApp>[0] = {}) =>
  renderApp({ path: `/flota/asignaciones/${id}`, ...options });

describe('assignment detail', () => {
  it('shows a current assignment with names, labels, history and the close action', async () => {
    await open('asg-001');
    await screen.findByRole('heading', { name: /^Asignación de ECO-001$/, level: 1 });
    await waitFor(() => expect(screen.getByText(/Conductor Ana García López/)).toBeInTheDocument());
    expect(screen.getByText('Vigente')).toBeInTheDocument();
    expect(screen.getByText('Ruta de reparto zona norte', { selector: 'dd' })).toBeInTheDocument();
    expect(await screen.findByText('Asignada')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cerrar asignación' })).toHaveAttribute(
      'href',
      '/flota/asignaciones/asg-001/cerrar',
    );
    expect(screen.getByRole('link', { name: 'Ver todas las asignaciones del vehículo' })).toHaveAttribute(
      'href',
      '/flota/asignaciones?vehiculo=veh-001',
    );
    expect(screen.getByRole('link', { name: 'Ver todas las asignaciones del conductor' })).toHaveAttribute(
      'href',
      '/flota/asignaciones?conductor=emp-001',
    );
  });

  it('shows a replaced assignment as read-only history with how and why it ended', async () => {
    await open('asg-005');
    expect(await screen.findByRole('heading', { name: 'Asignación cerrada' })).toBeInTheDocument();
    expect(screen.getByText('Reemplazada por un nuevo principal', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Cambio de conductor titular', { selector: 'dd' })).toBeInTheDocument();
    expect(await screen.findByText('Reemplazada')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Cerrar asignación' })).toBeNull();
  });

  it('hides the close action from roles without edit', async () => {
    await open('asg-001', { account: 'viewer' });
    await screen.findByRole('heading', { name: /^Asignación de/, level: 1 });
    expect(screen.queryByRole('link', { name: 'Cerrar asignación' })).toBeNull();
  });

  it('shows a confirmation once and removes it from the address bar', async () => {
    await renderApp({ path: '/flota/asignaciones/asg-001?aviso=creada' });
    expect(await screen.findByText('Asignación creada.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    await renderApp({ path: '/flota/asignaciones/asg-001?aviso=otro' });
  });

  it('answers an unknown id with a uniform not-found, and other failures with retry', async () => {
    const missing = await open('no-existe');
    expect(await screen.findByRole('heading', { name: 'Asignación no encontrada' })).toBeInTheDocument();
    missing.unmount();
    const api = createMockApi();
    api.controls.failNext('getAssignment');
    await open('asg-001', { api });
    await screen.findByRole('heading', { name: 'No pudimos cargar la información' });
    click('Reintentar');
    await screen.findByRole('heading', { name: /^Asignación de/, level: 1 });
  });

  it('pages the history, reports a failure and retries a failed history', async () => {
    const events = makeAssignment({ id: 'asg-x' });
    const api = createMockApi({ assignments: [events] });
    const real = api.assignments.history;
    let calls = 0;
    api.assignments.history = async (id, query) => {
      calls += 1;
      if (calls === 1) return { ok: false, error: { code: 'internal_error', status: 500, message: 'x', correlationId: 'c' } };
      const result = await real(id, query);
      return result.ok ? { ok: true, value: { ...result.value, nextCursor: query?.cursor ? null : 'mock:1' } } : result;
    };
    await open('asg-x', { api });
    await screen.findByRole('heading', { name: 'No pudimos cargar la información' });
    click('Reintentar');
    click(await screen.findByRole('button', { name: 'Cargar más historial' }).then((b) => b.textContent ?? ''));
  });

  it('closed seeds show the end data', async () => {
    await open('asg-x', { api: createMockApi({ assignments: [closed(makeAssignment({ id: 'asg-x' }))] }) });
    expect(await screen.findByText('Fin de la ruta', { selector: 'dd' })).toBeInTheDocument();
  });
});
