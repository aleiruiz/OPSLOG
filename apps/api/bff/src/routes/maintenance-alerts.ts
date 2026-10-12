import type { BffMaintenanceAlert } from '../../../../../packages/contracts/src/index.js';
import type { SessionDetails } from '../../../composition/src/index.js';
import {
  ID,
  LIMITS,
  bad,
  failure,
  isOffsetCursor,
  route,
  success,
  type Route,
  type RouteContext,
} from './shared.js';

/** Strict query: unknown or repeated keys, bad values and cursors issued for other filters are a 400. */
function alertQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'planId', 'vehicleId']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const planId = ctx.query.get('planId');
  const vehicleId = ctx.query.get('vehicleId');
  if (
    limit === undefined ||
    (planId !== null && !ID.test(planId)) ||
    (vehicleId !== null && !ID.test(vehicleId))
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify(['maintenance-alerts', planId, vehicleId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      ...(planId === null ? {} : { planId }),
      ...(vehicleId === null ? {} : { vehicleId }),
    },
  };
}

export const MAINTENANCE_ALERT_ROUTES: readonly Route[] = [
  route('maintenance.alerts.list', async (ctx) => {
    const tenantId = (ctx.session as SessionDetails).tenantId;
    const parsed = alertQuery(ctx, tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.maintenance.listAlerts(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total } = result.value;
    const next = parsed.offset + parsed.limit;
    return success(ctx, 'maintenance.alerts.list', {
      items: items as readonly BffMaintenanceAlert[],
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'occurredAt', direction: 'desc' },
    });
  }),
];
