import {
  BFF_SEARCH_MAX_TERM,
  BFF_SEARCH_TYPES,
  type BffSearchResult,
} from '../../../../../packages/contracts/src/index.js';
import { route, bad, failure, success, type Route, type RouteContext } from './shared.js';

/** Strict query of the search: `q` once, `types` once as a duplicate-free comma list of known types. */
function searchQuery(ctx: RouteContext) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'q' && key !== 'types') || new Set(keys).size !== keys.length)
    return null;
  const q = ctx.query.get('q');
  if (q === null || q.trim().length === 0 || q.length > BFF_SEARCH_MAX_TERM) return null;
  const raw = ctx.query.get('types');
  if (raw === null) return { q };
  const types = raw.split(',');
  if (
    types.some((type) => !(BFF_SEARCH_TYPES as readonly string[]).includes(type)) ||
    new Set(types).size !== types.length
  )
    return null;
  return { q, types };
}

export const SEARCH_ROUTES: readonly Route[] = [
  route('search.query', async (ctx) => {
    const parsed = searchQuery(ctx);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.search.api.search(
      ctx.token as string,
      ctx.correlationId,
      parsed,
    );
    if (!result.ok) return failure(ctx, result.error);
    return success(ctx, 'search.query', result.value as BffSearchResult);
  }),
];
