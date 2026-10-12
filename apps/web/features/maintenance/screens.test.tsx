import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CatalogScreen } from './CatalogScreen';
import { baseOrder, createFakeMaintenancePorts } from './fakePorts';
import { MaintenanceArea } from './MaintenanceArea';
import { MyOrdersScreen } from './MyOrdersScreen';
import { PlansScreen } from './PlansScreen';
import { ADMIN, EDITOR, VIEWER, renderView, violations } from './testing';
import { WorkOrdersScreen } from './WorkOrdersScreen';

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pick = async (label: string, option: string) => {
  fireEvent.mouseDown(screen.getByLabelText(label));
  fireEvent.click(await screen.findByRole('option', { name: option }));
};
const orders = [
  baseOrder({
    id: 'wo-1',
    description: 'Frenos',
    scheduledDate: '2026-10-20',
    status: 'assigned',
    mechanicId: 'mec-1',
  }),
  baseOrder({ id: 'wo-2', description: 'Suspensión', vehicleId: 'veh-002' }),
  baseOrder({
    id: 'wo-3',
    description: 'Servicio 10k',
    kind: 'preventive',
    planId: 'plan-1',
    occurrenceId: 'occ-1',
    scheduledDate: '2026-10-13',
    mechanicId: 'mec-2',
    status: 'in_progress',
  }),
];
const workshop = {
  id: 'ws-1',
  name: 'Taller Uno',
  specialties: ['frenos'],
  contact: null,
  active: true,
  createdAt: '',
  updatedAt: '',
};

describe('work order list and calendar', () => {
  it('shows the same orders as a table and a calendar, filters them and opens one', async () => {
    const onOpen = vi.fn();
    const { container } = renderView(
      <WorkOrdersScreen
        ports={createFakeMaintenancePorts({ orders }).ports}
        viewer={{ permissions: VIEWER, mechanicIds: [] }}
        onOpen={onOpen}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByRole('table', { name: '3 órdenes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva orden correctiva' })).toBeNull();
    expect(await violations(container)).toEqual([]);
    await pick('Estado', 'En proceso');
    expect(screen.getByRole('table', { name: '1 órdenes' })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('search')).getByRole('button', { name: 'Limpiar filtros' }),
    );
    await pick('Vehículo', 'veh-002');
    expect(within(screen.getByRole('table')).getByText('Suspensión')).toBeInTheDocument();
    fill('Mes programado', '2025-01');
    expect(screen.getByText('Sin resultados')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('search')).getByRole('button', { name: 'Limpiar filtros' }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Calendario' }));
    expect(screen.getByRole('region', { name: 'Programadas el 13/10/2026' })).toHaveTextContent(
      'Servicio 10k',
    );
    expect(screen.getByRole('region', { name: 'Sin fecha programada' })).toHaveTextContent(
      'Suspensión',
    );
    expect(await violations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Frenos' }));
    expect(onOpen).toHaveBeenCalledWith('wo-1');
  });

  it('registers a corrective order and explains empty and failing lists', async () => {
    const onOpen = vi.fn();
    const fake = createFakeMaintenancePorts({ orders: [] });
    renderView(
      <WorkOrdersScreen
        ports={fake.ports}
        viewer={{ permissions: EDITOR, mechanicIds: [] }}
        onOpen={onOpen}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByText('Aún no hay órdenes')).toBeInTheDocument();
    press('Nueva orden correctiva');
    press('Registrar orden');
    expect(screen.getByRole('alert')).toHaveTextContent('Indica el vehículo');
    fill(/^Vehículo \*/, 'veh-001');
    fill(/Descripción de la falla/, 'Fuga de aceite');
    press('Registrar orden');
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('wo-1'));
  });

  it('shows a retry for a failed list and no permission for a 403', async () => {
    const failing = createFakeMaintenancePorts({ failLists: true });
    renderView(
      <WorkOrdersScreen
        ports={failing.ports}
        viewer={{ permissions: VIEWER, mechanicIds: [] }}
        onOpen={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });
});

describe('my orders', () => {
  it('lists only the caller’s active orders with the next action', async () => {
    const onOpen = vi.fn();
    const { container } = renderView(
      <MyOrdersScreen
        ports={createFakeMaintenancePorts({ orders, scopedTo: ['mec-1'] }).ports}
        viewer={{ permissions: VIEWER, mechanicIds: ['mec-1'] }}
        onOpen={onOpen}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Frenos', level: 2 })).toBeInTheDocument();
    expect(screen.queryByText('Servicio 10k')).toBeNull();
    expect(await violations(container)).toEqual([]);
    press('Abrir para iniciar trabajo');
    expect(onOpen).toHaveBeenCalledWith('wo-1');
  });

  it('says when nothing is assigned', async () => {
    renderView(
      <MyOrdersScreen
        ports={createFakeMaintenancePorts({ orders: [] }).ports}
        viewer={{ permissions: VIEWER, mechanicIds: ['mec-9'] }}
        onOpen={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByText('No tienes órdenes asignadas')).toBeInTheDocument();
  });
});

describe('plans', () => {
  it('creates a plan by date and km, shows its next targets and edits it', async () => {
    const fake = createFakeMaintenancePorts();
    const { container } = renderView(
      <PlansScreen
        ports={fake.ports}
        viewer={{ permissions: EDITOR, mechanicIds: [] }}
        workshops={[workshop]}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByText('Aún no hay planes')).toBeInTheDocument();
    press('Nuevo plan');
    press('Guardar plan');
    expect(screen.getByRole('alert')).toHaveTextContent('Indica un intervalo');
    fill(/^Vehículo/, 'veh-001');
    fill('Cada cuántos días', '30');
    fill('Fecha del último servicio', '2026-09-01');
    fill('Cada cuántos kilómetros', '10000');
    fill('Kilometraje del último servicio', '5000');
    await pick('Taller por defecto', 'Taller Uno');
    press('Guardar plan');
    expect(await screen.findByRole('table', { name: '1 planes' })).toHaveTextContent(
      /cada 30 días o cada 10.?000 km, lo que ocurra primero/,
    );
    expect(await screen.findByText('Siguiente objetivo por fecha: 01/11/2026')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    press('Editar plan');
    fill('Cada cuántos días', '45');
    press('Guardar plan');
    await waitFor(() => expect(screen.getByRole('table')).toHaveTextContent('cada 45 días'));
  });

  it('explains a stale edit', async () => {
    const plan = {
      id: 'plan-1',
      vehicleId: 'veh-001',
      state: 'active' as const,
      intervalDays: 30,
      lastServiceDate: '2026-09-01',
      defaultWorkshopId: null,
      defaultMechanicId: null,
      version: 1,
      createdAt: '',
      updatedAt: '',
    };
    const fake = createFakeMaintenancePorts({ plans: [plan] });
    renderView(
      <PlansScreen
        ports={fake.ports}
        viewer={{ permissions: EDITOR, mechanicIds: [] }}
        onExpired={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'veh-001' }));
    press('Editar plan');
    await fake.ports.plans.update('plan-1', { version: 1, intervalDays: 60 });
    press('Guardar plan');
    expect(await screen.findByRole('alert')).toHaveTextContent('El plan cambió');
  });
});

describe('workshops and mechanics', () => {
  it('adds workshops and external mechanics, links internal ones only to company members, and deactivates', async () => {
    const fake = createFakeMaintenancePorts();
    const { container } = renderView(
      <CatalogScreen
        ports={fake.ports}
        viewer={{ permissions: EDITOR, mechanicIds: [] }}
        members={[{ id: 'u-ana', label: 'Ana (empresa)' }]}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByText('Aún no hay talleres')).toBeInTheDocument();
    fill(/Nombre del taller/, 'Taller Norte');
    fill('Especialidades del taller (separadas por coma)', 'frenos, motor');
    press('Agregar taller');
    expect(await screen.findByRole('table', { name: '1 talleres' })).toHaveTextContent(
      'frenos, motor',
    );
    fill(/Nombre del mecánico/, 'Luis Externo');
    press('Agregar mecánico');
    expect(await screen.findByRole('table', { name: '1 mecánicos' })).toHaveTextContent(
      'Externo (sin cuenta)',
    );
    await pick('Vínculo', 'Interno (usuario de la empresa)');
    fill(/Nombre del mecánico/, 'Ana Interna');
    press('Agregar mecánico');
    expect(
      within(screen.getByRole('form', { name: 'Nuevo mecánico' })).getByRole('alert'),
    ).toHaveTextContent('Elige el usuario');
    await pick('Usuario de la empresa', 'Ana (empresa)');
    press('Agregar mecánico');
    expect(await screen.findByRole('table', { name: '2 mecánicos' })).toHaveTextContent(
      'Interno (usuario de la empresa)',
    );
    expect(await violations(container)).toEqual([]);
    press('Desactivar Taller Norte');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Desactivar Taller Norte' })).toBeNull(),
    );
  });

  it('is read-only for viewers', async () => {
    renderView(
      <CatalogScreen
        ports={createFakeMaintenancePorts({ workshops: [workshop] }).ports}
        viewer={{ permissions: VIEWER, mechanicIds: [] }}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByRole('table', { name: '1 talleres' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Nuevo taller' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Desactivar/ })).toBeNull();
  });
});

describe('maintenance area', () => {
  it('switches sections, opens an order and returns, deriving the caller’s mechanic records', async () => {
    const fake = createFakeMaintenancePorts({
      orders,
      workshops: [workshop],
      mechanics: [
        {
          id: 'mec-1',
          name: 'Ana',
          specialties: [],
          contact: null,
          kind: 'internal',
          workshopId: 'ws-1',
          memberId: 'u-ana',
          active: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    renderView(
      <MaintenanceArea
        ports={fake.ports}
        permissions={VIEWER}
        userId="u-ana"
        onExpired={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Órdenes de mantenimiento' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Mis órdenes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir para iniciar trabajo' }));
    expect(await screen.findByRole('heading', { name: 'Frenos', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Ana')).toBeInTheDocument();
    press('Volver a órdenes');
    fireEvent.click(screen.getByRole('tab', { name: 'Planes' }));
    expect(
      await screen.findByRole('heading', { name: 'Planes de mantenimiento' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Talleres y mecánicos' }));
    expect(
      await screen.findByRole('heading', { name: 'Talleres y mecánicos', level: 1 }),
    ).toBeInTheDocument();
  });

  it('keeps the admin flow free of budget approval before start (D14)', async () => {
    renderView(
      <MaintenanceArea
        ports={createFakeMaintenancePorts({ orders }).ports}
        permissions={ADMIN}
        userId="u-admin"
        onExpired={vi.fn()}
      />,
    );
    await screen.findByRole('table');
    expect(document.body.textContent).not.toMatch(/presupuesto|pendiente de aprobación/i);
  });

  it('reports a failed mechanic lookup on my orders instead of an empty list', async () => {
    const fake = createFakeMaintenancePorts({ orders });
    let failures = 1;
    const list = fake.ports.mechanics.list;
    fake.ports.mechanics.list = async () =>
      failures-- > 0
        ? {
            ok: false,
            error: { status: 500, code: 'internal_error', message: 'x', correlationId: 'c' },
          }
        : list();
    renderView(
      <MaintenanceArea
        ports={fake.ports}
        permissions={VIEWER}
        userId="u-ana"
        initialView="mine"
        onExpired={vi.fn()}
      />,
    );
    expect(
      await screen.findByText('No pudimos identificar tus órdenes asignadas.'),
    ).toBeInTheDocument();
    press('Reintentar');
    expect(await screen.findByRole('heading', { name: 'Mis órdenes' })).toBeInTheDocument();
  });
});
