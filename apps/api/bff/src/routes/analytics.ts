import type { BffDashboardQuery } from '../../../../../packages/contracts/src/index.js';
import { route, ID, bad, reply, type Route, type RouteContext } from './shared.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Strict query: only `areaId`, `from` and `to`, each at most once and well formed; anything else is a 400. */
function dashboardQuery(ctx: RouteContext): BffDashboardQuery | null {
  const keys = [...ctx.query.keys()];
  const allowed = new Set(['areaId', 'from', 'to']);
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const areaId = ctx.query.get('areaId');
  const from = ctx.query.get('from');
  const to = ctx.query.get('to');
  if (
    (areaId !== null && !ID.test(areaId)) ||
    (from !== null && !DAY.test(from)) ||
    (to !== null && !DAY.test(to))
  )
    return null;
  return {
    ...(areaId === null ? {} : { areaId }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
  };
}

export const ANALYTICS_ROUTES: readonly Route[] = [
  route('dashboard.get', async (ctx) => {
    const query = dashboardQuery(ctx);
    if (!query) return bad(ctx);
    return reply(
      ctx,
      'dashboard.get',
      await ctx.platform.dashboard.get(ctx.token as string, ctx.correlationId, query),
      (dashboard) => dashboard,
    );
  }),
];
