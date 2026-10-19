import type {
  BffFailedDeliveryList,
  BffNotification,
  BffNotificationList,
  BffNotificationPreferences,
  BffNotificationRule,
  BffSubscription,
  BffSubscriptionList,
} from '../../../../../packages/contracts/src/index.js';
import { respond } from '../http.js';
import { bad, body, failure, ID, route, success, type Route, type RouteContext } from './shared.js';

const COUNT = /^\d{1,7}$/;
const KIND = /^[a-z_]{1,32}$/;
const TYPE = /^[a-z_]{1,24}$/;

/** Only these query names, each once; anything else is a 400. */
function query(ctx: RouteContext, allowed: readonly string[]): Map<string, string> | null {
  const keys = [...ctx.query.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !allowed.includes(key))) return null;
  return new Map(ctx.query);
}

function window(values: Map<string, string>): { limit?: number; offset?: number } | null {
  const limit = values.get('limit');
  const offset = values.get('offset');
  if ((limit !== undefined && !COUNT.test(limit)) || (offset !== undefined && !COUNT.test(offset)))
    return null;
  return {
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(offset === undefined ? {} : { offset: Number(offset) }),
  };
}

/** What the browser gets: the notice without its company or recipient (the API already drops them). */
const send = <T>(ctx: RouteContext, id: Parameters<typeof success>[1], value: T) =>
  success(ctx, id, value as never);

const SUBSCRIPTION = { type: TYPE, entityId: ID };

export const NOTIFICATION_ROUTES: readonly Route[] = [
  route('notifications.list', async (ctx) => {
    const values = query(ctx, ['unread', 'kind', 'limit', 'offset']);
    const paging = values && window(values);
    const unread = values?.get('unread');
    const kind = values?.get('kind');
    if (
      !values ||
      !paging ||
      (unread !== undefined && unread !== 'true' && unread !== 'false') ||
      (kind !== undefined && !KIND.test(kind))
    )
      return bad(ctx);
    const result = await ctx.platform.notifications.api.list(
      ctx.token as string,
      ctx.correlationId,
      {
        ...paging,
        ...(unread === undefined ? {} : { unreadOnly: unread === 'true' }),
        ...(kind === undefined ? {} : { kind }),
      },
    );
    if (!result.ok) return failure(ctx, result.error);
    return send<BffNotificationList>(ctx, 'notifications.list', {
      ...result.value,
      items: result.value.items as BffNotificationList['items'],
      offset: paging.offset ?? 0,
      limit: paging.limit ?? 25,
    });
  }),
  route('notifications.count', async (ctx) => {
    const result = await ctx.platform.notifications.api.count(
      ctx.token as string,
      ctx.correlationId,
    );
    return result.ok
      ? success(ctx, 'notifications.count', result.value)
      : failure(ctx, result.error);
  }),
  route('notifications.readAll', async (ctx) => {
    const result = await ctx.platform.notifications.api.markAllRead(
      ctx.token as string,
      ctx.correlationId,
    );
    return result.ok
      ? success(ctx, 'notifications.readAll', result.value)
      : failure(ctx, result.error);
  }),
  route(
    'notifications.read',
    async (ctx) => {
      const result = await ctx.platform.notifications.api.markRead(
        ctx.token as string,
        ctx.correlationId,
        ctx.params['notificationId'] as string,
      );
      return result.ok
        ? send<BffNotification>(ctx, 'notifications.read', result.value as BffNotification)
        : failure(ctx, result.error);
    },
    { notificationId: ID },
  ),
  route('notifications.preferences.get', async (ctx) => {
    const result = await ctx.platform.notifications.api.preferences(
      ctx.token as string,
      ctx.correlationId,
    );
    return result.ok
      ? send<BffNotificationPreferences>(
          ctx,
          'notifications.preferences.get',
          result.value as never,
        )
      : failure(ctx, result.error);
  }),
  route('notifications.preferences.update', async (ctx) => {
    const input = body(ctx, ['items']);
    if (!input) return bad(ctx);
    const result = await ctx.platform.notifications.api.savePreferences(
      ctx.token as string,
      ctx.correlationId,
      input['items'],
    );
    return result.ok
      ? send<BffNotificationPreferences>(
          ctx,
          'notifications.preferences.update',
          result.value as never,
        )
      : failure(ctx, result.error);
  }),
  route('notifications.subscriptions.list', async (ctx) => {
    const values = query(ctx, ['type']);
    if (!values) return bad(ctx);
    const result = await ctx.platform.notifications.api.subscriptions(
      ctx.token as string,
      ctx.correlationId,
      values.get('type'),
    );
    return result.ok
      ? send<BffSubscriptionList>(ctx, 'notifications.subscriptions.list', result.value as never)
      : failure(ctx, result.error);
  }),
  route(
    'notifications.subscribe',
    async (ctx) => {
      const result = await ctx.platform.notifications.api.subscribe(
        ctx.token as string,
        ctx.correlationId,
        ctx.params['type'],
        ctx.params['entityId'],
      );
      return result.ok
        ? send<BffSubscription>(ctx, 'notifications.subscribe', result.value as never)
        : failure(ctx, result.error);
    },
    SUBSCRIPTION,
  ),
  route(
    'notifications.unsubscribe',
    async (ctx) => {
      const result = await ctx.platform.notifications.api.unsubscribe(
        ctx.token as string,
        ctx.correlationId,
        ctx.params['type'],
        ctx.params['entityId'],
      );
      return result.ok ? respond(204, undefined, ctx.correlationId) : failure(ctx, result.error);
    },
    SUBSCRIPTION,
  ),
  route('notifications.rules.get', async (ctx) => {
    const result = await ctx.platform.notifications.api.rule(
      ctx.token as string,
      ctx.correlationId,
    );
    return result.ok
      ? send<BffNotificationRule>(ctx, 'notifications.rules.get', result.value as never)
      : failure(ctx, result.error);
  }),
  route('notifications.rules.update', async (ctx) => {
    const input = body(ctx, ['emailKinds', 'quietHours']);
    if (!input) return bad(ctx);
    const result = await ctx.platform.notifications.api.saveRule(
      ctx.token as string,
      ctx.correlationId,
      input,
    );
    return result.ok
      ? send<BffNotificationRule>(ctx, 'notifications.rules.update', result.value as never)
      : failure(ctx, result.error);
  }),
  route('notifications.deliveries.failed', async (ctx) => {
    const values = query(ctx, ['limit', 'offset']);
    const paging = values && window(values);
    if (!paging) return bad(ctx);
    const result = await ctx.platform.notifications.api.failedDeliveries(
      ctx.token as string,
      ctx.correlationId,
      paging,
    );
    if (!result.ok) return failure(ctx, result.error);
    return send<BffFailedDeliveryList>(ctx, 'notifications.deliveries.failed', {
      items: result.value.items as BffFailedDeliveryList['items'],
      total: result.value.total,
      offset: paging.offset ?? 0,
      limit: paging.limit ?? 25,
    });
  }),
];
