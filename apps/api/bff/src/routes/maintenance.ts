import type {
  BffMaintenanceMechanic,
  BffMaintenanceMechanicInput,
  BffMaintenancePlan,
  BffMaintenancePlanInput,
  BffMaintenancePlanPatch,
  BffMaintenanceWorkshop,
  BffMaintenanceWorkshopInput,
  BffRouteId,
} from '../../../../../packages/contracts/src/index.js';
import type {
  MaintenancePlanView,
  MaintenancePlanScheduleView,
  ScheduledMaintenanceOrderView,
  WorkshopView,
  MechanicView,
} from '../../../maintenance/plans/src/index.js';
import type { BffResponse } from '../http.js';
import type { Route, RouteContext } from './shared.js';
import { ID, bad, body, failure, route, success } from './shared.js';

const planView = (value: MaintenancePlanView): BffMaintenancePlan => ({
  ...value,
  defaultWorkshopId: value.defaultWorkshopId ?? null,
  defaultMechanicId: value.defaultMechanicId ?? null,
});
const workshopView = (value: WorkshopView): BffMaintenanceWorkshop => value;
const mechanicView = (value: MechanicView): BffMaintenanceMechanic => value;
type RouteResult<T> = {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly field?: string };
};
const write = async <T, V>(
  ctx: RouteContext,
  result: Promise<RouteResult<T>>,
  shape: (value: T) => V,
  id: BffRouteId,
): Promise<BffResponse> => {
  const resolved = await result;
  if (!resolved.ok || resolved.value === undefined) return failure(ctx, resolved.error);
  return success(ctx, id, shape(resolved.value) as never);
};

const PLAN_CREATE = [
  'vehicleId',
  'intervalDays',
  'intervalKm',
  'lastServiceDate',
  'lastServiceKm',
  'defaultWorkshopId',
  'defaultMechanicId',
] as const;
const PLAN_PATCH = [
  'version',
  'intervalDays',
  'intervalKm',
  'lastServiceDate',
  'lastServiceKm',
  'defaultWorkshopId',
  'defaultMechanicId',
] as const;
const WORKSHOP_FIELDS = ['name', 'specialties', 'contact'] as const;
const MECHANIC_FIELDS = [
  'name',
  'specialties',
  'contact',
  'kind',
  'workshopId',
  'memberId',
] as const;

export const MAINTENANCE_ROUTES: readonly Route[] = [
  route('maintenance.plans.list', async (ctx) =>
    write(
      ctx,
      ctx.platform.maintenance.listPlans(ctx.token as string, ctx.correlationId),
      (items) => items.map(planView),
      'maintenance.plans.list',
    ),
  ),
  route('maintenance.plans.create', async (ctx) => {
    const input = body(ctx, PLAN_CREATE, ['vehicleId']);
    if (!input) return bad(ctx);
    return write(
      ctx,
      ctx.platform.maintenance.createPlan(
        ctx.token as string,
        ctx.correlationId,
        input as BffMaintenancePlanInput,
      ),
      planView,
      'maintenance.plans.create',
    );
  }),
  route(
    'maintenance.plans.get',
    async (ctx) =>
      write(
        ctx,
        ctx.platform.maintenance.getPlan(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['planId'] as string,
        ),
        planView,
        'maintenance.plans.get',
      ),
    { planId: ID },
  ),
  route(
    'maintenance.plans.schedule',
    async (ctx) =>
      write(
        ctx,
        ctx.platform.maintenance.getPlanSchedule(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['planId'] as string,
        ),
        (value: MaintenancePlanScheduleView) => value,
        'maintenance.plans.schedule',
      ),
    { planId: ID },
  ),
  route(
    'maintenance.plans.orders',
    async (ctx) =>
      write(
        ctx,
        ctx.platform.maintenance.listScheduledOrders(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['planId'] as string,
        ),
        (items: readonly ScheduledMaintenanceOrderView[]) => items,
        'maintenance.plans.orders',
      ),
    { planId: ID },
  ),
  route(
    'maintenance.plans.update',
    async (ctx) => {
      const input = body(ctx, PLAN_PATCH, ['version']);
      if (!input || Object.keys(input).length < 2) return bad(ctx);
      const { version, ...patch } = input;
      return write(
        ctx,
        ctx.platform.maintenance.updatePlan(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['planId'] as string,
          version,
          patch as BffMaintenancePlanPatch,
        ),
        planView,
        'maintenance.plans.update',
      );
    },
    { planId: ID },
  ),
  route(
    'maintenance.plans.pause',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return write(
        ctx,
        ctx.platform.maintenance.pausePlan(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['planId'] as string,
          input['version'],
        ),
        planView,
        'maintenance.plans.pause',
      );
    },
    { planId: ID },
  ),
  route(
    'maintenance.plans.resume',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return write(
        ctx,
        ctx.platform.maintenance.resumePlan(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['planId'] as string,
          input['version'],
        ),
        planView,
        'maintenance.plans.resume',
      );
    },
    { planId: ID },
  ),
  route('maintenance.workshops.list', async (ctx) =>
    write(
      ctx,
      ctx.platform.maintenance.listWorkshops(ctx.token as string, ctx.correlationId),
      (items) => items.map(workshopView),
      'maintenance.workshops.list',
    ),
  ),
  route('maintenance.workshops.create', async (ctx) => {
    const input = body(ctx, WORKSHOP_FIELDS, ['name', 'specialties']);
    if (!input) return bad(ctx);
    return write(
      ctx,
      ctx.platform.maintenance.createWorkshop(
        ctx.token as string,
        ctx.correlationId,
        input as BffMaintenanceWorkshopInput,
      ),
      workshopView,
      'maintenance.workshops.create',
    );
  }),
  route(
    'maintenance.workshops.get',
    async (ctx) =>
      write(
        ctx,
        ctx.platform.maintenance.getWorkshop(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['workshopId'] as string,
        ),
        workshopView,
        'maintenance.workshops.get',
      ),
    { workshopId: ID },
  ),
  route(
    'maintenance.workshops.update',
    async (ctx) => {
      const input = body(ctx, WORKSHOP_FIELDS, ['name', 'specialties']);
      if (!input) return bad(ctx);
      return write(
        ctx,
        ctx.platform.maintenance.updateWorkshop(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['workshopId'] as string,
          input as BffMaintenanceWorkshopInput,
        ),
        workshopView,
        'maintenance.workshops.update',
      );
    },
    { workshopId: ID },
  ),
  route(
    'maintenance.workshops.deactivate',
    async (ctx) => {
      if (ctx.body.length !== 0) return bad(ctx);
      return write(
        ctx,
        ctx.platform.maintenance.deactivateWorkshop(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['workshopId'] as string,
        ),
        workshopView,
        'maintenance.workshops.deactivate',
      );
    },
    { workshopId: ID },
  ),
  route('maintenance.mechanics.list', async (ctx) =>
    write(
      ctx,
      ctx.platform.maintenance.listMechanics(ctx.token as string, ctx.correlationId),
      (items) => items.map(mechanicView),
      'maintenance.mechanics.list',
    ),
  ),
  route('maintenance.mechanics.create', async (ctx) => {
    const input = body(ctx, MECHANIC_FIELDS, ['name', 'specialties', 'kind']);
    if (!input) return bad(ctx);
    return write(
      ctx,
      ctx.platform.maintenance.createMechanic(
        ctx.token as string,
        ctx.correlationId,
        input as BffMaintenanceMechanicInput,
      ),
      mechanicView,
      'maintenance.mechanics.create',
    );
  }),
  route(
    'maintenance.mechanics.get',
    async (ctx) =>
      write(
        ctx,
        ctx.platform.maintenance.getMechanic(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['mechanicId'] as string,
        ),
        mechanicView,
        'maintenance.mechanics.get',
      ),
    { mechanicId: ID },
  ),
  route(
    'maintenance.mechanics.update',
    async (ctx) => {
      const input = body(ctx, MECHANIC_FIELDS, ['name', 'specialties', 'kind']);
      if (!input) return bad(ctx);
      return write(
        ctx,
        ctx.platform.maintenance.updateMechanic(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['mechanicId'] as string,
          input as BffMaintenanceMechanicInput,
        ),
        mechanicView,
        'maintenance.mechanics.update',
      );
    },
    { mechanicId: ID },
  ),
  route(
    'maintenance.mechanics.deactivate',
    async (ctx) => {
      if (ctx.body.length !== 0) return bad(ctx);
      return write(
        ctx,
        ctx.platform.maintenance.deactivateMechanic(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['mechanicId'] as string,
        ),
        mechanicView,
        'maintenance.mechanics.deactivate',
      );
    },
    { mechanicId: ID },
  ),
];
