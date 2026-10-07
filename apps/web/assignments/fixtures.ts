import type { AssignmentEvent, VehicleAssignment } from '../app/types';

/** Synthetic assignments for the mock API, tests and stories. Nothing here is real data. */

export function makeAssignment(overrides: Partial<VehicleAssignment> = {}): VehicleAssignment {
  return {
    id: 'asg-001',
    vehicleId: 'veh-001',
    employeeId: 'emp-001',
    type: 'principal',
    reason: 'Ruta de reparto zona norte',
    assignedBy: 'user-admin',
    startedAt: '2026-03-02T15:00:00.000Z',
    endedAt: null,
    endKind: null,
    endReason: null,
    endedBy: null,
    current: true,
    version: 1,
    updatedAt: '2026-03-02T15:00:00.000Z',
    ...overrides,
  };
}

/** The same assignment, closed. */
export function closed(
  assignment: VehicleAssignment,
  endKind: 'ended' | 'replaced' = 'ended',
  overrides: Partial<VehicleAssignment> = {},
): VehicleAssignment {
  const endedAt = overrides.endedAt ?? '2026-06-15T18:30:00.000Z';
  return {
    ...assignment,
    endedAt,
    endKind,
    endReason: endKind === 'replaced' ? 'Cambio de conductor titular' : 'Fin de la ruta',
    endedBy: 'user-admin',
    current: false,
    version: assignment.version + 1,
    updatedAt: endedAt,
    ...overrides,
  };
}

const DAY_MS = 86_400_000;
const BASE = Date.parse('2025-10-20T15:00:00.000Z');

/**
 * `count` assignments, newest first: the first ones are the current picture of the demo fleet (a principal for two
 * vehicles, a secondary and a temporary) and the history behind it (a replaced principal, a closed temporary); the
 * rest is older closed history, enough for a second page. Vehicles and drivers are those of the other demo fixtures.
 */
export function demoAssignments(count = 28): VehicleAssignment[] {
  const curated: VehicleAssignment[] = [
    makeAssignment({ id: 'asg-001', vehicleId: 'veh-001', employeeId: 'emp-001' }),
    makeAssignment({
      id: 'asg-002',
      vehicleId: 'veh-002',
      employeeId: 'emp-002',
      reason: 'Ruta de reparto zona centro',
      startedAt: '2026-04-10T14:00:00.000Z',
      updatedAt: '2026-04-10T14:00:00.000Z',
    }),
    makeAssignment({
      id: 'asg-003',
      vehicleId: 'veh-001',
      employeeId: 'emp-006',
      type: 'secondary',
      reason: 'Cubre los fines de semana',
      startedAt: '2026-05-04T14:00:00.000Z',
      updatedAt: '2026-05-04T14:00:00.000Z',
    }),
    makeAssignment({
      id: 'asg-004',
      vehicleId: 'veh-004',
      employeeId: 'emp-006',
      type: 'temporary',
      reason: 'Suplencia por mantenimiento de su unidad',
      startedAt: '2026-09-28T13:00:00.000Z',
      updatedAt: '2026-09-28T13:00:00.000Z',
    }),
    closed(
      makeAssignment({
        id: 'asg-005',
        vehicleId: 'veh-001',
        employeeId: 'emp-005',
        reason: 'Alta del vehículo en la flota',
        startedAt: '2025-11-03T14:00:00.000Z',
      }),
      'replaced',
      { endedAt: '2026-03-02T15:00:00.000Z' },
    ),
    closed(
      makeAssignment({
        id: 'asg-006',
        vehicleId: 'veh-003',
        employeeId: 'emp-001',
        type: 'temporary',
        reason: 'Cobertura de vacaciones',
        startedAt: '2026-01-12T14:00:00.000Z',
      }),
      'ended',
      { endedAt: '2026-01-30T22:00:00.000Z' },
    ),
  ];
  const drivers = ['emp-001', 'emp-002', 'emp-005', 'emp-006'] as const;
  const filler = Array.from({ length: Math.max(0, count - curated.length) }, (_, index) => {
    const n = curated.length + index + 1;
    const start = new Date(BASE - (n + 20) * 4 * DAY_MS).toISOString();
    const end = new Date(BASE - (n + 20) * 4 * DAY_MS + 30 * DAY_MS).toISOString();
    return closed(
      makeAssignment({
        id: `asg-${String(n).padStart(3, '0')}`,
        vehicleId: `veh-${String(((index * 3) % 20) + 9).padStart(3, '0')}`,
        employeeId: drivers[index % drivers.length] as string,
        type: index % 4 === 0 ? 'temporary' : 'secondary',
        reason: 'Asignación de demostración',
        startedAt: start,
      }),
      'ended',
      { endedAt: end },
    );
  });
  return [...curated, ...filler].slice(0, count);
}

export function makeEvent(overrides: Partial<AssignmentEvent> = {}): AssignmentEvent {
  return {
    seq: 1,
    kind: 'assigned',
    actorId: 'user-admin',
    reason: 'Ruta de reparto zona norte',
    at: '2026-03-02T15:00:00.000Z',
    ...overrides,
  };
}
