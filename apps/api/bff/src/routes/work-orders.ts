import {
  BFF_IDEMPOTENCY_REQUIRED_COMMANDS,
  IDEMPOTENCY_KEY_HEADER,
  isIdempotencyKey,
  type BffRouteId,
  type BffWorkOrderCommand,
  BffWorkOrder,
  BffWorkOrderFile,
  BffWorkOrderFileContent,
  BffWorkOrderTransition,
} from '../../../../../packages/contracts/src/index.js';
import type { WorkOrderApiResponse } from '../../../maintenance/orders/src/index.js';
import { errorResponse, singleHeader, type BffResponse } from '../http.js';
import type { Route, RouteContext } from './shared.js';
import { ID, bad, body, failure, route, success } from './shared.js';

const COMMANDS: readonly BffWorkOrderCommand[] = [
  'assign',
  'start',
  'complete',
  'approve_close',
  'close',
  'cancel',
  'reopen',
];
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
  route(
    'workOrders.files.list',
    async (ctx) =>
      answer<readonly BffWorkOrderFile[]>(
        ctx,
        api(ctx).listFiles(ctx.token as string, ctx.correlationId, orderId(ctx)),
        'workOrders.files.list',
      ),
    { orderId: ID },
  ),
  route(
    'workOrders.files.upload',
    async (ctx) => {
      const input = body(ctx, ['version', 'kind', 'name', 'contentType', 'contentBase64']);
      if (!input) return bad(ctx);
      return answer(
        ctx,
        api(ctx).uploadFile(ctx.token as string, ctx.correlationId, orderId(ctx), input),
        'workOrders.files.upload',
      );
    },
    { orderId: ID },
  ),
  route(
    'workOrders.files.detach',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return answer(
        ctx,
        api(ctx).detachFile(
          ctx.token as string,
          ctx.correlationId,
          orderId(ctx),
          ctx.params['fileId'] as string,
          input,
        ),
        'workOrders.files.detach',
      );
    },
    { orderId: ID, fileId: ID },
  ),
  route(
    'workOrders.files.content',
    async (ctx) =>
      answer<BffWorkOrderFileContent>(
        ctx,
        api(ctx).fileContent(
          ctx.token as string,
          ctx.correlationId,
          orderId(ctx),
          ctx.params['fileId'] as string,
        ),
        'workOrders.files.content',
      ),
    { orderId: ID, fileId: ID },
  ),
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
      const command = input?.['command'] as BffWorkOrderCommand | undefined;
      if (!input || typeof command !== 'string' || !COMMANDS.includes(command)) return bad(ctx);
      // The key comes from the header only; a repeated or malformed header is a bad request.
      const key = singleHeader(ctx.headers, IDEMPOTENCY_KEY_HEADER);
      if (ctx.headers[IDEMPOTENCY_KEY_HEADER] !== undefined && !isIdempotencyKey(key))
        return bad(ctx);
      if (key === undefined && BFF_IDEMPOTENCY_REQUIRED_COMMANDS.includes(command))
        return errorResponse('idempotency_key_required', ctx.correlationId);
      const fields = Object.fromEntries(
        Object.entries(input).filter(([name]) => name !== 'command'),
      );
      return answer(
        ctx,
        api(ctx).transition(
          ctx.token as string,
          ctx.correlationId,
          command,
          orderId(ctx),
          fields,
          key,
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
