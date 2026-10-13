import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { BffIncidentAlert, BffIncidentSla } from '@opslog/contracts';
import { completeEvent } from './fakePorts';
import { IncidentAlertsScreen } from './IncidentAlertsScreen';
import { IncidentListScreen } from './IncidentListScreen';
import { ADMIN, RoutedDetail, VIEWER, renderIncident, violations } from './testing';

const sla = (overrides: Partial<BffIncidentSla> = {}): BffIncidentSla => ({
  cycle: 1,
  state: 'warning',
  startedAt: '2026-10-05T12:00:00.000Z',
  deadline: '2026-10-20T12:00:00.000Z',
  targetDays: 15,
  elapsedPercent: 85,
  resolvedAt: null,
  previousCycles: [],
  ...overrides,
});
const alert = (index: number, overrides: Partial<BffIncidentAlert> = {}): BffIncidentAlert => ({
  id: `alert-${index}`,
  incidentId: `inc-${index}`,
  folio: `SIN-2026-${String(index).padStart(6, '0')}`,
  kind: 'sla_warning',
  cycle: 1,
  createdAt: '2026-10-13T08:00:00.000Z',
  severity: 'high',
  deadline: '2026-10-20T12:00:00.000Z',
  ...overrides,
});
const alerts = (count: number, overrides: Partial<BffIncidentAlert> = {}) =>
  Array.from({ length: count }, (_, index) => alert(index + 1, overrides));

describe('SLA in the list and in the case', () => {
  it('shows the SLA of each case as text, and says when a case has none', async () => {
    renderIncident(<IncidentListScreen />, {
      options: {
        incidents: [
          completeEvent({ id: 'inc-1', folio: 'SIN-2026-000001', status: 'reported', sla: sla() }),
          completeEvent({
            id: 'inc-2',
            folio: 'SIN-2026-000002',
            status: 'reported',
            sla: sla({ state: 'breached', elapsedPercent: 120 }),
          }),
          completeEvent({ id: 'inc-3', folio: 'SIN-2026-000003', status: 'reported' }),
        ],
      },
    });
    const table = await screen.findByRole('table', { name: '3 siniestros' });
    const rows = within(table).getAllByRole('row');
    expect(within(table).getByRole('columnheader', { name: 'SLA' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('SLA por vencer');
    expect(rows[2]).toHaveTextContent('SLA vencido');
    expect(rows[3]).toHaveTextContent('Sin SLA');
    expect(
      within(rows[1] as HTMLElement).getByLabelText('Estado: SLA por vencer'),
    ).toBeInTheDocument();
  });

  it('puts the SLA beside the state in the header and explains the deadline', async () => {
    const { container } = renderIncident(<RoutedDetail />, {
      path: '/incidents/inc-001',
      options: {
        incidents: [completeEvent({ status: 'reported', version: 2, sla: sla() })],
      },
    });
    expect(await screen.findByLabelText('Estado: SLA por vencer')).toBeInTheDocument();
    const panel = await screen.findByRole('region', { name: 'Plazo de resolución' });
    expect(panel).toHaveTextContent('15 días naturales');
    expect(panel).toHaveTextContent('20/10/2026 06:00');
    expect(panel).toHaveTextContent('85 %');
    expect(await violations(container)).toEqual([]);
  });

  it('keeps the earlier cycles of a reopened case with their own result', async () => {
    renderIncident(<RoutedDetail />, {
      path: '/incidents/inc-001',
      options: {
        incidents: [
          completeEvent({
            status: 'reopened',
            version: 8,
            sla: sla({
              cycle: 2,
              state: 'on_track',
              elapsedPercent: 10,
              previousCycles: [
                {
                  cycle: 1,
                  startedAt: '2026-09-01T12:00:00.000Z',
                  resolvedAt: '2026-09-10T12:00:00.000Z',
                  met: true,
                },
              ],
            }),
          }),
        ],
      },
    });
    const panel = await screen.findByRole('region', { name: 'Plazo de resolución' });
    expect(panel).toHaveTextContent('Ciclo 2: el caso se reabrió.');
    expect(within(panel).getByRole('list', { name: 'Ciclos anteriores' })).toHaveTextContent(
      'Ciclo 1: resuelto en plazo',
    );
  });

  it('draws no SLA panel for a draft nor for a deployment without the block', async () => {
    renderIncident(<RoutedDetail />, {
      path: '/incidents/inc-001',
      options: {
        incidents: [completeEvent({ status: 'draft', sla: sla({ state: 'not_started' }) })],
      },
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Plazo de resolución' })).toBeNull();
    expect(screen.getByLabelText('Estado: SLA sin iniciar')).toBeInTheDocument();
  });
});

describe('notices of incidents', () => {
  it('shows the notice above the list with its folio and a link to the case', async () => {
    const { container } = renderIncident(<IncidentListScreen />, {
      options: {
        incidents: [completeEvent({ id: 'inc-1', folio: 'SIN-2026-000001', status: 'reported' })],
        alerts: [alert(1)],
      },
    });
    const panel = await screen.findByRole('region', { name: 'Avisos de siniestros' });
    expect(within(panel).getByLabelText('Estado: SLA por vencer')).toBeInTheDocument();
    expect(panel).toHaveTextContent('El caso ya usó el 80 % de su plazo.');
    expect(within(panel).getByRole('link', { name: 'SIN-2026-000001' })).toHaveAttribute(
      'href',
      '/incidents/inc-1',
    );
    expect(panel).toHaveTextContent('Alta');
    expect(panel).toHaveTextContent('20/10/2026 06:00');
    expect(document.body.textContent).not.toMatch(/alert-1/);
    await screen.findByRole('table', { name: '1 siniestros' });
    expect(await violations(container)).toEqual([]);
  });

  it('draws nothing when there are no notices, and a short list with a way to all of them', async () => {
    const { unmount } = renderIncident(<IncidentListScreen />, {
      options: { incidents: [completeEvent({ status: 'reported' })] },
    });
    await screen.findByRole('table');
    expect(screen.queryByRole('region', { name: 'Avisos de siniestros' })).toBeNull();
    unmount();
    renderIncident(<IncidentListScreen />, {
      options: { incidents: [completeEvent({ status: 'reported' })], alerts: alerts(8) },
    });
    const panel = await screen.findByRole('region', { name: 'Avisos de siniestros' });
    expect(within(panel).getByRole('table', { name: '5 avisos' })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Ver los 8 avisos' })).toHaveAttribute(
      'href',
      '/incidents/avisos',
    );
  });

  it('warns without blocking the list when the notices cannot load, and retries', async () => {
    renderIncident(<IncidentListScreen />, {
      options: { incidents: [completeEvent({ status: 'reported' })], alerts: alerts(1) },
      prepare: (fake) => fake.failNext('alerts.list', 500),
    });
    await screen.findByRole('table');
    expect(
      await screen.findByText('No pudimos cargar los avisos de siniestros.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('region', { name: 'Avisos de siniestros' })).toBeInTheDocument();
  });

  it('lists every notice with a filter by kind and loads more', async () => {
    const all = [
      ...alerts(30),
      alert(31, { kind: 'unassigned_escalation', severity: null, deadline: null, cycle: 2 }),
    ];
    const { fake } = renderIncident(<IncidentAlertsScreen />, {
      path: '/incidents/avisos',
      options: { alerts: all },
      permissions: ADMIN,
    });
    expect(
      await screen.findByRole('heading', { name: 'Avisos de siniestros', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: '25 avisos' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más avisos' }));
    expect(await screen.findByRole('table', { name: '31 avisos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cargar más avisos' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Tipo de aviso'), {
      target: { value: 'unassigned_escalation' },
    });
    const table = await screen.findByRole('table', { name: '1 avisos' });
    expect(table).toHaveTextContent('Sin responsable (escalado)');
    expect(table).toHaveTextContent('(ciclo 2)');
    expect(table).toHaveTextContent('Sin definir');
    expect(table).toHaveTextContent('Sin fecha');
    expect(fake.calls.filter((call) => call === 'alerts.list').length).toBe(3);
  });

  it('says so when there are none, and when the load fails or the session ended', async () => {
    const { unmount } = renderIncident(<IncidentAlertsScreen />, { permissions: ADMIN });
    expect(await screen.findByText('No tienes avisos de siniestros')).toBeInTheDocument();
    unmount();
    const { onExpired } = renderIncident(<IncidentAlertsScreen />, {
      prepare: (fake) => fake.failNext('alerts.list', 401),
    });
    await waitFor(() => expect(onExpired).toHaveBeenCalled());
  });

  it('shows a reader the same panel (the server decides who sees which notice)', async () => {
    renderIncident(<IncidentAlertsScreen />, {
      permissions: VIEWER,
      options: { alerts: alerts(2) },
    });
    expect(await screen.findByRole('table', { name: '2 avisos' })).toBeInTheDocument();
  });
});
