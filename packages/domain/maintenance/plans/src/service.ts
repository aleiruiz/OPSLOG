import { randomUUID } from 'node:crypto';
import { MaintenancePlanError } from './errors.js';
import { makePlan, opaqueId, parsePlanInput, patchPlan, targets } from './rules.js';
import type {
  MaintenancePlan,
  MaintenancePlanSchedule,
  PlanInput,
  PlanScheduleReader,
  PlanStore,
  ScheduledMaintenanceOrder,
} from './types.js';

export interface PlanServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly scheduleReader?: PlanScheduleReader;
  readonly references?: {
    readonly vehicleExists: (tenantId: string, vehicleId: string) => Promise<boolean>;
    readonly validateAssignments: (
      tenantId: string,
      workshopId: string | null,
      mechanicId: string | null,
    ) => Promise<void>;
  };
}

export class MaintenancePlanService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly references: PlanServiceOptions['references'];
  private readonly scheduleReader: PlanServiceOptions['scheduleReader'];
  public constructor(
    private readonly store: PlanStore,
    options: PlanServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.references = options.references;
    this.scheduleReader = options.scheduleReader;
  }
  public async create(tenantId: string, actorId: string, input: unknown): Promise<MaintenancePlan> {
    const tenant = opaqueId(tenantId);
    const value = parsePlanInput(input);
    await this.validateReferences(tenant, value);
    return this.store.create(makePlan(tenant, this.newId(), value, this.now()), opaqueId(actorId));
  }
  public async get(tenantId: string, id: unknown): Promise<MaintenancePlan> {
    const plan = await this.store.get(opaqueId(tenantId), opaqueId(id));
    if (!plan) throw new MaintenancePlanError('not_found');
    return plan;
  }
  public list(tenantId: string): Promise<readonly MaintenancePlan[]> {
    return this.store.list(opaqueId(tenantId));
  }
  public async getSchedule(tenantId: string, id: unknown): Promise<MaintenancePlanSchedule> {
    const plan = await this.get(tenantId, id);
    if (this.scheduleReader) return this.scheduleReader.readSchedule(plan.tenantId, plan.id);
    const { targetDate, targetKm } = targets(plan);
    return {
      planId: plan.id,
      nextTargetDate: targetDate,
      nextTargetKm: targetKm,
      occurrence: null,
      order: null,
    };
  }
  public async listScheduledOrders(
    tenantId: string,
    id: unknown,
  ): Promise<readonly ScheduledMaintenanceOrder[]> {
    const plan = await this.get(tenantId, id);
    return this.scheduleReader
      ? this.scheduleReader.listScheduledOrders(plan.tenantId, plan.id)
      : [];
  }
  public async update(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<MaintenancePlan> {
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
      throw new MaintenancePlanError('invalid_input');
    const current = await this.get(tenantId, id);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new MaintenancePlanError('invalid_input');
    const patch = input as Record<string, unknown>;
    if (patch['vehicleId'] !== undefined && patch['vehicleId'] !== current.vehicleId)
      throw new MaintenancePlanError('invalid_input');
    const editable: PlanInput = {
      vehicleId: current.vehicleId,
      ...(current.intervalDays === undefined ? {} : { intervalDays: current.intervalDays }),
      ...(current.intervalKm === undefined ? {} : { intervalKm: current.intervalKm }),
      ...(current.lastServiceDate === undefined
        ? {}
        : { lastServiceDate: current.lastServiceDate }),
      ...(current.lastServiceKm === undefined ? {} : { lastServiceKm: current.lastServiceKm }),
      ...(current.defaultWorkshopId === undefined
        ? {}
        : { defaultWorkshopId: current.defaultWorkshopId }),
      ...(current.defaultMechanicId === undefined
        ? {}
        : { defaultMechanicId: current.defaultMechanicId }),
    };
    const value = parsePlanInput({ ...editable, ...patch, vehicleId: current.vehicleId });
    await this.validateReferences(current.tenantId, { ...current, ...value });
    const next = patchPlan(current, value, this.now());
    if (!(await this.store.update(next, expectedVersion as number, opaqueId(actorId))))
      throw new MaintenancePlanError('stale_version');
    return next;
  }
  private async state(
    tenantId: string,
    actorId: string,
    id: unknown,
    version: unknown,
    state: 'active' | 'paused',
  ): Promise<MaintenancePlan> {
    if (!Number.isInteger(version) || (version as number) < 1)
      throw new MaintenancePlanError('invalid_input');
    const current = await this.get(tenantId, id);
    if (current.version !== version) throw new MaintenancePlanError('stale_version');
    const next = {
      ...current,
      state,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.store.update(next, current.version, opaqueId(actorId))))
      throw new MaintenancePlanError('stale_version');
    return next;
  }
  public pause(
    tenantId: string,
    actorId: string,
    id: unknown,
    version: unknown,
  ): Promise<MaintenancePlan> {
    return this.state(tenantId, actorId, id, version, 'paused');
  }
  public resume(
    tenantId: string,
    actorId: string,
    id: unknown,
    version: unknown,
  ): Promise<MaintenancePlan> {
    return this.state(tenantId, actorId, id, version, 'active');
  }
  private async validateReferences(tenantId: string, input: PlanInput): Promise<void> {
    if (!this.references) return;
    if (!(await this.references.vehicleExists(tenantId, input.vehicleId)))
      throw new MaintenancePlanError('not_found');
    await this.references.validateAssignments(
      tenantId,
      input.defaultWorkshopId ?? null,
      input.defaultMechanicId ?? null,
    );
  }
}

import { MaintenancePlanError as PlanFailure } from './errors.js';
import type {
  PlanEvaluation,
  PlanScanStore,
  PreventiveOrderClosedEvent,
  PreventiveOrderLifecycleEvent,
  VehicleMaintenanceReader,
} from './types.js';

export class MaintenancePlanWorker {
  public constructor(
    private readonly plans: PlanStore,
    private readonly scans: PlanScanStore,
    private readonly vehicles: VehicleMaintenanceReader,
    private readonly now = () => new Date(),
    /** Resolves the IANA zone of a tenant (company settings); UTC when not given. */
    private readonly timeZoneOf: (tenantId: string) => Promise<string> = async () => 'UTC',
  ) {}
  public async scan(tenantId: string, planId: string): Promise<readonly PlanEvaluation[]> {
    const plan = await this.plans.get(opaqueId(tenantId), opaqueId(planId));
    if (!plan) throw new PlanFailure('not_found');
    const vehicle = await this.vehicles.read(tenantId, plan.vehicleId);
    if (!vehicle || vehicle.id !== plan.vehicleId) throw new PlanFailure('not_found');
    return this.scans.scan(
      tenantId,
      planId,
      this.now(),
      vehicle.odometer,
      await this.timeZoneOf(tenantId),
    );
  }
  public consumeClosure(event: PreventiveOrderClosedEvent): Promise<void> {
    return this.scans.closePreventive(event);
  }
  public consumeReopened(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.scans.reopenPreventive(event);
  }
  public consumeCancelled(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.scans.cancelPreventive(event);
  }
  public consumeAdopted(event: PreventiveOrderLifecycleEvent): Promise<void> {
    return this.scans.adoptPreventive(event);
  }
}

export type { PlanInput };
