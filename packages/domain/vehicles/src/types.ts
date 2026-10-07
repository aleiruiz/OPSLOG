/**
 * Vehicle statuses (BRD §8.6). `decommissioned` is the BRD's `Baja`: terminal, history is kept.
 * Ids are English snake_case; the labels (`Activo`, `Restringido`, ...) belong to the web layer.
 */
export const VEHICLE_STATUSES = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
] as const;

export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/**
 * Allowed manual transitions. The BRD lists the states but no matrix (open question in the task
 * document): any live state may move to any other except that `inactive` (idle) does not go
 * straight into a maintenance or out-of-service episode, and `decommissioned` has no way out.
 */
export const STATUS_TRANSITIONS: Readonly<Record<VehicleStatus, readonly VehicleStatus[]>> = {
  active: ['restricted', 'in_maintenance', 'out_of_service', 'inactive', 'decommissioned'],
  restricted: ['active', 'in_maintenance', 'out_of_service', 'inactive', 'decommissioned'],
  in_maintenance: ['active', 'restricted', 'out_of_service', 'decommissioned'],
  out_of_service: ['active', 'restricted', 'in_maintenance', 'inactive', 'decommissioned'],
  inactive: ['active', 'restricted', 'decommissioned'],
  decommissioned: [],
};

export const isVehicleStatus = (value: unknown): value is VehicleStatus =>
  typeof value === 'string' && (VEHICLE_STATUSES as readonly string[]).includes(value);

export const MAX_ODOMETER_KM = 9_999_999;

export const MIN_MODEL_YEAR = 1950;

export const MAX_REASON_LENGTH = 200;

export const MAX_LIST_LIMIT = 100;

export const DEFAULT_LIST_LIMIT = 25;

export interface Vehicle {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  /**
   * Area of the vehicle. When set or changed it must be an active area of the same tenant (checked
   * by `VehicleService` through `VehicleAreaGate`); an unchanged value is kept as is, even if that
   * area has been deactivated since.
   */
  readonly areaId: string;
  readonly status: VehicleStatus;
  /** Reason of the last status change (BR-004). */
  readonly statusReason: string;
  readonly odometerKm: number;
  /** Fecha de alta, `YYYY-MM-DD`. */
  readonly registeredOn: string;
  /** Optimistic concurrency token: starts at 1, +1 on every change. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** One row of the status history (BRD ★VehicleStatusHistory). `from` is null for the initial entry. */
export interface VehicleStatusEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly vehicleId: string;
  readonly from: VehicleStatus | null;
  readonly to: VehicleStatus;
  readonly reason: string;
  readonly actorId: string;
  /** Version the vehicle had right after this change: orders the history and is unique per vehicle. */
  readonly version: number;
  readonly at: string;
}

export type VehicleCore = Pick<
  Vehicle,
  'economicNumber' | 'plate' | 'vin' | 'make' | 'model' | 'year' | 'areaId'
>;

export type NewVehicleData = VehicleCore & Pick<Vehicle, 'odometerKm' | 'registeredOn'>;
