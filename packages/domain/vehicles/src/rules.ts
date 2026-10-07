import { VehicleError } from './errors.js';
import {
  STATUS_TRANSITIONS,
  type NewVehicleData,
  type Vehicle,
  type VehicleCore,
  type VehicleStatus,
  type VehicleStatusEntry,
} from './types.js';

export const canTransition = (from: VehicleStatus, to: VehicleStatus): boolean =>
  STATUS_TRANSITIONS[from].includes(to);

/** Archived and decommissioned vehicles are read-only (archiving a decommissioned one is allowed). */
function assertEditable(vehicle: Vehicle): void {
  if (vehicle.archivedAt !== null || vehicle.status === 'decommissioned')
    throw new VehicleError('immutable');
}

function assertVersion(vehicle: Vehicle, expectedVersion: number): void {
  if (vehicle.version !== expectedVersion) throw new VehicleError('stale_version');
}

const touched = (vehicle: Vehicle, now: Date): Pick<Vehicle, 'version' | 'updatedAt'> => ({
  version: vehicle.version + 1,
  updatedAt: now.toISOString(),
});

/** The initial vehicle: always `active`, version 1, not archived. */
export function newVehicle(tenantId: string, id: string, data: NewVehicleData, now: Date): Vehicle {
  return {
    id,
    tenantId,
    ...data,
    status: 'active',
    statusReason: 'Alta',
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
  };
}

export function statusEntry(
  vehicle: Vehicle,
  from: VehicleStatus | null,
  id: string,
  actorId: string,
  now: Date,
): VehicleStatusEntry {
  return {
    id,
    tenantId: vehicle.tenantId,
    vehicleId: vehicle.id,
    from,
    to: vehicle.status,
    reason: vehicle.statusReason,
    actorId,
    version: vehicle.version,
    at: now.toISOString(),
  };
}

export function applyPatch(
  vehicle: Vehicle,
  patch: Partial<VehicleCore>,
  expectedVersion: number,
  now: Date,
): Vehicle {
  assertEditable(vehicle);
  assertVersion(vehicle, expectedVersion);
  return { ...vehicle, ...patch, ...touched(vehicle, now) };
}

/** Manual status change (BR-004): needs a reason and an allowed transition. */
export function applyStatus(
  vehicle: Vehicle,
  to: VehicleStatus,
  reason: string,
  expectedVersion: number,
  now: Date,
): Vehicle {
  if (vehicle.archivedAt !== null) throw new VehicleError('immutable');
  assertVersion(vehicle, expectedVersion);
  if (!canTransition(vehicle.status, to)) throw new VehicleError('invalid_transition');
  return { ...vehicle, status: to, statusReason: reason, ...touched(vehicle, now) };
}

/** BR-015: the odometer never decreases. Equal readings are accepted and change nothing. */
export function applyOdometer(
  vehicle: Vehicle,
  odometerKm: number,
  expectedVersion: number,
  now: Date,
): Vehicle {
  assertEditable(vehicle);
  assertVersion(vehicle, expectedVersion);
  if (odometerKm < vehicle.odometerKm) throw new VehicleError('odometer_decrease');
  if (odometerKm === vehicle.odometerKm) return vehicle;
  return { ...vehicle, odometerKm, ...touched(vehicle, now) };
}

/** Soft delete (BR-009): the row stays, hidden from default listings and read-only. */
export function applyArchive(vehicle: Vehicle, expectedVersion: number, now: Date): Vehicle {
  if (vehicle.archivedAt !== null) throw new VehicleError('immutable');
  assertVersion(vehicle, expectedVersion);
  return { ...vehicle, archivedAt: now.toISOString(), ...touched(vehicle, now) };
}

/** The vehicles that block deactivating their area (see `VehicleStore.countLiveInArea`). */
export const isLiveVehicle = (vehicle: Pick<Vehicle, 'status' | 'archivedAt'>): boolean =>
  vehicle.archivedAt === null && vehicle.status !== 'decommissioned';
