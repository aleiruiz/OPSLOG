import type { Result, Vehicle, VehiclesPort, VehicleStatus } from './types';

export interface VehicleOption {
  readonly id: string;
  /** What the person picks by: the economic number and the model. Vehicles hold no personal data. */
  readonly label: string;
  readonly economicNumber: string;
  /** Present on options read from the server: lets a screen offer only the vehicles an action accepts. */
  readonly status?: VehicleStatus;
}

export interface VehicleOptions {
  readonly items: readonly VehicleOption[];
  /** More vehicles exist than were loaded (the selector holds the first `MAX_VEHICLE_OPTIONS`). */
  readonly truncated: boolean;
}

const PAGE = 100;
const MAX_PAGES = 5;
export const MAX_VEHICLE_OPTIONS = PAGE * MAX_PAGES;

const optionOf = (vehicle: Vehicle): VehicleOption => ({
  id: vehicle.id,
  economicNumber: vehicle.economicNumber,
  status: vehicle.status,
  label: `${vehicle.economicNumber} · ${vehicle.make} ${vehicle.model}`,
});

/**
 * The vehicles a document or a policy can belong to, for a selector: the live vehicles of the company (archived ones
 * are hidden by the listing, like the backend refuses them as owners), ordered by economic number.
 */
export async function loadVehicleOptions(vehicles: VehiclesPort): Promise<Result<VehicleOptions>> {
  const items: VehicleOption[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await vehicles.list({
      limit: PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!result.ok) return result;
    items.push(...result.value.items.map(optionOf));
    if (result.value.nextCursor === null) return { ok: true, value: { items, truncated: false } };
    cursor = result.value.nextCursor;
  }
  return { ok: true, value: { items, truncated: true } };
}
