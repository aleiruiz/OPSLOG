import { addDays, dayEnd } from './calendar.js';
import type { EmployeeFact, StatusEntryFact, VehicleFact } from './ports.js';
import { percentOf } from './stats.js';
import type { DailyAvailability } from './types.js';

/** A vehicle is alive while it is not archived and not decommissioned. */
export const isAlive = (vehicle: VehicleFact): boolean =>
  vehicle.archivedAt === null && vehicle.status !== 'decommissioned';

export const countActive = (vehicles: readonly VehicleFact[]): number =>
  vehicles.filter((vehicle) => vehicle.archivedAt === null && vehicle.status === 'active').length;

export const countOutOfService = (vehicles: readonly VehicleFact[]): number =>
  vehicles.filter(
    (vehicle) =>
      vehicle.archivedAt === null &&
      (vehicle.status === 'out_of_service' || vehicle.status === 'in_maintenance'),
  ).length;

export const countActiveDrivers = (employees: readonly EmployeeFact[]): number =>
  employees.filter((employee) => employee.kind === 'driver' && employee.status === 'active').length;

export interface AvailabilityResult {
  readonly percent: number | null;
  readonly days: number;
  readonly series: readonly DailyAvailability[];
}

/** Days of the range that have already started: `from` to `min(to, today)`. */
export function evaluatedDays(from: string, to: string, today: string): readonly string[] {
  const last = to < today ? to : today;
  const days: string[] = [];
  for (let day = from; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * Availability of the range (D5). For each day, at its last millisecond in the company's zone:
 * live vehicles are those whose first status change is not later, that are not archived by then
 * and whose status is not `decommissioned`; available ones are live vehicles in `active`
 * (`restricted` is not available). The figure is the mean of the daily ratios over the days that
 * have live vehicles; a range with none is "sin datos" (null).
 */
export function availability(
  vehicles: readonly VehicleFact[],
  entries: readonly StatusEntryFact[],
  days: readonly string[],
  timeZone: string,
): AvailabilityResult {
  const byVehicle = new Map<string, StatusEntryFact[]>();
  for (const entry of entries) {
    const list = byVehicle.get(entry.vehicleId) ?? [];
    list.push(entry);
    byVehicle.set(entry.vehicleId, list);
  }
  for (const list of byVehicle.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const cursor = new Map<string, number>();
  const series: DailyAvailability[] = [];
  for (const day of days) {
    const end = dayEnd(day, timeZone);
    let live = 0;
    let available = 0;
    for (const vehicle of vehicles) {
      const list = byVehicle.get(vehicle.id) ?? [];
      let position = cursor.get(vehicle.id) ?? 0;
      while (position < list.length && Date.parse((list[position] as StatusEntryFact).at) <= end)
        position += 1;
      cursor.set(vehicle.id, position);
      if (position === 0) continue;
      if (vehicle.archivedAt !== null && Date.parse(vehicle.archivedAt) <= end) continue;
      const status = (list[position - 1] as StatusEntryFact).to;
      if (status === 'decommissioned') continue;
      live += 1;
      if (status === 'active') available += 1;
    }
    series.push({ day, available, live });
  }
  const withVehicles = series.filter((point) => point.live > 0);
  const sum = withVehicles.reduce((total, point) => total + point.available / point.live, 0);
  return {
    percent: withVehicles.length === 0 ? null : (percentOf(sum, withVehicles.length) as number),
    days: withVehicles.length,
    series,
  };
}
