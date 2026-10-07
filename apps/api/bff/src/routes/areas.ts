import {
  type BffArea,
  type BffAreaDetail,
  type BffAreaHistoryEntry,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type { AreaDetailView, AreaView, SessionDetails } from '../../../composition/src/index.js';
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

const AREA_KEYS = ['name', 'code', 'parentId', 'responsibleIds'] as const;

const areaBody = (view: AreaView): BffArea => ({ ...view });
const areaDetailBody = (view: AreaDetailView): BffAreaDetail => ({ ...view });

/** Strict query of the area listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function areaQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'parentId', 'includeInactive']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const parentId = ctx.query.get('parentId');
  const inactive = ctx.query.get('includeInactive');
  if (
    limit === undefined ||
    (parentId !== null && !ID.test(parentId)) ||
    (inactive !== null && inactive !== 'true' && inactive !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([parentId, inactive === 'true', limit]);
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
      includeInactive: inactive === 'true',
      // `root` is the literal for "no parent": the roots of the tree.
      ...(parentId === null ? {} : { parentId: parentId === 'root' ? null : parentId }),
    },
  };
}

/** Strict query of the area history: only `limit` and a signed cursor bound to the tenant and the area. */
function areaHistoryQuery(ctx: RouteContext, tenantId: string, areaId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify([areaId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

export const AREA_ROUTES: readonly Route[] = [
  route('areas.list', async (ctx) => {
    const parsed = areaQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.areas.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffArea> = {
      items: items.map(areaBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'name', direction: 'asc' },
    };
    return success(ctx, 'areas.list', page);
  }),
  route('areas.create', async (ctx) => {
    const input = body(ctx, AREA_KEYS, ['name']);
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'areas.create',
      await ctx.platform.areas.create(ctx.token as string, ctx.correlationId, input),
      areaBody,
    );
  }),
  route(
    'areas.get',
    async (ctx) =>
      reply(
        ctx,
        'areas.get',
        await ctx.platform.areas.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        areaDetailBody,
      ),
    { id: ID },
  ),
  route(
    'areas.update',
    async (ctx) => {
      const input = body(ctx, ['version', ...AREA_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'areas.update',
        await ctx.platform.areas.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        areaBody,
      );
    },
    { id: ID },
  ),
  route(
    'areas.deactivate',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'areas.deactivate',
        await ctx.platform.areas.deactivate(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        areaBody,
      );
    },
    { id: ID },
  ),
  route(
    'areas.activate',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'areas.activate',
        await ctx.platform.areas.activate(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        areaBody,
      );
    },
    { id: ID },
  ),
  route(
    'areas.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = areaHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.areas.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffAreaHistoryEntry> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'version', direction: 'desc' },
      };
      return success(ctx, 'areas.history', page);
    },
    { id: ID },
  ),
];
