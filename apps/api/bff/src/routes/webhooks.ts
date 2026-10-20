import type {
  BffWebhookDelivery,
  BffWebhookDeliveryList,
  BffWebhookEndpoint,
  BffWebhookEndpointList,
  BffWebhookSecret,
} from '../../../../../packages/contracts/src/index.js';
import { respond } from '../http.js';
import { bad, body, failure, ID, route, success, type Route, type RouteContext } from './shared.js';

const COUNT = /^\d{1,7}$/;
const ENDPOINT = { endpointId: ID };

/** Only `limit` and `offset`, each once; anything else is a 400. */
function window(ctx: RouteContext): { limit?: number; offset?: number } | null {
  const keys = [...ctx.query.keys()];
  if (new Set(keys).size !== keys.length || keys.some((k) => k !== 'limit' && k !== 'offset'))
    return null;
  const limit = ctx.query.get('limit');
  const offset = ctx.query.get('offset');
  if ((limit !== null && !COUNT.test(limit)) || (offset !== null && !COUNT.test(offset)))
    return null;
  return {
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(offset === null ? {} : { offset: Number(offset) }),
  };
}

const token = (ctx: RouteContext): string => ctx.token as string;

export const WEBHOOK_BFF_ROUTES: readonly Route[] = [
  route('webhooks.list', async (ctx) => {
    const result = await ctx.platform.webhooks.api.list(token(ctx), ctx.correlationId);
    return result.ok
      ? success(ctx, 'webhooks.list', result.value as BffWebhookEndpointList)
      : failure(ctx, result.error);
  }),
  route('webhooks.create', async (ctx) => {
    const input = body(ctx, ['url', 'events', 'active'], ['url', 'events']);
    if (!input) return bad(ctx);
    const result = await ctx.platform.webhooks.api.create(token(ctx), ctx.correlationId, {
      url: input['url'],
      events: input['events'],
      active: input['active'],
    });
    return result.ok
      ? success(ctx, 'webhooks.create', result.value as BffWebhookSecret)
      : failure(ctx, result.error);
  }),
  route(
    'webhooks.get',
    async (ctx) => {
      const result = await ctx.platform.webhooks.api.get(
        token(ctx),
        ctx.correlationId,
        ctx.params['endpointId'] as string,
      );
      return result.ok
        ? success(ctx, 'webhooks.get', result.value as BffWebhookEndpoint)
        : failure(ctx, result.error);
    },
    ENDPOINT,
  ),
  route(
    'webhooks.update',
    async (ctx) => {
      const input = body(ctx, ['version', 'url', 'events', 'active'], ['version']);
      if (!input) return bad(ctx);
      const result = await ctx.platform.webhooks.api.update(
        token(ctx),
        ctx.correlationId,
        ctx.params['endpointId'] as string,
        {
          version: input['version'],
          url: input['url'],
          events: input['events'],
          active: input['active'],
        },
      );
      return result.ok
        ? success(ctx, 'webhooks.update', result.value as BffWebhookEndpoint)
        : failure(ctx, result.error);
    },
    ENDPOINT,
  ),
  route(
    'webhooks.delete',
    async (ctx) => {
      const result = await ctx.platform.webhooks.api.remove(
        token(ctx),
        ctx.correlationId,
        ctx.params['endpointId'] as string,
      );
      return result.ok ? respond(204, undefined, ctx.correlationId) : failure(ctx, result.error);
    },
    ENDPOINT,
  ),
  route(
    'webhooks.rotate',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      const result = await ctx.platform.webhooks.api.rotate(
        token(ctx),
        ctx.correlationId,
        ctx.params['endpointId'] as string,
        input['version'],
      );
      return result.ok
        ? success(ctx, 'webhooks.rotate', result.value as BffWebhookSecret)
        : failure(ctx, result.error);
    },
    ENDPOINT,
  ),
  route(
    'webhooks.test',
    async (ctx) => {
      const result = await ctx.platform.webhooks.api.test(
        token(ctx),
        ctx.correlationId,
        ctx.params['endpointId'] as string,
      );
      return result.ok
        ? success(ctx, 'webhooks.test', result.value as BffWebhookDelivery)
        : failure(ctx, result.error);
    },
    ENDPOINT,
  ),
  route(
    'webhooks.deliveries',
    async (ctx) => {
      const paging = window(ctx);
      if (!paging) return bad(ctx);
      const result = await ctx.platform.webhooks.api.deliveries(
        token(ctx),
        ctx.correlationId,
        ctx.params['endpointId'] as string,
        paging,
      );
      return result.ok
        ? success(ctx, 'webhooks.deliveries', result.value as BffWebhookDeliveryList)
        : failure(ctx, result.error);
    },
    ENDPOINT,
  ),
  route(
    'webhooks.retry',
    async (ctx) => {
      const result = await ctx.platform.webhooks.api.retry(
        token(ctx),
        ctx.correlationId,
        ctx.params['endpointId'] as string,
        ctx.params['deliveryId'] as string,
      );
      return result.ok
        ? success(ctx, 'webhooks.retry', result.value as BffWebhookDelivery)
        : failure(ctx, result.error);
    },
    { ...ENDPOINT, deliveryId: ID },
  ),
];
