import type {
  Permission,
  TenantContext,
} from '../../../../../packages/domain/identity/src/index.js';
import { MaintenancePlanError } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import type {
  MaintenancePlan,
  MaintenancePlanSchedule,
  PlanOccurrence,
  PlanInput,
  ScheduledMaintenanceOrder,
} from '../../../../../packages/domain/maintenance/plans/src/index.js';
import type { Workshop } from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import type { Mechanic } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import type { MaintenancePlanService } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import type { WorkshopService } from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import type { MechanicService } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { ownMechanics, visibleWorkshops, type MaintenanceScope } from './mechanic-scope.js';

export type MaintenanceApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'internal_error';
export interface MaintenanceApiResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly code: MaintenanceApiErrorCode;
    readonly status: number;
    readonly message: string;
  };
}
export type MaintenancePlanView = Omit<MaintenancePlan, 'tenantId'>;
export type WorkshopView = Omit<Workshop, 'tenantId'>;
export type MechanicView = Omit<Mechanic, 'tenantId'>;
export type PlanOccurrenceView = Omit<PlanOccurrence, 'tenantId'>;
export type ScheduledMaintenanceOrderView = Omit<ScheduledMaintenanceOrder, 'tenantId'>;
export type MaintenancePlanScheduleView = Omit<MaintenancePlanSchedule, 'occurrence' | 'order'> & {
  readonly occurrence: PlanOccurrenceView | null;
  readonly order: ScheduledMaintenanceOrderView | null;
};
export interface MaintenanceApiDeps {
  readonly plans: MaintenancePlanService;
  readonly workshops: WorkshopService;
  readonly mechanics: MechanicService;
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
  /** D9: mechanic-scoped callers read only their own mechanic and workshop records, no plans. */
  readonly scope?: MaintenanceScope['resolve'];
}

const PERMISSIONS = {
  read: ['view'],
  create: ['create'],
  edit: ['edit'],
} as const satisfies Record<string, readonly Permission[]>;
const statusOf: Readonly<Record<MaintenanceApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  internal_error: 500,
};
function fail(error: unknown): MaintenanceApiResponse<never> {
  let code: MaintenanceApiErrorCode = 'internal_error';
  const value =
    error instanceof MaintenancePlanError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : '';
  if (value === 'invalid_input') code = 'invalid_input';
  else if (value === 'not_found') code = 'not_found';
  else if (
    [
      'duplicate',
      'stale_version',
      'invalid_transition',
      'invalid_association',
      'odometer_decrease',
      'immutable',
    ].includes(value)
  )
    code = 'conflict';
  else if (value === 'unauthorized' || value === 'expired') code = 'unauthorized';
  else if (value === 'forbidden') code = 'forbidden';
  return {
    ok: false,
    error: {
      code,
      status: statusOf[code],
      message:
        code === 'internal_error' ? 'Request failed' : `Maintenance request rejected: ${code}`,
    },
  };
}
const ok = <T>(value: T): MaintenanceApiResponse<T> => ({ ok: true, value });
const withoutTenant = <T extends { readonly tenantId: string }>(value: T): Omit<T, 'tenantId'> => {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'tenantId')) as Omit<
    T,
    'tenantId'
  >;
};

/** Authenticates and authorizes each operation; tenant and actor come only from the current session. */
export class MaintenanceApi {
  public constructor(private readonly deps: MaintenanceApiDeps) {}
  private actor(context: TenantContext): string {
    return `user-${context.actor.subject}`;
  }
  private async scoped(context: TenantContext): Promise<boolean> {
    return (await this.deps.scope?.(context))?.scoped === true;
  }
  private async scopedMechanics(context: TenantContext) {
    return ownMechanics(await this.deps.mechanics.list(context.tenantId), context.actor.subject);
  }
  private async scopedWorkshops(context: TenantContext) {
    return visibleWorkshops(
      await this.deps.workshops.list(context.tenantId),
      await this.scopedMechanics(context),
    );
  }
  private async run<T>(
    token: string,
    correlationId: string,
    permission: readonly Permission[],
    work: (context: TenantContext) => Promise<T>,
  ): Promise<MaintenanceApiResponse<T>> {
    try {
      const context = await this.deps.authorize(token, correlationId, permission);
      return ok(await work(context));
    } catch (error) {
      return fail(error);
    }
  }
  private async runPublic<T extends { readonly tenantId: string }, V = Omit<T, 'tenantId'>>(
    token: string,
    correlationId: string,
    permission: readonly Permission[],
    work: (context: TenantContext) => Promise<T>,
  ): Promise<MaintenanceApiResponse<V>> {
    const result = await this.run(token, correlationId, permission, work);
    if (!result.ok || result.value === undefined)
      return result as unknown as MaintenanceApiResponse<V>;
    return ok(withoutTenant(result.value) as V);
  }
  private async runPublicList<T extends { readonly tenantId: string }>(
    token: string,
    correlationId: string,
    work: (context: TenantContext) => Promise<readonly T[]>,
  ): Promise<MaintenanceApiResponse<readonly Omit<T, 'tenantId'>[]>> {
    const result = await this.run(token, correlationId, PERMISSIONS.read, work);
    if (!result.ok || result.value === undefined)
      return result as MaintenanceApiResponse<readonly Omit<T, 'tenantId'>[]>;
    return ok(result.value.map(withoutTenant));
  }
  public createPlan(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<MaintenanceApiResponse<MaintenancePlanView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.create, (c) =>
      this.deps.plans.create(c.tenantId, this.actor(c), input),
    );
  }
  public getPlan(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<MaintenanceApiResponse<MaintenancePlanView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.read, async (c) => {
      if (await this.scoped(c)) throw new MaintenancePlanError('not_found');
      return this.deps.plans.get(c.tenantId, id);
    });
  }
  public listPlans(
    token: string,
    correlationId: string,
  ): Promise<MaintenanceApiResponse<readonly MaintenancePlanView[]>> {
    return this.runPublicList(token, correlationId, async (c) =>
      (await this.scoped(c)) ? [] : this.deps.plans.list(c.tenantId),
    );
  }
  public getPlanSchedule(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<MaintenanceApiResponse<MaintenancePlanScheduleView>> {
    return this.run(token, correlationId, PERMISSIONS.read, async (context) => {
      if (await this.scoped(context)) throw new MaintenancePlanError('not_found');
      const schedule = await this.deps.plans.getSchedule(context.tenantId, id);
      return {
        ...schedule,
        occurrence: schedule.occurrence ? withoutTenant(schedule.occurrence) : null,
        order: schedule.order ? withoutTenant(schedule.order) : null,
      };
    });
  }
  public listScheduledOrders(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<MaintenanceApiResponse<readonly ScheduledMaintenanceOrderView[]>> {
    return this.run(token, correlationId, PERMISSIONS.read, async (context) => {
      if (await this.scoped(context)) throw new MaintenancePlanError('not_found');
      return (await this.deps.plans.listScheduledOrders(context.tenantId, id)).map(withoutTenant);
    });
  }
  public updatePlan(
    token: string,
    correlationId: string,
    id: string,
    version: unknown,
    input: unknown,
  ): Promise<MaintenanceApiResponse<MaintenancePlanView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.edit, (c) =>
      this.deps.plans.update(c.tenantId, this.actor(c), id, version, input),
    );
  }
  public pausePlan(
    token: string,
    correlationId: string,
    id: string,
    version: unknown,
  ): Promise<MaintenanceApiResponse<MaintenancePlanView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.edit, (c) =>
      this.deps.plans.pause(c.tenantId, this.actor(c), id, version),
    );
  }
  public resumePlan(
    token: string,
    correlationId: string,
    id: string,
    version: unknown,
  ): Promise<MaintenanceApiResponse<MaintenancePlanView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.edit, (c) =>
      this.deps.plans.resume(c.tenantId, this.actor(c), id, version),
    );
  }
  public createWorkshop(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<MaintenanceApiResponse<WorkshopView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.create, (c) =>
      this.deps.workshops.create(c.tenantId, this.actor(c), input),
    );
  }
  public getWorkshop(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<MaintenanceApiResponse<WorkshopView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.read, async (c) => {
      if (!(await this.scoped(c))) return this.deps.workshops.get(c.tenantId, id);
      const visible = await this.scopedWorkshops(c);
      const found = visible.find((w) => w.id === id);
      if (!found) throw new MaintenancePlanError('not_found');
      return found;
    });
  }
  public listWorkshops(
    token: string,
    correlationId: string,
  ): Promise<MaintenanceApiResponse<readonly WorkshopView[]>> {
    return this.runPublicList(token, correlationId, async (c) =>
      (await this.scoped(c)) ? this.scopedWorkshops(c) : this.deps.workshops.list(c.tenantId),
    );
  }
  public updateWorkshop(
    token: string,
    correlationId: string,
    id: string,
    input: unknown,
  ): Promise<MaintenanceApiResponse<WorkshopView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.edit, (c) =>
      this.deps.workshops.update(c.tenantId, this.actor(c), id, input),
    );
  }
  public deactivateWorkshop(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<MaintenanceApiResponse<WorkshopView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.edit, (c) =>
      this.deps.workshops.deactivate(c.tenantId, this.actor(c), id),
    );
  }
  public createMechanic(
    token: string,
    correlationId: string,
    input: unknown,
  ): Promise<MaintenanceApiResponse<MechanicView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.create, (c) =>
      this.deps.mechanics.create(c.tenantId, this.actor(c), input),
    );
  }
  public getMechanic(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<MaintenanceApiResponse<MechanicView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.read, async (c) => {
      if (!(await this.scoped(c))) return this.deps.mechanics.get(c.tenantId, id);
      const found = (await this.scopedMechanics(c)).find((m) => m.id === id);
      if (!found) throw new MaintenancePlanError('not_found');
      return found;
    });
  }
  public listMechanics(
    token: string,
    correlationId: string,
  ): Promise<MaintenanceApiResponse<readonly MechanicView[]>> {
    return this.runPublicList(token, correlationId, async (c) =>
      (await this.scoped(c)) ? this.scopedMechanics(c) : this.deps.mechanics.list(c.tenantId),
    );
  }
  public updateMechanic(
    token: string,
    correlationId: string,
    id: string,
    input: unknown,
  ): Promise<MaintenanceApiResponse<MechanicView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.edit, (c) =>
      this.deps.mechanics.update(c.tenantId, this.actor(c), id, input),
    );
  }
  public deactivateMechanic(
    token: string,
    correlationId: string,
    id: string,
  ): Promise<MaintenanceApiResponse<MechanicView>> {
    return this.runPublic(token, correlationId, PERMISSIONS.edit, (c) =>
      this.deps.mechanics.deactivate(c.tenantId, this.actor(c), id),
    );
  }
}

export type { PlanInput };
