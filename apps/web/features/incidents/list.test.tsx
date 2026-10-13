import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { baseIncident, completeEvent } from './fakePorts';
import { IncidentListScreen } from './IncidentListScreen';
import { ADMIN, FLEET_EDITOR, REPORTER, VIEWER, renderIncident, violations } from './testing';

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const many = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    completeEvent({
      id: `inc-${index + 1}`,
      folio: `SIN-2026-${String(index + 1).padStart(6, '0')}`,
      status: index % 2 === 0 ? 'reported' : 'draft',
      severity: index === 0 ? 'critical' : 'low',
      updatedAt: '2026-10-10T12:00:00.000Z',
    }),
  );

describe('case list', () => {
  it('lists cases by folio, vehicle and name, with status as text and no technical ids', async () => {
    const { container } = renderIncident(<IncidentListScreen />, {
      options: { incidents: [many(1)[0] as never] },
    });
    const table = await screen.findByRole('table', { name: '1 siniestros' });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByRole('link', { name: 'SIN-2026-000001' })).toHaveAttribute(
      'href',
      '/incidents/inc-1',
    );
    expect(row).toHaveTextContent('12/10/2026 09:30');
    expect(row).toHaveTextContent('ECO-001 · ABC-123');
    expect(row).toHaveTextContent('Ana Pérez');
    expect(row).toHaveTextContent('Sin asignar');
    expect(row).toHaveTextContent('Colisión');
    expect(row).toHaveTextContent('Reportado');
    expect(row).toHaveTextContent('Crítica');
    expect(screen.getByRole('region', { name: 'Tabla de siniestros' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(document.body.textContent).not.toMatch(/inc-1\b|veh-001|emp-001/);
    expect(await violations(container)).toEqual([]);
  });

  it('applies quick filters to the query and to the address, and clears them', async () => {
    const { fake } = renderIncident(<IncidentListScreen />, {
      options: { incidents: many(4) },
    });
    await screen.findByRole('table');
    press('Mis borradores');
    await waitFor(() => expect(window.location.search).toBe('?status=draft&createdBy=me'));
    await waitFor(() =>
      expect(screen.getByRole('table', { name: '2 siniestros' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Mis borradores' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    press('Mis borradores');
    await waitFor(() => expect(window.location.search).toBe(''));
    press('Críticos');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: '1 siniestros' })).toBeInTheDocument(),
    );
    press('Abiertos');
    await waitFor(() => expect(window.location.search).toContain('status='));
    press('Mis casos');
    await waitFor(() => expect(window.location.search).toContain('responsible=me'));
    expect(await screen.findByText('Sin resultados')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Limpiar filtros' })[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole('table', { name: '4 siniestros' })).toBeInTheDocument(),
    );
    expect(fake.calls.filter((call) => call === 'list').length).toBeGreaterThan(4);
  });

  it('filters by state, type and severity with labelled selects, and restores them from a link', async () => {
    const { fake } = renderIncident(<IncidentListScreen />, {
      path: '/incidents?status=draft&severity=low&type=collision&limit=50',
      options: { incidents: many(4) },
    });
    await screen.findByRole('table');
    const list = vi.spyOn(fake.ports, 'list');
    expect(screen.getByLabelText('Estado')).toHaveValue('draft');
    expect(screen.getByLabelText('Gravedad')).toHaveValue('low');
    expect(screen.getByLabelText('Tipo')).toHaveValue('collision');
    expect(screen.getByLabelText('Casos por página')).toHaveValue('50');
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'reported' } });
    await waitFor(() => expect(window.location.search).toContain('status=reported'));
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'rollover' } });
    fireEvent.change(screen.getByLabelText('Gravedad'), { target: { value: 'critical' } });
    fireEvent.change(screen.getByLabelText('Casos por página'), { target: { value: '100' } });
    await waitFor(() => expect(window.location.search).toContain('limit=100'));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'reported',
          type: 'rollover',
          severity: 'critical',
          limit: 100,
        }),
      ),
    );
  });

  it('names a combined state filter instead of showing a list of ids', async () => {
    renderIncident(<IncidentListScreen />, {
      path: '/incidents?status=draft,reported',
      options: { incidents: many(2) },
    });
    await screen.findByRole('table');
    expect(screen.getByLabelText('Estado')).toHaveTextContent('Varios estados');
  });

  it('loads more with the server cursor and starts over when a filter changes', async () => {
    renderIncident(<IncidentListScreen />, { options: { incidents: many(30) } });
    await screen.findByRole('table', { name: '25 siniestros' });
    press('Cargar más');
    await screen.findByRole('table', { name: '30 siniestros' });
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
    press('Críticos');
    await screen.findByRole('table', { name: '1 siniestros' });
  });

  it('keeps the rows when loading more fails and says so', async () => {
    const { fake } = renderIncident(<IncidentListScreen />, { options: { incidents: many(30) } });
    await screen.findByRole('table', { name: '25 siniestros' });
    fake.failNext('list', 500);
    press('Cargar más');
    expect(
      await screen.findByText('No pudimos cargar más casos. Intenta de nuevo.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '25 siniestros' })).toBeInTheDocument();
    press('Cargar más');
    await screen.findByRole('table', { name: '30 siniestros' });
  });

  it('offers "Nuevo siniestro" only to who may create or report', async () => {
    const first = renderIncident(<IncidentListScreen />, { permissions: ADMIN });
    expect(await screen.findByRole('link', { name: 'Nuevo siniestro' })).toHaveAttribute(
      'href',
      '/incidents/new',
    );
    first.unmount();
    const reporter = renderIncident(<IncidentListScreen />, { permissions: REPORTER });
    expect(await screen.findByRole('link', { name: 'Nuevo siniestro' })).toBeInTheDocument();
    reporter.unmount();
    for (const permissions of [FLEET_EDITOR, VIEWER]) {
      const view = renderIncident(<IncidentListScreen />, { permissions });
      await screen.findByText('Aún no hay siniestros');
      expect(screen.queryByRole('link', { name: 'Nuevo siniestro' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Nuevo siniestro' })).toBeNull();
      view.unmount();
    }
  });

  it('shows the empty state with its call to action', async () => {
    renderIncident(<IncidentListScreen />, { permissions: ADMIN });
    expect(await screen.findByText('Aún no hay siniestros')).toBeInTheDocument();
    press('Nuevo siniestro');
    await waitFor(() => expect(window.location.pathname).toBe('/incidents/new'));
  });

  it('retries after an error and hands a 401 to the session', async () => {
    const { onExpired } = renderIncident(<IncidentListScreen />, {
      options: { incidents: [baseIncident()] },
      prepare: (fake) => fake.failNext('list', 401, 'unauthorized'),
    });
    await waitFor(() => expect(onExpired).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('table');
  });

  it('says a caller without the grant has no access', async () => {
    renderIncident(<IncidentListScreen />, {
      permissions: ['view', 'create', 'edit'],
    });
    expect(await screen.findByText('No tienes acceso')).toBeInTheDocument();
  });
});
