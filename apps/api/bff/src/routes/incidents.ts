import {
  BFF_INCIDENT_SORT_FIELDS,
  IDEMPOTENCY_KEY_HEADER,
  isIdempotencyKey,
  type BffIncident,
  type BffIncidentSuggestions,
  type BffIncidentTimelineEntry,
  type BffRouteId,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type { IncidentApiResponse, IncidentView } from '../../../incidents/cases/src/index.js';
import { parseLooseObject } from '../body.js';
import { singleHeader, type BffResponse } from '../http.js';
import type { Route, RouteContext } from './shared.js';
import { ID, LIMITS, bad, failure, isOffsetCursor, route, success } from './shared.js';

const api = (ctx: RouteContext) => ctx.platform.incidents;
const incidentId = (ctx: RouteContext) => ctx.params['incidentId'] as string;
/** Compile-time proof that the API view is the contract's `BffIncident`. */
const incidentBody = (view: IncidentView): BffIncident => view;

async function answer<T, R>(
  ctx: RouteContext,
  result: Promise<IncidentApiResponse<T>>,
  id: BffRouteId,
  shape: (value: T) => R,
): Promise<BffResponse> {
  const resolved = await result;
  if (!resolved.ok || resolved.value === undefined) return failure(ctx, resolved.error);
  return success(ctx, id, shape(resolved.value) as never);
}

/** Any JSON object: the domain names every bad field of it in a 400 `fieldErrors`. */
function jsonObject(ctx: RouteContext): Record<string, unknown> | null {
  try {
    return parseLooseObject(ctx.body);
  } catch {
    return null;
  }
}

const LIST_KEYS = new Set([
  'limit',
  'cursor',
  'status',
  'severity',
  'type',
  'vehicleId',
  'responsible',
  'createdBy',
  'occurredFrom',
  'occurredTo',
  'sort',
  'direction',
]);

/**
 * Strict query: unknown keys, a repeated key other than `status`, a bad limit and a foreign or
 * forged cursor are a 400. `status` may be comma-separated or repeated; both forms are one filter.
 */
function listQuery(ctx: RouteContext, tenantId: string) {
  const keys = [...ctx.query.keys()];
  const single = keys.filter((key) => key !== 'status');
  if (keys.some((key) => !LIST_KEYS.has(key)) || new Set(single).size !== single.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filters: Record<string, string> = {};
  for (const key of keys)
    if (key !== 'limit' && key !== 'cursor')
      filters[key] =
        key === 'status' ? ctx.query.getAll(key).join(',') : (ctx.query.get(key) as string);
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const signature = JSON.stringify([
    Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
    limit,
  ]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== signature) return null;
    offset = opened.o;
  }
  const { status, ...rest } = filters;
  return {
    signature,
    limit,
    offset,
    sort: (filters['sort'] ?? 'createdAt') as (typeof BFF_INCIDENT_SORT_FIELDS)[number],
    direction: (filters['direction'] ?? 'desc') as 'asc' | 'desc',
    input: {
      ...rest,
      ...(status === undefined ? {} : { status: status.split(',') }),
      limit,
      offset,
    },
  };
}

export const INCIDENT_ROUTES: readonly Route[] = [
  route('incidents.list', async (ctx) => {
    const parsed = listQuery(ctx, (ctx.session?.tenantId ?? '') as string);
    if (!parsed) return bad(ctx);
    const result = await api(ctx).list(ctx.token as string, ctx.correlationId, parsed.input);
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffIncident> = {
      items: items.map(incidentBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.signature }) : null,
      total,
      sort: { field: parsed.sort, direction: parsed.direction },
    };
    return success(ctx, 'incidents.list', page);
  }),
  route('incidents.create', async (ctx) => {
    const input = jsonObject(ctx);
    if (!input) return bad(ctx);
    // The key comes from the header only; a repeated or malformed header is a bad request.
    const key = singleHeader(ctx.headers, IDEMPOTENCY_KEY_HEADER);
    if (ctx.headers[IDEMPOTENCY_KEY_HEADER] !== undefined && !isIdempotencyKey(key))
      return bad(ctx);
    return answer(
      ctx,
      api(ctx).create(ctx.token as string, ctx.correlationId, input, key),
      'incidents.create',
      incidentBody,
    );
  }),
  // Before `:incidentId`: the literal segment must never be read as an id.
  route('incidents.suggestions', async (ctx) => {
    const keys = [...ctx.query.keys()];
    if (
      keys.some((key) => key !== 'vehicleId' && key !== 'occurredAt') ||
      new Set(keys).size !== keys.length
    )
      return bad(ctx);
    const query = Object.fromEntries(keys.map((key) => [key, ctx.query.get(key) as string]));
    return answer<unknown, BffIncidentSuggestions>(
      ctx,
      api(ctx).suggestions(ctx.token as string, ctx.correlationId, query),
      'incidents.suggestions',
      (value) => value as BffIncidentSuggestions,
    );
  }),
  route(
    'incidents.get',
    async (ctx) =>
      answer(
        ctx,
        api(ctx).get(ctx.token as string, ctx.correlationId, incidentId(ctx)),
        'incidents.get',
        incidentBody,
      ),
    { incidentId: ID },
  ),
  route(
    'incidents.update',
    async (ctx) => {
      const input = jsonObject(ctx);
      if (!input) return bad(ctx);
      return answer(
        ctx,
        api(ctx).update(ctx.token as string, ctx.correlationId, incidentId(ctx), input),
        'incidents.update',
        incidentBody,
      );
    },
    { incidentId: ID },
  ),
  route(
    'incidents.timeline',
    async (ctx) =>
      answer(
        ctx,
        api(ctx).timeline(ctx.token as string, ctx.correlationId, incidentId(ctx)),
        'incidents.timeline',
        (items): { items: readonly BffIncidentTimelineEntry[] } => ({ items }),
      ),
    { incidentId: ID },
  ),
];
