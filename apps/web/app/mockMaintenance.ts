import type { ApiError } from '@opslog/contracts';
import { baseOrder, createFakeMaintenancePorts } from '../features/maintenance/fakePorts';
import type { MaintenancePorts, Result } from '../features/maintenance/ports';
import type { Permission } from './types';

const at = '2026-10-06T12:00:00.000Z';
const denied = (status: ApiError['status'], code: string): Result<never> => ({
  ok: false,
  error: {
    status,
    code,
    message: status === 401 ? 'Authentication required' : 'Permission denied',
    correlationId: 'mock',
  },
});

/**
 * Maintenance routes of the mock API: the in-memory contract stand-in of the feature, behind the
 * same session checks as every other mock port (401 signed out, 403 without `view`), with costs
 * and the mechanic scope following the signed-in role. All data is synthetic.
 */
export function createMockMaintenancePorts(session: {
  readonly userId: () => string | null;
  readonly can: (permission: Permission) => boolean;
}): MaintenancePorts {
  const mechanicOf: Record<string, string> = { 'user-mechanic': 'mec-001' };
  const fake = createFakeMaintenancePorts({
    viewCosts: () => session.can('view_costs'),
    scopedTo: () => {
      const user = session.userId();
      const mechanic = user ? mechanicOf[user] : undefined;
      return mechanic && !session.can('edit') ? [mechanic] : undefined;
    },
    orders: [
      baseOrder({
        id: 'wo-001',
        description: 'Frenos rechinan',
        vehicleId: 'veh-001',
        status: 'assigned',
        version: 2,
        mechanicId: 'mec-001',
        workshopId: 'ws-001',
        responsibleId: 'user-admin',
        scheduledDate: '2026-10-08',
        createdAt: at,
        updatedAt: at,
      }),
      baseOrder({
        id: 'wo-002',
        description: 'Ruido en suspensión',
        vehicleId: 'veh-002',
        createdAt: at,
        updatedAt: at,
      }),
      baseOrder({
        id: 'wo-003',
        kind: 'preventive',
        planId: 'plan-001',
        occurrenceId: 'occ-001',
        description: 'Servicio de 10 000 km',
        vehicleId: 'veh-001',
        status: 'completed',
        version: 6,
        workshopId: 'ws-001',
        mechanicId: 'mec-002',
        scheduledDate: '2026-10-05',
        actualDate: '2026-10-05',
        actualKm: 10400,
        tasks: [{ id: 'task-001', description: 'Cambio de aceite y filtro' }],
        parts: [
          {
            id: 'part-001',
            name: 'Filtro de aceite',
            quantity: '1',
            unitCost: { amountMinor: '45050', currency: 'MXN' },
          },
        ],
        costs: [
          { id: 'cost-001', category: 'labor', amount: { amountMinor: '125000', currency: 'MXN' } },
        ],
        createdAt: at,
        updatedAt: at,
      }),
    ],
    plans: [
      {
        id: 'plan-001',
        vehicleId: 'veh-001',
        state: 'active',
        intervalDays: 30,
        intervalKm: 10000,
        lastServiceDate: '2026-09-05',
        lastServiceKm: 400,
        defaultWorkshopId: 'ws-001',
        defaultMechanicId: null,
        version: 3,
        createdAt: at,
        updatedAt: at,
      },
    ],
    workshops: [
      {
        id: 'ws-001',
        name: 'Taller Centro',
        specialties: ['frenos', 'motor'],
        contact: '555-0100',
        active: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
    mechanics: [
      {
        id: 'mec-001',
        name: 'Mecánico interno',
        specialties: ['frenos'],
        contact: null,
        kind: 'internal',
        workshopId: 'ws-001',
        memberId: 'user-mechanic',
        active: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'mec-002',
        name: 'Taller externo Ruiz',
        specialties: ['motor'],
        contact: null,
        kind: 'external',
        workshopId: null,
        memberId: null,
        active: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
  });
  const guard =
    <A extends unknown[], T>(call: (...args: A) => Promise<Result<T>>) =>
    (...args: A): Promise<Result<T>> => {
      if (session.userId() === null) return Promise.resolve(denied(401, 'unauthorized'));
      if (!session.can('view')) return Promise.resolve(denied(403, 'forbidden'));
      return call(...args);
    };
  const wrap = <G extends Record<string, (...args: never[]) => Promise<Result<unknown>>>>(
    group: G,
  ): G =>
    Object.fromEntries(
      Object.entries(group).map(([name, call]) => [
        name,
        guard(call as (...args: unknown[]) => Promise<Result<unknown>>),
      ]),
    ) as unknown as G;
  const omitFiles = (group: MaintenancePorts['orders']) =>
    Object.fromEntries(Object.entries(group).filter(([name]) => name !== 'files')) as Omit<
      MaintenancePorts['orders'],
      'files'
    >;
  return {
    orders: { ...wrap(omitFiles(fake.ports.orders)), files: wrap(fake.ports.orders.files) },
    settings: wrap(fake.ports.settings),
    plans: wrap(fake.ports.plans),
    workshops: wrap(fake.ports.workshops),
    mechanics: wrap(fake.ports.mechanics),
  };
}
