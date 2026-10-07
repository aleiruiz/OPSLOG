import { VehicleError, type VehicleConflictField } from './errors.js';
import {
  type VehicleFilter,
  type VehicleSlice,
  type VehicleStore,
  type VehicleWindow,
} from './ports.js';
import { isLiveVehicle } from './rules.js';
import { type Vehicle, type VehicleStatusEntry } from './types.js';
import { economicNumberKey, plateKey } from './validation.js';

/** Plain code-unit order, the same a binary collation gives, so every store lists in the same order. */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/** In-memory double of the port. Each method is synchronous inside, so every operation is atomic. */
export class InMemoryVehicleStore implements VehicleStore {
  private readonly vehicles = new Map<string, Vehicle>();
  private readonly entries: VehicleStatusEntry[] = [];

  private conflict(candidate: Vehicle): VehicleConflictField | null {
    for (const other of this.vehicles.values()) {
      if (other.tenantId !== candidate.tenantId || other.id === candidate.id) continue;
      if (economicNumberKey(other.economicNumber) === economicNumberKey(candidate.economicNumber))
        return 'economic_number';
      if (plateKey(other.plate) === plateKey(candidate.plate)) return 'plate';
      if (candidate.vin !== null && other.vin === candidate.vin) return 'vin';
    }
    return null;
  }

  public async insert(vehicle: Vehicle, entry: VehicleStatusEntry): Promise<void> {
    const key = storeKey(vehicle.tenantId, vehicle.id);
    const field = this.conflict(vehicle);
    if (this.vehicles.has(key)) throw new VehicleError('duplicate');
    if (field) throw new VehicleError('duplicate', field);
    this.vehicles.set(key, structuredClone(vehicle));
    this.entries.push(structuredClone(entry));
  }

  public async find(tenantId: string, id: string): Promise<Vehicle | null> {
    const found = this.vehicles.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async list(
    tenantId: string,
    filter: VehicleFilter,
    window: VehicleWindow,
  ): Promise<VehicleSlice> {
    const matching = [...this.vehicles.values()]
      .filter(
        (vehicle) =>
          vehicle.tenantId === tenantId &&
          (filter.includeArchived || vehicle.archivedAt === null) &&
          (filter.status === undefined || vehicle.status === filter.status) &&
          (filter.areaId === undefined || vehicle.areaId === filter.areaId),
      )
      .sort(
        (a, b) =>
          compareKeys(economicNumberKey(a.economicNumber), economicNumberKey(b.economicNumber)) ||
          compareKeys(a.id, b.id),
      );
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((vehicle) => structuredClone(vehicle)),
      total: matching.length,
    };
  }

  public async replace(
    next: Vehicle,
    expectedVersion: number,
    entry?: VehicleStatusEntry,
  ): Promise<boolean> {
    const key = storeKey(next.tenantId, next.id);
    const current = this.vehicles.get(key);
    if (current?.version !== expectedVersion || next.odometerKm < current.odometerKm) return false;
    const field = this.conflict(next);
    if (field) throw new VehicleError('duplicate', field);
    this.vehicles.set(key, structuredClone(next));
    if (entry) this.entries.push(structuredClone(entry));
    return true;
  }

  public async countLiveInArea(tenantId: string, areaId: string): Promise<number> {
    return [...this.vehicles.values()].filter(
      (vehicle) =>
        vehicle.tenantId === tenantId && vehicle.areaId === areaId && isLiveVehicle(vehicle),
    ).length;
  }

  public async history(
    tenantId: string,
    vehicleId: string,
  ): Promise<readonly VehicleStatusEntry[]> {
    return this.entries
      .filter((entry) => entry.tenantId === tenantId && entry.vehicleId === vehicleId)
      .sort((a, b) => a.version - b.version)
      .map((entry) => structuredClone(entry));
  }
}
