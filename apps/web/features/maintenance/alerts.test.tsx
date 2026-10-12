import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { BffMaintenanceAlert } from '@opslog/contracts';
import { alertReason, alertTarget, odometerAge } from './alertLabels';
import { createFakeMaintenancePorts } from './fakePorts';
import { MaintenanceAlertsPanel } from './MaintenanceAlertsPanel';
import { PlansScreen } from './PlansScreen';
import { VIEWER, renderView, violations } from './testing';

const alert = (overrides: Partial<BffMaintenanceAlert> = {}): BffMaintenanceAlert => ({
  id: 'a-1',
  planId: 'plan-1',
  vehicleId: 'veh-001',
  occurrence: 1,
  planVersion: 1,
  kind: 'upcoming',
  trigger: 'odometer',
  threshold: '500_km',
  targetDate: null,
  targetKm: 10_400,
  odometerLastUpdatedAt: '2026-10-10T12:00:00.000Z',
  odometerAgeSeconds: 172_800,
  occurredAt: '2026-10-12T12:00:00.000Z',
  ...overrides,
});
const plan = {
  id: 'plan-1',
  vehicleId: 'veh-001',
  state: 'active' as const,
  intervalKm: 10_000,
  lastServiceKm: 400,
  defaultWorkshopId: null,
  defaultMechanicId: null,
  version: 1,
  createdAt: '',
  updatedAt: '',
};

describe('maintenance alert labels', () => {
  it('describes each kind, target and the age of the odometer reading when it applies', () => {
    expect(alertReason(alert())).toBe('Faltan 500 km o menos para el servicio.');
    expect(alertReason(alert({ threshold: '15_days', trigger: 'date' }))).toBe(
      'Faltan 15 días o menos para el servicio.',
    );
    expect(alertReason(alert({ kind: 'due', threshold: 'target' }))).toContain(
      'se generó la orden',
    );
    expect(alertReason(alert({ kind: 'overdue', threshold: 'target' }))).toContain('ya pasó');
    expect(alertTarget(alert())).toMatch(/^10.400 km$/);
    expect(alertTarget(alert({ trigger: 'date', targetDate: '2026-11-01', targetKm: null }))).toBe(
      '01/11/2026',
    );
    const age = (seconds: number | null) => odometerAge(alert({ odometerAgeSeconds: seconds }));
    expect(age(30)).toBe('Lectura del odómetro de hace menos de un minuto');
    expect(age(60)).toBe('Lectura del odómetro de hace 1 minuto');
    expect(age(7_200)).toBe('Lectura del odómetro de hace 2 horas');
    expect(age(86_400)).toBe('Lectura del odómetro de hace 1 día');
    expect(age(172_800)).toBe('Lectura del odómetro de hace 2 días');
    expect(age(null)).toBe('Sin fecha de la lectura del odómetro');
    expect(odometerAge(alert({ trigger: 'date', odometerAgeSeconds: null }))).toBeNull();
  });
});

describe('maintenance alert records', () => {
  it('lists the records of a plan with odometer age, pages them and keeps them accessible', async () => {
    const alerts = Array.from({ length: 30 }, (_, index) =>
      alert({
        id: `a-${String(index).padStart(2, '0')}`,
        occurredAt: `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
        kind: index === 29 ? 'overdue' : 'upcoming',
        ...(index === 28
          ? { trigger: 'date' as const, targetDate: '2026-10-30', targetKm: null }
          : {}),
        ...(index === 28 ? { odometerAgeSeconds: null, odometerLastUpdatedAt: null } : {}),
      }),
    );
    const fake = createFakeMaintenancePorts({ plans: [plan], alerts });
    const { container } = renderView(
      <PlansScreen
        ports={fake.ports}
        viewer={{ permissions: VIEWER, mechanicIds: [] }}
        onExpired={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'ECO-001 · Toyota Hilux' }));
    const table = await screen.findByRole('table', {
      name: 'Alertas de ECO-001 · Toyota Hilux (30)',
    });
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    // Newest first, with the label as text and not only as colour.
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Vencido');
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('Por fecha: 30/10/2026');
    expect(within(table).getAllByRole('row')[3]).toHaveTextContent(
      'Lectura del odómetro de hace 2 días',
    );
    expect(table).not.toHaveTextContent(/veh-001|plan-1|a-\d\d/);
    expect(await violations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más alertas' }));
    await vi.waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(31));
    expect(screen.queryByRole('button', { name: 'Cargar más alertas' })).toBeNull();
  });

  it('says when a plan has no alerts, retries a failed list and hands a 401 to the session', async () => {
    const quiet = createFakeMaintenancePorts({ plans: [plan] });
    const first = renderView(
      <MaintenanceAlertsPanel
        ports={quiet.ports}
        planId="plan-1"
        title="Alertas"
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByText('No hay alertas de mantenimiento.')).toBeInTheDocument();
    first.unmount();

    const flaky = createFakeMaintenancePorts({ plans: [plan], alerts: [alert()] });
    const list = flaky.ports.alerts.list;
    let failures = 1;
    flaky.ports.alerts.list = async (query) =>
      failures-- > 0
        ? { ok: false, error: { status: 500, code: 'x', message: 'x', correlationId: 'c' } }
        : list(query);
    const second = renderView(
      <MaintenanceAlertsPanel
        ports={flaky.ports}
        showVehicle
        title="Alertas"
        onExpired={vi.fn()}
      />,
    );
    expect(
      await screen.findByText('No pudimos cargar las alertas de mantenimiento.'),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('table', { name: 'Alertas (1)' })).toHaveTextContent(
      'ECO-001 · Toyota Hilux',
    );
    second.unmount();

    const expired = createFakeMaintenancePorts({ alerts: [alert()] });
    expired.ports.alerts.list = async () => ({
      ok: false,
      error: { status: 401, code: 'unauthorized', message: 'x', correlationId: 'c' },
    });
    const onExpired = vi.fn();
    renderView(
      <MaintenanceAlertsPanel ports={expired.ports} title="Alertas" onExpired={onExpired} />,
    );
    await vi.waitFor(() => expect(onExpired).toHaveBeenCalled());
  });

  it('reports a failure loading more without losing the loaded rows', async () => {
    const alerts = Array.from({ length: 26 }, (_, index) => alert({ id: `a-${index}` }));
    const fake = createFakeMaintenancePorts({ alerts });
    const list = fake.ports.alerts.list;
    fake.ports.alerts.list = async (query) =>
      query?.cursor
        ? { ok: false, error: { status: 500, code: 'x', message: 'x', correlationId: 'c' } }
        : list(query);
    renderView(<MaintenanceAlertsPanel ports={fake.ports} title="Alertas" onExpired={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar más alertas' }));
    expect(await screen.findByText('No pudimos cargar más alertas.')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Alertas (26)' })).toBeInTheDocument();
  });
});
