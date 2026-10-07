import {
  BFF_ALERT_SEVERITIES,
  BFF_ALERT_SOURCES,
  type BffAlert,
  type BffAlertPage,
  type BffAlertSeverity,
  type BffAlertSource,
} from '../../../../../packages/contracts/src/index.js';
import type { SessionDetails } from '../../../composition/src/index.js';
import { MAX_ALERT_OFFSET } from '../../../composition/src/index.js';
import {
  route,
  ID,
  failure,
  success,
  reply,
  body,
  bad,
  LIMITS,
  isOffsetCursor,
  type Route,
  type RouteContext,
} from './shared.js';

/** Strict query of the alert listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function alertQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'source', 'severity', 'vehicleId']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const source = ctx.query.get('source');
  const severity = ctx.query.get('severity');
  const vehicleId = ctx.query.get('vehicleId');
  if (
    limit === undefined ||
    (source !== null && !(BFF_ALERT_SOURCES as readonly string[]).includes(source)) ||
    (severity !== null && !(BFF_ALERT_SEVERITIES as readonly string[]).includes(severity)) ||
    (vehicleId !== null && !ID.test(vehicleId))
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify(['alerts', source, severity, vehicleId, limit]);
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
      ...(source === null ? {} : { source: source as BffAlertSource }),
      ...(severity === null ? {} : { severity: severity as BffAlertSeverity }),
      ...(vehicleId === null ? {} : { vehicleId }),
    },
  };
}

export const ALERT_ROUTES: readonly Route[] = [
  route('alerts.list', async (ctx) => {
    const parsed = alertQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.alerts.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId, asOf, windowDays } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: BffAlertPage = {
      items: items as readonly BffAlert[],
      // Deep pages are bounded (the alerts are derived on every read): no cursor beyond the bound.
      nextCursor:
        next < total && next <= MAX_ALERT_OFFSET
          ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter })
          : null,
      total,
      sort: { field: 'dueOn', direction: 'asc' },
      asOf,
      windowDays,
    };
    return success(ctx, 'alerts.list', page);
  }),
  route('alerts.settings.get', async (ctx) =>
    reply(
      ctx,
      'alerts.settings.get',
      await ctx.platform.companySettings.get(ctx.token as string, ctx.correlationId),
      (view) => view,
    ),
  ),
  route('alerts.settings.update', async (ctx) => {
    const input = body(ctx, ['version', 'expiryWindowDays', 'recipientRoles']);
    if (!input) return bad(ctx);
    const { version, ...settings } = input;
    return reply(
      ctx,
      'alerts.settings.update',
      await ctx.platform.companySettings.update(
        ctx.token as string,
        ctx.correlationId,
        version,
        settings,
      ),
      (view) => view,
    );
  }),
];
