import {
  VehicleError,
  type Vehicle,
  type VehicleListQuery,
  type VehicleStatusEntry,
  type VehicleService,
} from '../../../../packages/domain/vehicles/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

export type VehicleApiErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_transition'
  | 'immutable'
  | 'odometer_decrease'
  | 'internal_error';

const STATUS: Readonly<Record<VehicleApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  duplicate: 409,
  stale_version: 409,
  invalid_transition: 409,
  immutable: 409,
  odometer_decrease: 422,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status, a generic message and, for a duplicate,
 * the name of the colliding field. Never a stack, an SQL fragment or a value from the request.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: VehicleApiErrorCode = 'internal_error';
  let field: string | undefined;
  if (error instanceof VehicleError) {
    code = error.code;
    field = error.field;
  } else if (error instanceof AuthError) {
    code =
      error.code === 'unauthorized' || error.code === 'expired'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'invalid_input'
            ? 'invalid_input'
            : 'internal_error';
  }
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Vehicle request rejected: ${code}`,
      ...(field === undefined ? {} : { field }),
    },
  };
}

/** What the browser may know about a vehicle. The company is never part of it. */
export interface VehicleView {
  readonly id: string;
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly status: Vehicle['status'];
  readonly statusReason: string;
  readonly odometerKm: number;
  readonly registeredOn: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface VehicleStatusEntryView {
  readonly id: string;
  readonly from: VehicleStatusEntry['from'];
  readonly to: VehicleStatusEntry['to'];
  readonly reason: string;
  readonly actorId: string;
  readonly version: number;
  readonly at: string;
}

export interface VehicleListView {
  readonly items: readonly VehicleView[];
  readonly total: number;
}

const view = (vehicle: Vehicle): VehicleView => ({
  id: vehicle.id,
  economicNumber: vehicle.economicNumber,
  plate: vehicle.plate,
  vin: vehicle.vin,
  make: vehicle.make,
  model: vehicle.model,
  year: vehicle.year,
  areaId: vehicle.areaId,
  status: vehicle.status,
  statusReason: vehicle.statusReason,
  odometerKm: vehicle.odometerKm,
  registeredOn: vehicle.registeredOn,
  version: vehicle.version,
  createdAt: vehicle.createdAt,
  updatedAt: vehicle.updatedAt,
  archivedAt: vehicle.archivedAt,
});

export type VehicleAuditAction =
  | 'vehicle.created'
  | 'vehicle.updated'
  | 'vehicle.status_changed'
  | 'vehicle.odometer_recorded'
  | 'vehicle.archived';

export interface VehiclesApiDeps {
  readonly service: VehicleService;
  /**
   * Authenticates the session (including the tenant gate), re-resolves the role and requires every
   * permission. The tenant and the actor of the returned context are the only ones ever used.
   */
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
  /** Appends an audit event of the session's tenant and actor. Entity ids only, never field values. */
  readonly audit: (
    context: TenantContext,
    action: VehicleAuditAction,
    entityId: string,
    correlationId: string,
  ) => void;
}

/**
 * Permissions per operation. The platform has no module-scoped permissions yet (open question in
 * the task document), so the generic ones are used: reading needs `view`, creating `create`,
 * every change of an existing vehicle `edit`, and archiving (soft delete) `delete`.
 */
export const VEHICLE_PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  change: ['edit'],
  archive: ['delete'],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * Vehicles use cases for the HTTP layer. Every call authenticates the session and re-resolves the
 * role (nothing is cached), takes the tenant only from that session, and audits successful writes.
 * Serialization of concurrent changes is the store's job (unique keys and versioned conditional
 * writes), so no tenant lock is needed here: unlike membership changes, no rule spans several rows.
 */
export class VehiclesApi {
  public constructor(private readonly deps: VehiclesApiDeps) {}

  private async write(
    token: string,
    correlationId: string,
    permissions: readonly Permission[],
    action: VehicleAuditAction,
    work: (context: TenantContext) => Promise<Vehicle>,
  ): Promise<PlatformResponse<VehicleView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, permissions);
      const vehicle = await work(context);
      this.deps.audit(context, action, vehicle.id, correlationId);
      return { ok: true, value: view(vehicle) };
    } catch (error) {
      return failure(error);
    }
  }

  private actorOf = (context: TenantContext): string => `user-${context.actor.subject}`;

  public create(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<PlatformResponse<VehicleView>> {
    return this.write(token, correlationId, VEHICLE_PERMISSIONS.create, 'vehicle.created', (c) =>
      this.deps.service.create(c.tenantId, this.actorOf(c), input),
    );
  }

  public update(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    patch: unknown,
  ): Promise<PlatformResponse<VehicleView>> {
    return this.write(token, correlationId, VEHICLE_PERMISSIONS.change, 'vehicle.updated', (c) =>
      this.deps.service.update(c.tenantId, id, version, patch),
    );
  }

  public changeStatus(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    status: unknown,
    reason: unknown,
  ): Promise<PlatformResponse<VehicleView>> {
    return this.write(
      token,
      correlationId,
      VEHICLE_PERMISSIONS.change,
      'vehicle.status_changed',
      (c) =>
        this.deps.service.changeStatus(c.tenantId, this.actorOf(c), id, version, status, reason),
    );
  }

  public recordOdometer(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
    odometerKm: unknown,
  ): Promise<PlatformResponse<VehicleView>> {
    return this.write(
      token,
      correlationId,
      VEHICLE_PERMISSIONS.change,
      'vehicle.odometer_recorded',
      (c) => this.deps.service.recordOdometer(c.tenantId, id, version, odometerKm),
    );
  }

  public archive(
    token: string,
    correlationId: string,
    id: unknown,
    version: unknown,
  ): Promise<PlatformResponse<VehicleView>> {
    return this.write(token, correlationId, VEHICLE_PERMISSIONS.archive, 'vehicle.archived', (c) =>
      this.deps.service.archive(c.tenantId, id, version),
    );
  }

  public async get(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<VehicleView>> {
    try {
      const context = await this.deps.authorize(token, correlationId, VEHICLE_PERMISSIONS.read);
      return { ok: true, value: view(await this.deps.service.get(context.tenantId, id)) };
    } catch (error) {
      return failure(error);
    }
  }

  public async list(
    token: string,
    correlationId: string,
    query: VehicleListQuery,
  ): Promise<PlatformResponse<VehicleListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, VEHICLE_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      return {
        ok: true,
        value: { tenantId: context.tenantId, items: slice.items.map(view), total: slice.total },
      };
    } catch (error) {
      return failure(error);
    }
  }

  public async history(
    token: string,
    correlationId: string,
    id: unknown,
  ): Promise<PlatformResponse<readonly VehicleStatusEntryView[]>> {
    try {
      const context = await this.deps.authorize(token, correlationId, VEHICLE_PERMISSIONS.read);
      const entries = await this.deps.service.history(context.tenantId, id);
      return {
        ok: true,
        value: entries.map((entry) => ({
          id: entry.id,
          from: entry.from,
          to: entry.to,
          reason: entry.reason,
          actorId: entry.actorId,
          version: entry.version,
          at: entry.at,
        })),
      };
    } catch (error) {
      return failure(error);
    }
  }
}
