import type { ApiError } from '@opslog/contracts';
import { BFF_VEHICLE_STATUSES } from '@opslog/contracts';
import { demoVehicles } from '../vehicles/fixtures';
import {
  ECONOMIC_NUMBER,
  LABEL,
  MAX_ODOMETER_KM,
  MIN_MODEL_YEAR,
  OPAQUE_ID,
  PLATE,
  VIN,
  maxModelYear,
  isInteger,
  isPastOrToday,
  normalizePlate,
  normalizeVin,
  todayOf,
} from '../vehicles/rules';
import type {
  Page,
  Result,
  Vehicle,
  VehicleInput,
  VehicleListQuery,
  VehiclePatch,
  VehiclesPort,
} from './types';

/**
 * In-memory vehicles with the semantics of the real backend (`packages/domain/vehicles`): optimistic
 * versions (409 `stale_version`), read-only archived/decommissioned vehicles (409 `immutable`), per-company
 * uniqueness (409 `duplicate` with the colliding field), a never-decreasing odometer (422
 * `odometer_decrease`) and a uniform 400/404. Permissions are enforced by the caller (`mockApi`).
 */
export interface MockVehicleStore {
  readonly port: VehiclesPort;
  /** Another actor changes the vehicle on the server: bumps its version, so the caller's copy is stale. */
  changeExternally(
    id: string,
    change: Partial<Pick<Vehicle, 'odometerKm' | 'make' | 'model'>>,
  ): void;
  /** Another actor archives the vehicle on the server. */
  archiveExternally(id: string): void;
  snapshot(): readonly Vehicle[];
}

const NOW = '2026-10-06T12:00:00.000Z';
let correlation = 0;

function failure(
  status: ApiError['status'],
  code: string,
  message: string,
  field?: string,
): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      correlationId: `corr-mock-vehicle-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');
const notFound = () => failure(404, 'not_found', 'Resource not found');
const invalidArea = () => failure(422, 'invalid_area', 'Unprocessable request', 'area_id');
const conflict = (code: 'stale_version' | 'immutable') => failure(409, code, 'Conflict');

const economicKey = (value: string) => value.toLowerCase();
const plateKey = (plate: string) => plate.replace(/[ -]/g, '');

type Core = Pick<
  Vehicle,
  'economicNumber' | 'plate' | 'vin' | 'make' | 'model' | 'year' | 'areaId'
>;

/** Validates and normalizes the fields that are present; `null` when anything is invalid. */
function parseCore(input: Readonly<Record<string, unknown>>, now: Date): Partial<Core> | null {
  const out: { -readonly [K in keyof Core]?: Core[K] } = {};
  const key = (name: string) => Object.hasOwn(input, name);
  const text = (key: string) =>
    typeof input[key] === 'string' ? (input[key] as string).trim() : null;
  if (key('economicNumber')) {
    const value = text('economicNumber');
    if (value === null || !ECONOMIC_NUMBER.test(value)) return null;
    out.economicNumber = value;
  }
  if (key('plate')) {
    const value = text('plate');
    if (value === null || !PLATE.test(normalizePlate(value))) return null;
    out.plate = normalizePlate(value);
  }
  if (key('vin')) {
    const raw = input['vin'];
    if (raw === null) out.vin = null;
    else {
      const value = text('vin');
      if (value === null || !VIN.test(normalizeVin(value))) return null;
      out.vin = normalizeVin(value);
    }
  }
  for (const field of ['make', 'model'] as const) {
    if (key(field)) {
      const value = text(field);
      if (value === null || !LABEL.test(value)) return null;
      out[field] = value;
    }
  }
  if (key('year')) {
    const value = input['year'];
    if (typeof value !== 'number' || !isInteger(value, MIN_MODEL_YEAR, maxModelYear(now)))
      return null;
    out.year = value;
  }
  if (key('areaId')) {
    const value = input['areaId'];
    if (typeof value !== 'string' || !OPAQUE_ID.test(value)) return null;
    out.areaId = value;
  }
  return out;
}

export function createMockVehicleStore(
  seed: readonly Vehicle[] = demoVehicles(),
  now: () => Date = () => new Date(NOW),
  /** Whether an area id is an active area of the company (like the backend, which refuses any other). */
  isActiveArea: (areaId: string) => boolean = () => true,
): MockVehicleStore {
  let rows: Vehicle[] = seed.map((vehicle) => ({ ...vehicle }));
  let sequence = rows.length;
  // The form dates a new vehicle with the real clock, so the mock cannot judge "not in the future"
  // against its fixed one once the real day moves past it.
  const latestToday = () => todayOf(new Date(Math.max(now().getTime(), Date.now())));

  const index = (id: string) => rows.findIndex((vehicle) => vehicle.id === id);
  const replace = (id: string, next: Vehicle) => {
    rows = rows.map((vehicle) => (vehicle.id === id ? next : vehicle));
    return next;
  };
  const collision = (candidate: Partial<Core>, exceptId: string | null): string | null => {
    for (const other of rows) {
      if (other.id === exceptId) continue;
      if (
        candidate.economicNumber !== undefined &&
        economicKey(other.economicNumber) === economicKey(candidate.economicNumber)
      )
        return 'economic_number';
      if (candidate.plate !== undefined && plateKey(other.plate) === plateKey(candidate.plate))
        return 'plate';
      if (candidate.vin && other.vin === candidate.vin) return 'vin';
    }
    return null;
  };
  const duplicate = (field: string) => failure(409, 'duplicate', 'Conflict', field);
  const validVersion = (value: unknown): value is number =>
    typeof value === 'number' && isInteger(value, 1, 2_147_483_646);
  const bump = (vehicle: Vehicle, change: Partial<Vehicle>): Vehicle => ({
    ...vehicle,
    ...change,
    version: vehicle.version + 1,
    updatedAt: NOW,
  });

  const port: VehiclesPort = {
    list: async (query: VehicleListQuery = {}) => {
      const limit = query.limit ?? 25;
      const offset =
        query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
      if (
        ![25, 50, 100].includes(limit) ||
        !Number.isSafeInteger(offset) ||
        (query.status !== undefined && !BFF_VEHICLE_STATUSES.includes(query.status)) ||
        (query.areaId !== undefined && !OPAQUE_ID.test(query.areaId)) ||
        (query.includeArchived !== undefined && !['true', 'false'].includes(query.includeArchived))
      )
        return badRequest();
      const matches = rows
        .filter(
          (vehicle) =>
            (query.includeArchived === 'true' || vehicle.archivedAt === null) &&
            (query.status === undefined || vehicle.status === query.status) &&
            (query.areaId === undefined || vehicle.areaId === query.areaId),
        )
        .sort(
          (a, b) =>
            a.economicNumber.toLowerCase().localeCompare(b.economicNumber.toLowerCase()) ||
            a.id.localeCompare(b.id),
        );
      const next = offset + limit;
      const page: Page<Vehicle> = {
        items: matches.slice(offset, next).map((vehicle) => ({ ...vehicle })),
        nextCursor: next < matches.length ? `mock:${next}` : null,
        total: matches.length,
        sort: { field: 'economicNumber', direction: 'asc' },
      };
      return ok(page);
    },
    get: async (id) => {
      const found = rows[index(id)];
      return found ? ok({ ...found }) : notFound();
    },
    create: async (input: VehicleInput) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      const required = ['economicNumber', 'plate', 'make', 'model', 'year', 'areaId', 'odometerKm'];
      const core = parseCore(fields, now());
      const odometer = fields['odometerKm'];
      const registeredOn = fields['registeredOn'] ?? todayOf(now());
      if (
        core === null ||
        required.some((name) => !Object.hasOwn(fields, name)) ||
        typeof odometer !== 'number' ||
        !isInteger(odometer, 0, MAX_ODOMETER_KM) ||
        typeof registeredOn !== 'string' ||
        !isPastOrToday(registeredOn, latestToday())
      )
        return badRequest();
      if (!isActiveArea(core.areaId as string)) return invalidArea();
      const clash = collision(core, null);
      if (clash) return duplicate(clash);
      sequence += 1;
      const vehicle: Vehicle = {
        id: `veh-nuevo-${sequence}`,
        economicNumber: core.economicNumber as string,
        plate: core.plate as string,
        vin: core.vin ?? null,
        make: core.make as string,
        model: core.model as string,
        year: core.year as number,
        areaId: core.areaId as string,
        status: 'active',
        statusReason: 'Alta',
        odometerKm: odometer,
        registeredOn,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      };
      rows = [...rows, vehicle];
      return ok({ ...vehicle });
    },
    update: async (id, patch: VehiclePatch) => {
      const { version, ...rest } = patch as unknown as Record<string, unknown>;
      const current = rows[index(id)];
      if (!current) return notFound();
      const core = parseCore(rest, now());
      if (!validVersion(version) || core === null || Object.keys(rest).length === 0)
        return badRequest();
      if (current.archivedAt !== null || current.status === 'decommissioned')
        return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      if (core.areaId !== undefined && core.areaId !== current.areaId && !isActiveArea(core.areaId))
        return invalidArea();
      const clash = collision(core, id);
      if (clash) return duplicate(clash);
      return ok({ ...replace(id, bump(current, core)) });
    },
    recordOdometer: async (id, reading) => {
      const current = rows[index(id)];
      if (!current) return notFound();
      if (!validVersion(reading.version) || !isInteger(reading.odometerKm, 0, MAX_ODOMETER_KM))
        return badRequest();
      if (current.archivedAt !== null || current.status === 'decommissioned')
        return conflict('immutable');
      if (current.version !== reading.version) return conflict('stale_version');
      if (reading.odometerKm < current.odometerKm)
        return failure(422, 'odometer_decrease', 'Unprocessable request');
      if (reading.odometerKm === current.odometerKm) return ok({ ...current });
      return ok({ ...replace(id, bump(current, { odometerKm: reading.odometerKm })) });
    },
    archive: async (id, version) => {
      const current = rows[index(id)];
      if (!current) return notFound();
      if (!validVersion(version)) return badRequest();
      if (current.archivedAt !== null) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      return ok({ ...replace(id, bump(current, { archivedAt: NOW })) });
    },
  };

  return {
    port,
    changeExternally: (id, change) => {
      const current = rows[index(id)];
      if (current) replace(id, bump(current, change));
    },
    archiveExternally: (id) => {
      const current = rows[index(id)];
      if (current) replace(id, bump(current, { archivedAt: NOW }));
    },
    snapshot: () => rows.map((vehicle) => ({ ...vehicle })),
  };
}
