import type {
  BffRouteId,
  BffWorkOrder,
  BffWorkOrderTransition,
} from '../../../../../packages/contracts/src/index.js';
import type { WorkOrderApiResponse } from '../../../maintenance/orders/src/index.js';
import type { BffResponse } from '../http.js';
import type { Route, RouteContext } from './shared.js';
import { ID, bad, body, failure, route, success } from './shared.js';

const COMMANDS = {
  assign: 'assign',
  start: 'start',
  complete: 'complete',
  approve_close: 'approveClose',
  close: 'close',
  cancel: 'cancel',
  reopen: 'reopen',
} as const;
const TRANSITION_FIELDS = [
  'command',
  'version',
  'responsibleId',
  'workshopId',
  'mechanicId',
  'scheduledDate',
  'requiresWorkshop',
  'actualDate',
  'actualKm',
  'vehicleStatus',
  'comment',
  'reason',
] as const;

const answer = async <T>(
  ctx: RouteContext,
  result: Promise<WorkOrderApiResponse<T>>,
  id: BffRouteId,
): Promise<BffResponse> => {
  const resolved = await result;
  if (!resolved.ok || resolved.value === undefined) return failure(ctx, resolved.error);
  return success(ctx, id, resolved.value as never);
};
const orderId = (ctx: RouteContext) => ctx.params['orderId'] as string;
const api = (ctx: RouteContext) => ctx.platform.workOrders;

export const WORK_ORDER_ROUTES: readonly Route[] = [
  route('workOrders.list', async (ctx) =>
    answer<readonly BffWorkOrder[]>(
      ctx,
      api(ctx).list(ctx.token as string, ctx.correlationId),
      'workOrders.list',
    ),
  ),
  route('workOrders.create', async (ctx) => {
    const input = body(ctx, ['vehicleId', 'description']);
    if (!input) return bad(ctx);
    return answer(
      ctx,
      api(ctx).createCorrective(ctx.token as string, ctx.correlationId, input),
      'workOrders.create',
    );
  }),
  route('workOrders.adopt', async (ctx) => {
    const input = body(ctx, ['planId', 'scheduledOrderId']);
    if (!input) return bad(ctx);
    return answer(
      ctx,
      api(ctx).adoptPreventive(ctx.token as string, ctx.correlationId, input),
      'workOrders.adopt',
    );
  }),
  route(
    'workOrders.get',
    async (ctx) =>
      answer(
        ctx,
        api(ctx).get(ctx.token as string, ctx.correlationId, orderId(ctx)),
        'workOrders.get',
      ),
    { orderId: ID },
  ),
  route(
    'workOrders.history',
    async (ctx) =>
      answer<readonly BffWorkOrderTransition[]>(
        ctx,
        api(ctx).history(ctx.token as string, ctx.correlationId, orderId(ctx)),
        'workOrders.history',
      ),
    { orderId: ID },
  ),
  route(
    'workOrders.transition',
    async (ctx) => {
      const input = body(ctx, TRANSITION_FIELDS, ['command', 'version']);
      const command = input?.['command'];
      if (!input || typeof command !== 'string' || !Object.hasOwn(COMMANDS, command))
        return bad(ctx);
      const fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'command'));
      return answer(
        ctx,
        api(ctx).command(
          ctx.token as string,
          ctx.correlationId,
          COMMANDS[command as keyof typeof COMMANDS],
          orderId(ctx),
          fields,
        ),
        'workOrders.transition',
      );
    },
    { orderId: ID },
  ),
  route(
    'workOrders.work',
    async (ctx) => {
      const input = body(ctx, ['version', 'description', 'tasks', 'parts'], ['version']);
      if (!input) return bad(ctx);
      return answer(
        ctx,
        api(ctx).command(ctx.token as string, ctx.correlationId, 'updateWork', orderId(ctx), input),
        'workOrders.work',
      );
    },
    { orderId: ID },
  ),
  route(
    'workOrders.costs',
    async (ctx) => {
      const input = body(ctx, ['version', 'costs', 'partCosts'], ['version']);
      if (!input) return bad(ctx);
      return answer(
        ctx,
        api(ctx).command(
          ctx.token as string,
          ctx.correlationId,
          'updateCosts',
          orderId(ctx),
          input,
        ),
        'workOrders.costs',
      );
    },
    { orderId: ID },
  ),
];
