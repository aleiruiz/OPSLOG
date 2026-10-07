import { type Vehicle, type VehicleStatus, type VehicleStatusEntry } from './types.js';

export interface VehicleFilter {
  readonly status?: VehicleStatus;
  readonly areaId?: string;
  readonly includeArchived: boolean;
}

export interface VehicleWindow {
  readonly limit: number;
  readonly offset: number;
}

export interface VehicleSlice {
  readonly items: readonly Vehicle[];
  /** Number of vehicles matching the filter, not only the window. */
  readonly total: number;
}

/**
 * Persistence port. Every method is tenant-scoped: a vehicle of another tenant is simply absent.
 * `insert` and `replace` throw `VehicleError('duplicate', field)` when an economic number, plate or
 * VIN of the same tenant is already taken.
 */
export interface VehicleStore {
  insert(vehicle: Vehicle, entry: VehicleStatusEntry): Promise<void>;
  find(tenantId: string, id: string): Promise<Vehicle | null>;
  /** Ordered by economic number (case-insensitive), then id. */
  list(tenantId: string, filter: VehicleFilter, window: VehicleWindow): Promise<VehicleSlice>;
  /**
   * Atomic compare-and-set: writes `next` (and the optional history entry) only while the stored
   * version is `expectedVersion` and the odometer would not decrease; false otherwise.
   */
  replace(next: Vehicle, expectedVersion: number, entry?: VehicleStatusEntry): Promise<boolean>;
  history(tenantId: string, vehicleId: string): Promise<readonly VehicleStatusEntry[]>;
  /**
   * Count port for the Areas module (BR-021): vehicles of the tenant in `areaId` that still count
   * as assigned resources, i.e. not archived and not `decommissioned`. Every other status
   * (including `inactive`) counts: such a vehicle can return to service inside that area.
   */
  countLiveInArea(tenantId: string, areaId: string): Promise<number>;
}

/**
 * Port to the Areas module (BR-021). `withActiveArea` runs `work` only while `areaId` is an ACTIVE
 * area of `tenantId` and cannot be deactivated: the implementation holds the same per-tenant
 * serialization the area deactivation runs under for the whole duration of `work`, so a
 * deactivation cannot commit between the check and the vehicle write. Unknown, foreign and
 * inactive areas are indistinguishable: it throws `VehicleError('invalid_area', 'area_id')` without
 * running `work`. Errors of `work` propagate unchanged.
 */
export interface VehicleAreaGate {
  withActiveArea<T>(tenantId: string, areaId: string, work: () => Promise<T>): Promise<T>;
}
