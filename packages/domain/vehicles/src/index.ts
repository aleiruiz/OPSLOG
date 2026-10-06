import { randomUUID } from 'node:crypto';

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

export const canTransition = (from: VehicleStatus, to: VehicleStatus): boolean =>
  STATUS_TRANSITIONS[from].includes(to);

export type VehicleErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_transition'
  | 'odometer_decrease'
  | 'immutable';

/** Which unique key collided. Only ever the field name, never the value. */
export type VehicleConflictField = 'economic_number' | 'plate' | 'vin';

export class VehicleError extends Error {
  public constructor(
    public readonly code: VehicleErrorCode,
    public readonly field?: VehicleConflictField,
  ) {
    super(`Vehicle request rejected: ${code}`);
    this.name = 'VehicleError';
  }
}

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
  /** Opaque area id; the Areas module does not exist yet, so existence is not checked. */
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

const invalid = (): never => {
  throw new VehicleError('invalid_input');
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ECONOMIC_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,31}$/;
const PLATE = /^[A-Z0-9](?:[A-Z0-9 -]{0,14}[A-Z0-9])?$/;
/** ISO 3779 alphabet: 17 characters, letters I, O and Q never occur. The check digit is not verified. */
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,60}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const requireOpaqueId = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : invalid();

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Display form of an economic number (internal fleet number): trimmed, original case. */
export function normalizeEconomicNumber(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return ECONOMIC_NUMBER.test(text) ? text : invalid();
}

/** Uniqueness key of an economic number: case-insensitive. */
export const economicNumberKey = (economicNumber: string): string => economicNumber.toLowerCase();

/** Display form of a plate: upper case, single spaces. */
export function normalizePlate(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, ' ') : '';
  return PLATE.test(text) ? text : invalid();
}

/** Uniqueness key of a plate: `AB-123 C`, `ab 123c` and `AB123C` are the same plate. */
export const plateKey = (plate: string): string => plate.replace(/[ -]/g, '');

export function normalizeVin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return VIN.test(text) ? text : invalid();
}

function normalizeLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return LABEL.test(text) ? text : invalid();
}

function normalizeYear(value: unknown, now: Date): number {
  return isInteger(value, MIN_MODEL_YEAR, now.getUTCFullYear() + 1) ? value : invalid();
}

function normalizeOdometer(value: unknown): number {
  return isInteger(value, 0, MAX_ODOMETER_KM) ? value : invalid();
}

export const dateOf = (now: Date): string => now.toISOString().slice(0, 10);

function normalizeRegisteredOn(value: unknown, now: Date): string {
  if (value === undefined) return dateOf(now);
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOf(parsed) !== value || value > dateOf(now))
    return invalid();
  return value;
}

/** A status-change reason (BR-004): required, one line, at most 200 characters. */
export function normalizeReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= 1 && text.length <= MAX_REASON_LENGTH && !CONTROL.test(text)
    ? text
    : invalid();
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

export const CREATE_FIELDS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
  'odometerKm',
  'registeredOn',
] as const;
export const UPDATE_FIELDS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
] as const;

export type VehicleCore = Pick<
  Vehicle,
  'economicNumber' | 'plate' | 'vin' | 'make' | 'model' | 'year' | 'areaId'
>;
export type NewVehicleData = VehicleCore & Pick<Vehicle, 'odometerKm' | 'registeredOn'>;

/** Validates and normalizes the data of a new vehicle. Unknown properties are rejected. */
export function parseNewVehicle(input: unknown, now: Date): NewVehicleData {
  const fields = asFields(input, CREATE_FIELDS);
  const required = ['economicNumber', 'plate', 'make', 'model', 'year', 'areaId', 'odometerKm'];
  if (required.some((key) => !Object.hasOwn(fields, key))) return invalid();
  return {
    economicNumber: normalizeEconomicNumber(fields['economicNumber']),
    plate: normalizePlate(fields['plate']),
    vin: normalizeVin(fields['vin']),
    make: normalizeLabel(fields['make']),
    model: normalizeLabel(fields['model']),
    year: normalizeYear(fields['year'], now),
    areaId: requireOpaqueId(fields['areaId']),
    odometerKm: normalizeOdometer(fields['odometerKm']),
    registeredOn: normalizeRegisteredOn(fields['registeredOn'], now),
  };
}

/** Validates a partial update; only the fields that are present are returned. */
export function parseVehiclePatch(input: unknown, now: Date): Partial<VehicleCore> {
  const fields = asFields(input, UPDATE_FIELDS);
  if (Object.keys(fields).length === 0) return invalid();
  const patch: { -readonly [K in keyof VehicleCore]?: VehicleCore[K] } = {};
  if (Object.hasOwn(fields, 'economicNumber'))
    patch.economicNumber = normalizeEconomicNumber(fields['economicNumber']);
  if (Object.hasOwn(fields, 'plate')) patch.plate = normalizePlate(fields['plate']);
  if (Object.hasOwn(fields, 'vin')) patch.vin = normalizeVin(fields['vin']);
  if (Object.hasOwn(fields, 'make')) patch.make = normalizeLabel(fields['make']);
  if (Object.hasOwn(fields, 'model')) patch.model = normalizeLabel(fields['model']);
  if (Object.hasOwn(fields, 'year')) patch.year = normalizeYear(fields['year'], now);
  if (Object.hasOwn(fields, 'areaId')) patch.areaId = requireOpaqueId(fields['areaId']);
  return patch;
}

export const requireVersion = (value: unknown): number =>
  isInteger(value, 1, 2_147_483_646) ? value : invalid();

// ---- pure state changes ---------------------------------------------------------------------

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

// ---- store port ----------------------------------------------------------------------------

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

/** The vehicles that block deactivating their area (see `VehicleStore.countLiveInArea`). */
export const isLiveVehicle = (vehicle: Pick<Vehicle, 'status' | 'archivedAt'>): boolean =>
  vehicle.archivedAt === null && vehicle.status !== 'decommissioned';

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

// ---- service -------------------------------------------------------------------------------

export interface VehicleListQuery {
  readonly status?: unknown;
  readonly areaId?: unknown;
  readonly includeArchived?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface VehicleServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * Vehicle use cases over the store port. Authorization, authentication and audit belong to the
 * caller (the composition); this class only enforces the domain rules. The tenant is always an
 * argument supplied by the server-side session, never part of the input being validated.
 */
export class VehicleService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  public constructor(
    private readonly store: VehicleStore,
    options: VehicleServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** The vehicle of this tenant, or `not_found` (also for ids of other tenants). */
  private async load(tenantId: string, id: unknown): Promise<Vehicle> {
    const vehicle = await this.store.find(requireOpaqueId(tenantId), requireOpaqueId(id));
    if (vehicle?.tenantId !== tenantId) throw new VehicleError('not_found');
    return vehicle;
  }

  /** Writes `next`; a lost race reads as `stale_version` (or `not_found` when the row is gone). */
  private async commit(
    next: Vehicle,
    expectedVersion: number,
    entry?: VehicleStatusEntry,
  ): Promise<Vehicle> {
    if (await this.store.replace(next, expectedVersion, entry)) return next;
    const current = await this.store.find(next.tenantId, next.id);
    throw new VehicleError(current ? 'stale_version' : 'not_found');
  }

  public async create(tenantId: string, actorId: string, input: unknown): Promise<Vehicle> {
    requireOpaqueId(tenantId);
    requireOpaqueId(actorId);
    const now = this.now();
    const vehicle = newVehicle(tenantId, this.newId(), parseNewVehicle(input, now), now);
    await this.store.insert(vehicle, statusEntry(vehicle, null, this.newId(), actorId, now));
    return vehicle;
  }

  public get(tenantId: string, id: unknown): Promise<Vehicle> {
    return this.load(tenantId, id);
  }

  public async list(tenantId: string, query: VehicleListQuery = {}): Promise<VehicleSlice> {
    requireOpaqueId(tenantId);
    const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
    const offset = query.offset === undefined ? 0 : query.offset;
    if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
    if (query.status !== undefined && !isVehicleStatus(query.status)) return invalid();
    if (query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean')
      return invalid();
    const filter: VehicleFilter = {
      includeArchived: query.includeArchived ?? false,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.areaId === undefined ? {} : { areaId: requireOpaqueId(query.areaId) }),
    };
    return this.store.list(tenantId, filter, { limit, offset });
  }

  public async update(
    tenantId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<Vehicle> {
    const now = this.now();
    const patch = parseVehiclePatch(input, now);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyPatch(current, patch, version, now), version);
  }

  public async changeStatus(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    status: unknown,
    reason: unknown,
  ): Promise<Vehicle> {
    requireOpaqueId(actorId);
    const now = this.now();
    if (!isVehicleStatus(status)) return invalid();
    const text = normalizeReason(reason);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    const next = applyStatus(current, status, text, version, now);
    return this.commit(
      next,
      version,
      statusEntry(next, current.status, this.newId(), actorId, now),
    );
  }

  public async recordOdometer(
    tenantId: string,
    id: unknown,
    expectedVersion: unknown,
    odometerKm: unknown,
  ): Promise<Vehicle> {
    const reading = normalizeOdometer(odometerKm);
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    const next = applyOdometer(current, reading, version, this.now());
    return next === current ? current : this.commit(next, version);
  }

  public async archive(tenantId: string, id: unknown, expectedVersion: unknown): Promise<Vehicle> {
    const version = requireVersion(expectedVersion);
    const current = await this.load(tenantId, id);
    return this.commit(applyArchive(current, version, this.now()), version);
  }

  public async history(tenantId: string, id: unknown): Promise<readonly VehicleStatusEntry[]> {
    const vehicle = await this.load(tenantId, id);
    return this.store.history(tenantId, vehicle.id);
  }
}
