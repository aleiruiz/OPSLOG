import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { BffMaintenanceMechanic } from '@opslog/contracts';
import type { UserSummary, UsersPort } from '../../app/types';
import { emptyDirectory, memberOptions, vehicleLabel, memberLabel } from './directory';
import { baseOrder, createFakeMaintenancePorts } from './fakePorts';
import { loadMemberOptions } from './members';
import { CommandForm } from './CommandForm';
import { CorrectiveOrderForm } from './CorrectiveOrderForm';
import { MyOrdersScreen } from './MyOrdersScreen';
import { PlanForm } from './PlanForm';
import { EDITOR, VIEWER, TEST_DIRECTORY, renderView, violations } from './testing';
import { WorkOrdersScreen } from './WorkOrdersScreen';

const mechanic = (overrides: Partial<BffMaintenanceMechanic>): BffMaintenanceMechanic => ({
  id: 'mec-1',
  name: 'Ana Mecánica',
  specialties: [],
  contact: null,
  kind: 'internal',
  workshopId: null,
  memberId: 'u-ana',
  active: true,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('people and vehicle labels', () => {
  it('names members by linked mechanic, then role, puts the caller first and never shows an id', () => {
    const options = memberOptions(
      [
        { id: 'u-zoe', label: 'Operador 1' },
        { id: 'u-ana', label: 'Responsable de flotilla 1' },
        { id: 'u-me', label: 'Administración 1' },
      ],
      [
        mechanic({}),
        mechanic({ id: 'mec-2', name: 'Externo', memberId: 'u-out' }),
        mechanic({ id: 'mec-3', name: 'Inactivo', memberId: 'u-zoe', active: false }),
        mechanic({ id: 'mec-4', name: 'Sin cuenta', memberId: null }),
      ],
      'u-me',
    );
    expect(options.map((option) => option.label)).toEqual([
      'Administración 1 (tú)',
      'Ana Mecánica · Responsable de flotilla 1',
      'Externo (mecánico interno)',
      'Operador 1',
    ]);
    expect(memberOptions([], [], 'u-me')).toEqual([{ id: 'u-me', label: 'Tú' }]);
    expect(memberLabel({ ...emptyDirectory, members: options }, 'u-ana')).toContain('Ana');
    expect(memberLabel(emptyDirectory, 'u-x')).toBe('Otra persona de la empresa');
    expect(vehicleLabel(TEST_DIRECTORY, 'veh-001')).toBe('ECO-001 · Toyota Hilux');
    expect(vehicleLabel(TEST_DIRECTORY, 'veh-x')).toBe('Vehículo no disponible');
  });
});

describe('loadMemberOptions', () => {
  const user = (index: number, status: UserSummary['status'], roleLabel = 'Editor'): UserSummary =>
    ({ id: `u-${index}`, roleId: 'r', roleLabel, status }) as UserSummary;
  const port = (pages: UserSummary[][], failAt = -1): UsersPort => {
    let call = 0;
    return {
      listUsers: vi.fn(async () => {
        const index = call++;
        if (index === failAt)
          return {
            ok: false as const,
            error: { status: 500, code: 'x', message: 'x', correlationId: 'c' },
          };
        const items = pages[index] ?? [];
        return {
          ok: true as const,
          value: {
            items,
            total: 0,
            nextCursor: index < pages.length - 1 ? `c${index + 1}` : null,
            sort: { field: 'id', direction: 'asc' as const },
          },
        };
      }),
    } as unknown as UsersPort;
  };

  it('reads every page of active members, naming them by role and order', async () => {
    const first = Array.from({ length: 100 }, (_, i) => user(i, 'active'));
    const second = [user(100, 'active'), user(101, 'inactive'), user(102, 'active', 'Consulta')];
    const users = port([first, second]);
    const loaded = await loadMemberOptions(users);
    expect(users.listUsers).toHaveBeenCalledTimes(2);
    expect(users.listUsers).toHaveBeenLastCalledWith({ limit: 100, cursor: 'c1' });
    expect(loaded?.truncated).toBe(false);
    expect(loaded?.items).toHaveLength(102);
    expect(loaded?.items[100]).toEqual({ id: 'u-100', label: 'Editor 101' });
    expect(loaded?.items[101]).toEqual({ id: 'u-102', label: 'Consulta 1' });
  });

  it('says so when it stops early or a later page fails, and returns null when the first fails', async () => {
    const endless = port(Array.from({ length: 12 }, () => [user(1, 'active')]));
    expect((await loadMemberOptions(endless))?.truncated).toBe(true);
    expect(endless.listUsers).toHaveBeenCalledTimes(10);
    const broken = port([[user(1, 'active')], [user(2, 'active')]], 1);
    expect(await loadMemberOptions(broken)).toMatchObject({ truncated: true });
    expect(await loadMemberOptions(port([[]], 0))).toBeNull();
  });
});

describe('pickers instead of technical ids', () => {
  it('registers a corrective order by choosing a vehicle from the list', async () => {
    const created = vi.fn();
    const fake = createFakeMaintenancePorts({ orders: [] });
    const { container } = renderView(
      <CorrectiveOrderForm
        ports={fake.ports}
        onCreated={created}
        onCancel={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    const select = screen.getByLabelText(/^Vehículo/);
    expect(select.tagName).toBe('SELECT');
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Elige un vehículo',
      'ECO-001 · Toyota Hilux',
      'ECO-002 · Nissan NP300',
    ]);
    expect(await violations(container)).toEqual([]);
    fireEvent.change(select, { target: { value: 'veh-002' } });
    fireEvent.change(screen.getByLabelText(/Descripción de la falla/), {
      target: { value: 'Fuga' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar orden' }));
    await vi.waitFor(() => expect(created).toHaveBeenCalled());
    expect(created.mock.calls[0]?.[0]).toMatchObject({ vehicleId: 'veh-002' });
  });

  it('explains missing vehicles and offers a retry when they could not be loaded', () => {
    const retry = vi.fn();
    const { unmount } = renderView(
      <CorrectiveOrderForm
        ports={createFakeMaintenancePorts().ports}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
        onExpired={vi.fn()}
      />,
      { ...emptyDirectory, reloadVehicles: retry },
    );
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos cargar los vehículos');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(retry).toHaveBeenCalled();
    unmount();
    renderView(
      <CorrectiveOrderForm
        ports={createFakeMaintenancePorts().ports}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
        onExpired={vi.fn()}
      />,
      { ...emptyDirectory, vehicles: [] },
    );
    expect(screen.getByText(/Aún no hay vehículos registrados/)).toBeInTheDocument();
  });

  it('creates a plan for the chosen vehicle and shows the vehicle by name when editing', async () => {
    const fake = createFakeMaintenancePorts();
    const create = vi.spyOn(fake.ports.plans, 'create');
    const { unmount } = renderView(
      <PlanForm
        ports={fake.ports}
        plan={null}
        workshops={[]}
        mechanics={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^Vehículo/).tagName).toBe('SELECT');
    fireEvent.change(screen.getByLabelText(/^Vehículo/), { target: { value: 'veh-001' } });
    fireEvent.change(screen.getByLabelText('Cada cuántos días'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Fecha del último servicio'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar plan' }));
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toMatchObject({ vehicleId: 'veh-001', intervalDays: 30 });
    unmount();
    renderView(
      <PlanForm
        ports={fake.ports}
        plan={{
          id: 'plan-1',
          vehicleId: 'veh-002',
          state: 'active',
          intervalDays: 30,
          lastServiceDate: '2026-09-01',
          defaultWorkshopId: null,
          defaultMechanicId: null,
          version: 1,
          createdAt: '',
          updatedAt: '',
        }}
        workshops={[]}
        mechanics={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    expect(screen.getByText('Vehículo: ECO-002 · Nissan NP300')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Vehículo/)).toBeNull();
  });

  it('picks the responsible person from the company members, never by typing an id', async () => {
    const submit = vi.fn();
    renderView(
      <CommandForm
        command="assign"
        order={baseOrder()}
        workshops={[]}
        mechanics={[]}
        busy={false}
        onSubmit={submit}
        onCancel={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Persona responsable');
    expect(select.tagName).toBe('SELECT');
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Sin responsable',
      'Responsable de flotilla 1',
      'Administración 1',
    ]);
    fireEvent.change(select, { target: { value: 'u-fleet' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Asignar' }).at(-1) as HTMLElement);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ responsibleId: 'u-fleet' }));
  });

  it('shows vehicle names, not ids, in the order list, its filter and Mis órdenes', async () => {
    const orders = [
      baseOrder({ id: 'wo-1', vehicleId: 'veh-001', status: 'assigned', mechanicId: 'mec-1' }),
      baseOrder({ id: 'wo-2', vehicleId: 'veh-002' }),
    ];
    const fake = createFakeMaintenancePorts({ orders });
    const { unmount } = renderView(
      <WorkOrdersScreen
        ports={fake.ports}
        viewer={{ permissions: VIEWER, mechanicIds: [] }}
        onOpen={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    const table = await screen.findByRole('table', { name: '2 órdenes' });
    expect(table).toHaveTextContent('ECO-002 · Nissan NP300');
    expect(document.body.textContent).not.toMatch(/veh-00/);
    unmount();
    renderView(
      <MyOrdersScreen
        ports={createFakeMaintenancePorts({ orders, scopedTo: ['mec-1'] }).ports}
        viewer={{ permissions: EDITOR, mechanicIds: ['mec-1'] }}
        onOpen={vi.fn()}
        onExpired={vi.fn()}
      />,
    );
    expect(await screen.findByText(/ECO-001 · Toyota Hilux · Programada/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/veh-00/);
  });
});
