import type { BffListColumns, BffSavedView } from '../../../../../packages/contracts/src/index.js';
import { bad, body, failure, ID, route, success, type Route, type RouteContext } from './shared.js';

const MODULE = /^[a-z]{1,24}$/;

/** Strict query of the listing: `module` once and nothing else. */
function listQuery(ctx: RouteContext): string | null {
  const keys = [...ctx.query.keys()];
  if (keys.length !== 1 || keys[0] !== 'module') return null;
  const module = ctx.query.get('module');
  return module !== null && MODULE.test(module) ? module : null;
}

const token = (ctx: RouteContext) => ctx.token as string;

/**
 * Saved views of the lists of BRD §14.2 and the columns each member keeps visible (FR-162). The shape
 * of the filters is checked by the domain against the module's allowlist (`BFF_LIST_CATALOG`).
 */
export const SAVED_VIEWS_ROUTES: readonly Route[] = [
  route('views.list', async (ctx) => {
    const module = listQuery(ctx);
    if (module === null) return bad(ctx);
    const result = await ctx.platform.savedViews.api.list(token(ctx), ctx.correlationId, module);
    if (!result.ok) return failure(ctx, result.error);
    return success(ctx, 'views.list', result.value as { items: readonly BffSavedView[] });
  }),
  route('views.create', async (ctx) => {
    const input = body(
      ctx,
      ['module', 'name', 'shared', 'filters', 'sort', 'columns'],
      ['module', 'name'],
    );
    if (input === null) return bad(ctx);
    const result = await ctx.platform.savedViews.api.create(
      token(ctx),
      ctx.correlationId,
      input['module'],
      input,
    );
    if (!result.ok) return failure(ctx, result.error);
    return success(ctx, 'views.create', result.value as BffSavedView);
  }),
  route(
    'views.update',
    async (ctx) => {
      const patch = body(
        ctx,
        ['version', 'name', 'shared', 'filters', 'sort', 'columns'],
        ['version'],
      );
      if (patch === null) return bad(ctx);
      const result = await ctx.platform.savedViews.api.update(
        token(ctx),
        ctx.correlationId,
        ctx.params['id'],
        patch,
      );
      if (!result.ok) return failure(ctx, result.error);
      return success(ctx, 'views.update', result.value as BffSavedView);
    },
    { id: ID },
  ),
  route(
    'views.delete',
    async (ctx) => {
      const result = await ctx.platform.savedViews.api.remove(
        token(ctx),
        ctx.correlationId,
        ctx.params['id'],
      );
      if (!result.ok) return failure(ctx, result.error);
      return success(ctx, 'views.delete', undefined);
    },
    { id: ID },
  ),
  route(
    'views.columns',
    async (ctx) => {
      const result = await ctx.platform.savedViews.api.columns(
        token(ctx),
        ctx.correlationId,
        ctx.params['module'],
      );
      if (!result.ok) return failure(ctx, result.error);
      return success(ctx, 'views.columns', result.value as BffListColumns);
    },
    { module: MODULE },
  ),
  route(
    'views.columnsSave',
    async (ctx) => {
      const input = body(ctx, ['columns']);
      if (input === null) return bad(ctx);
      const result = await ctx.platform.savedViews.api.saveColumns(
        token(ctx),
        ctx.correlationId,
        ctx.params['module'],
        input['columns'],
      );
      if (!result.ok) return failure(ctx, result.error);
      return success(ctx, 'views.columnsSave', result.value as BffListColumns);
    },
    { module: MODULE },
  ),
];
