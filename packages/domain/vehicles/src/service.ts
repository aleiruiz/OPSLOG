import { randomUUID } from 'node:crypto';
import { VehicleError } from './errors.js';
import {
  type VehicleAreaGate,
  type VehicleFilter,
  type VehicleSlice,
  type VehicleStore,
} from './ports.js';
import {
  applyArchive,
  applyOdometer,
  applyPatch,
  applyStatus,
  newVehicle,
  statusEntry,
} from './rules.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  isVehicleStatus,
  type Vehicle,
  type VehicleStatusEntry,
} from './types.js';
import {
  invalid,
  isInteger,
  normalizeOdometer,
  normalizeReason,
  parseNewVehicle,
  parseVehiclePatch,
  requireOpaqueId,
  requireVersion,
} from './validation.js';

export interface VehicleListQuery {
  readonly status?: unknown;
  readonly areaId?: unknown;
  readonly includeArchived?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface VehicleServiceOptions {
  /**
   * Validates and serializes writes that set or change `areaId`. Without it the area is not
   * checked (only for tests of this package); the platform composition always supplies it.
   */
  readonly areas?: VehicleAreaGate;
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
  private readonly areas: VehicleAreaGate | undefined;

  public constructor(
    private readonly store: VehicleStore,
    options: VehicleServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.areas = options.areas;
  }

  /** Runs a write that sets `areaId` under the area gate (a no-op wrapper without one). */
  private inArea<T>(tenantId: string, areaId: string, work: () => Promise<T>): Promise<T> {
    return this.areas ? this.areas.withActiveArea(tenantId, areaId, work) : work();
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
    const entry = statusEntry(vehicle, null, this.newId(), actorId, now);
    await this.inArea(tenantId, vehicle.areaId, () => this.store.insert(vehicle, entry));
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
    const next = applyPatch(current, patch, version, now);
    // Only a different area is validated: a vehicle may keep an area that was deactivated since.
    return next.areaId === current.areaId
      ? this.commit(next, version)
      : this.inArea(tenantId, next.areaId, () => this.commit(next, version));
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
