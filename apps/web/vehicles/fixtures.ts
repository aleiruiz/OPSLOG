import type { Vehicle, VehicleStatus } from '../app/types';

/** Synthetic vehicles for the mock API, tests and stories. Nothing here is real data. */

export const demoAreas = ['area-norte', 'area-centro', 'area-sur'] as const;

const MAKES = [
  { make: 'Nissan', model: 'NP300' },
  { make: 'Toyota', model: 'Hilux' },
  { make: 'Ford', model: 'Transit' },
  { make: 'Volkswagen', model: 'Crafter' },
  { make: 'Mercedes-Benz', model: 'Sprinter' },
  { make: 'Chevrolet', model: 'Aveo' },
] as const;

const STATUSES: readonly VehicleStatus[] = [
  'active',
  'active',
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
];

export function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: 'veh-001',
    economicNumber: 'ECO-001',
    plate: 'ABC-101',
    vin: null,
    make: 'Nissan',
    model: 'NP300',
    year: 2022,
    areaId: 'area-norte',
    status: 'active',
    statusReason: 'Alta',
    odometerKm: 48250,
    registeredOn: '2024-03-15',
    version: 1,
    createdAt: '2024-03-15T14:30:00.000Z',
    updatedAt: '2024-03-15T14:30:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

/** `count` vehicles ordered by economic number: every status, three areas, a few VINs. */
export function demoVehicles(count = 28): Vehicle[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const pair = MAKES[index % MAKES.length] as (typeof MAKES)[number];
    const status = STATUSES[index % STATUSES.length] as VehicleStatus;
    return makeVehicle({
      id: `veh-${String(n).padStart(3, '0')}`,
      economicNumber: `ECO-${String(n).padStart(3, '0')}`,
      plate: `ABC-${100 + n}`,
      vin: n % 5 === 0 ? `3N6PD23W${String(n).padStart(2, '0')}ZB${String(10000 + n)}` : null,
      make: pair.make,
      model: pair.model,
      year: 2018 + (index % 8),
      areaId: demoAreas[index % demoAreas.length] as string,
      status,
      statusReason: status === 'active' ? 'Alta' : 'Cambio de estado de demostración',
      odometerKm: 12000 + n * 3150,
      registeredOn: `2024-${String((index % 12) + 1).padStart(2, '0')}-10`,
    });
  });
}
