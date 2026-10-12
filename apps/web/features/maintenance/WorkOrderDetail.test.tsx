import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { baseOrder, createFakeMaintenancePorts } from './fakePorts';
import { ADMIN, EDITOR, VIEWER, renderView, violations } from './testing';
import { WorkOrderDetail } from './WorkOrderDetail';

const workshops = [
  {
    id: 'ws-1',
    name: 'Taller Uno',
    specialties: [],
    contact: null,
    active: true,
    createdAt: '',
    updatedAt: '',
  },
];
const mechanics = [
  {
    id: 'mec-1',
    name: 'Ana Mecánica',
    specialties: [],
    contact: null,
    kind: 'internal' as const,
    workshopId: 'ws-1',
    memberId: 'u-mech',
    active: true,
    createdAt: '',
    updatedAt: '',
  },
];

function view(
  permissions: string[],
  fake = createFakeMaintenancePorts({ viewCosts: permissions.includes('view_costs') }),
  mechanicIds: string[] = [],
) {
  const onExpired = vi.fn();
  const utils = renderView(
    <WorkOrderDetail
      ports={fake.ports}
      viewer={{ permissions, mechanicIds }}
      orderId="wo-1"
      workshops={workshops}
      mechanics={mechanics}
      onBack={vi.fn()}
      onExpired={onExpired}
    />,
  );
  return { ...utils, fake, onExpired };
}
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('work order detail', () => {
  it('shows the missing requirements the server returns, then assigns with the full form', async () => {
    const { container, fake } = view(EDITOR);
    await screen.findByRole('heading', { name: 'Frenos rechinan', level: 1 });
    expect(screen.getByLabelText('Estado: Programada')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    press('Asignar');
    const form = screen.getByRole('form', { name: 'Asignar' });
    fireEvent.click(within(form).getByRole('button', { name: 'Asignar' }));
    const panel = await screen.findByRole('complementary', { name: 'Falta para continuar' });
    expect(within(panel).getByText('Indica la persona responsable.')).toBeInTheDocument();
    expect(within(panel).getByText('Indica la fecha programada.')).toBeInTheDocument();
    expect(fake.state.calls).toEqual(['transition:assign']);
    fill('Persona responsable (usuario)', 'u-fleet');
    fill('Fecha programada', '2026-10-13');
    fireEvent.mouseDown(screen.getByLabelText('Taller'));
    fireEvent.click(await screen.findByRole('option', { name: 'Taller Uno' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Asignar' }));
    await screen.findByLabelText('Estado: Asignada');
    expect(screen.getByRole('status')).toHaveTextContent('Asignar: listo.');
    expect(await screen.findByText('Asignar → Asignada')).toBeInTheDocument();
  });

  it('lets the assigned mechanic start and finish, with the workshop suggestion, never closing', async () => {
    const fake = createFakeMaintenancePorts({
      orders: [
        baseOrder({ status: 'assigned', mechanicId: 'mec-1', workshopId: 'ws-1', version: 2 }),
      ],
    });
    view(VIEWER, fake, ['mec-1']);
    await screen.findByLabelText('Estado: Asignada');
    expect(screen.queryByRole('button', { name: 'Cancelar orden' })).toBeNull();
    press('Iniciar trabajo');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Iniciar trabajo' })).getByRole('button', {
        name: 'Iniciar trabajo',
      }),
    );
    await screen.findByLabelText('Estado: En proceso');
    expect(screen.getByText(/Sugerencia: el vehículo queda bloqueado/)).toBeInTheDocument();
    press('Registrar trabajo');
    fill('Trabajos realizados', 'Cambio de balatas\nAjuste de freno');
    press('Agregar refacción');
    fill('Refacción 1', 'Balata');
    fill('Cantidad de la refacción 1', '4');
    press('Guardar trabajo');
    await screen.findByText('Ajuste de freno');
    expect(screen.getByText('Balata · 4')).toBeInTheDocument();
    press('Registrar término');
    fill('Fecha real del servicio', '2026-10-12');
    fill('Kilometraje del servicio', '15200');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Registrar término' })).getByRole('button', {
        name: 'Registrar término',
      }),
    );
    await screen.findByLabelText('Estado: Terminada');
    expect(screen.queryByRole('button', { name: 'Cerrar orden' })).toBeNull();
    expect(screen.queryByText('Costos')).toBeNull();
  });

  it('never renders amounts without view_costs, and shows exact amounts with it', async () => {
    const order = baseOrder({
      status: 'completed',
      version: 5,
      tasks: [{ id: 't1', description: 'Servicio' }],
      parts: [
        {
          id: 'p1',
          name: 'Filtro',
          quantity: '1',
          unitCost: { amountMinor: '45050', currency: 'MXN' },
        },
      ],
      costs: [{ id: 'c1', category: 'labor', amount: { amountMinor: '125000', currency: 'MXN' } }],
    });
    const hidden = view(EDITOR, createFakeMaintenancePorts({ orders: [order] }));
    await screen.findByText('Filtro · 1');
    expect(hidden.container.innerHTML).not.toMatch(/450|1,250|125000|MXN|Costos/);
    hidden.unmount();
    view(ADMIN, createFakeMaintenancePorts({ orders: [order], viewCosts: true }));
    expect(await screen.findByText('Mano de obra: 1,250.00 MXN')).toBeInTheDocument();
    expect(screen.getByText('Filtro · 1 · 450.50 MXN c/u')).toBeInTheDocument();
    press('Registrar costos');
    fill('Importe 1', '1300.5');
    press('Guardar costos');
    expect(await screen.findByText('Mano de obra: 1,300.50 MXN')).toBeInTheDocument();
    press('Registrar costos');
    press('Agregar costo');
    fill('Importe 2', '1.234');
    press('Guardar costos');
    expect(
      within(screen.getByRole('form', { name: 'Registrar costos' })).getByRole('alert'),
    ).toHaveTextContent('Revisa los importes');
  });

  it('closes with the vehicle decision, requires the D20 approval only when reported, and reopens with a reason', async () => {
    const fake = createFakeMaintenancePorts({
      viewCosts: true,
      orders: [
        baseOrder({
          status: 'completed',
          version: 5,
          tasks: [{ id: 't1', description: 'Servicio' }],
        }),
      ],
    });
    fake.state.approvalRequired = true;
    view(ADMIN, fake);
    await screen.findByLabelText('Estado: Terminada');
    expect(screen.queryByRole('button', { name: 'Aprobar cierre' })).toBeNull();
    press('Cerrar orden');
    fireEvent.mouseDown(screen.getByLabelText('Estado del vehículo al cerrar'));
    fireEvent.click(await screen.findByRole('option', { name: 'Activo' }));
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Cerrar orden' })).getByRole('button', {
        name: 'Cerrar orden',
      }),
    );
    expect(
      await screen.findByText('Falta la aprobación de cierre de una persona supervisora.'),
    ).toBeInTheDocument();
    press('Aprobar cierre');
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Aprobar cierre' })).getByRole('button', {
        name: 'Aprobar cierre',
      }),
    );
    await screen.findByText('Aprobar cierre: listo.');
    press('Cerrar orden');
    fireEvent.mouseDown(screen.getByLabelText('Estado del vehículo al cerrar'));
    fireEvent.click(await screen.findByRole('option', { name: 'En mantenimiento' }));
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Cerrar orden' })).getByRole('button', {
        name: 'Cerrar orden',
      }),
    );
    await screen.findByLabelText('Estado: Cerrada');
    expect(screen.getByText('En mantenimiento')).toBeInTheDocument();
    press('Reabrir orden');
    fill(/Motivo de la reapertura/, 'Falta factura');
    press('Confirmar');
    await screen.findByLabelText('Estado: En proceso');
    expect(await screen.findByText('Falta factura')).toBeInTheDocument();
  });

  it('explains a version conflict, keeps the form and reloads on request', async () => {
    const fake = createFakeMaintenancePorts();
    view(EDITOR, fake);
    await screen.findByLabelText('Estado: Programada');
    fake.bump('wo-1');
    press('Cancelar orden');
    fill(/Motivo de la cancelación/, 'Duplicada');
    press('Confirmar');
    expect(await screen.findByText(/La orden cambió mientras la editabas/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Motivo de la cancelación/)).toHaveValue('Duplicada');
    press('Recargar');
    await waitFor(() => expect(screen.queryByText(/La orden cambió/)).toBeNull());
  });

  it('answers a foreign or unknown order neutrally and hands a 401 to the session', async () => {
    const fake = createFakeMaintenancePorts({ orders: [] });
    view(ADMIN, fake);
    expect(await screen.findByText('No encontramos esta orden')).toBeInTheDocument();
    const expired = createFakeMaintenancePorts();
    expired.ports.orders.get = async () => ({
      ok: false,
      error: { status: 401, code: 'unauthorized', message: 'x', correlationId: 'c' },
    });
    const { onExpired } = view(ADMIN, expired);
    await waitFor(() => expect(onExpired).toHaveBeenCalled());
  });
});
