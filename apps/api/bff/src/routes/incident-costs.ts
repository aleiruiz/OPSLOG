import {
  IDEMPOTENCY_KEY_HEADER,
  isIdempotencyKey,
  type BffIncidentCosts,
  type BffRepairLinkChange,
  type BffRepairLinkList,
  type BffRouteId,
} from '../../../../../packages/contracts/src/index.js';
import type { IncidentApiResponse } from '../../../incidents/cases/src/index.js';
import type { CostsView } from '../../../incidents/costs/src/index.js';
import type {
  RepairLinkChangeView,
  RepairLinkListView,
} from '../../../incidents/repairs/src/index.js';
import { parseLooseObject } from '../body.js';
import { singleHeader, type BffResponse } from '../http.js';
import type { Route, RouteContext } from './shared.js';
import { ID, bad, failure, route, success } from './shared.js';

const repairs = (ctx: RouteContext) => ctx.platform.incidentRepairs;
const costs = (ctx: RouteContext) => ctx.platform.incidentCosts;
const incidentId = (ctx: RouteContext) => ctx.params['incidentId'] as string;

async function answer<T>(
  ctx: RouteContext,
  result: Promise<IncidentApiResponse<T>>,
  id: BffRouteId,
): Promise<BffResponse> {
  const resolved = await result;
  if (!resolved.ok || resolved.value === undefined) return failure(ctx, resolved.error);
  return success(ctx, id, resolved.value as never);
}

/** Any JSON object: the domain names every bad field of it in a 400 `fieldErrors`. */
function jsonObject(ctx: RouteContext): Record<string, unknown> | null {
  try {
    return parseLooseObject(ctx.body);
  } catch {
    return null;
  }
}

/**
 * The key comes from the header only; a repeated or malformed header is a bad request. A missing one
 * is the domain's 400 `idempotency_key_required`: these commands always carry money or its evidence.
 */
function keyOf(ctx: RouteContext): { ok: true; key: string | undefined } | { ok: false } {
  const key = singleHeader(ctx.headers, IDEMPOTENCY_KEY_HEADER);
  if (ctx.headers[IDEMPOTENCY_KEY_HEADER] !== undefined && !isIdempotencyKey(key))
    return { ok: false };
  return { ok: true, key };
}

/** Compile-time proof that the API views are the contract's types. */
const listBody = (view: RepairLinkListView): BffRepairLinkList => view;
const changeBody = (view: RepairLinkChangeView): BffRepairLinkChange => view;
const costsBody = (view: CostsView): BffIncidentCosts => view;

const INCIDENT = { incidentId: ID };

export const INCIDENT_COST_ROUTES: readonly Route[] = [
  route(
    'incidents.repairs.list',
    async (ctx) => {
      const result = await repairs(ctx).list(
        ctx.token as string,
        ctx.correlationId,
        incidentId(ctx),
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      return success(ctx, 'incidents.repairs.list', listBody(result.value));
    },
    INCIDENT,
  ),
  route(
    'incidents.repairs.link',
    async (ctx) => {
      const input = jsonObject(ctx);
      const key = keyOf(ctx);
      if (!input || !key.ok) return bad(ctx);
      const result = await repairs(ctx).link(
        ctx.token as string,
        ctx.correlationId,
        incidentId(ctx),
        input,
        key.key,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      return success(ctx, 'incidents.repairs.link', changeBody(result.value));
    },
    INCIDENT,
  ),
  route(
    'incidents.repairs.unlink',
    (ctx) => {
      const input = jsonObject(ctx);
      const key = keyOf(ctx);
      if (!input || !key.ok) return Promise.resolve(bad(ctx));
      return answer(
        ctx,
        repairs(ctx).unlink(
          ctx.token as string,
          ctx.correlationId,
          incidentId(ctx),
          ctx.params['linkId'] as string,
          input,
          key.key,
        ),
        'incidents.repairs.unlink',
      );
    },
    { incidentId: ID, linkId: ID },
  ),
  route(
    'incidents.costs.get',
    async (ctx) => {
      const result = await costs(ctx).get(ctx.token as string, ctx.correlationId, incidentId(ctx));
      if (!result.ok || !result.value) return failure(ctx, result.error);
      return success(ctx, 'incidents.costs.get', costsBody(result.value));
    },
    INCIDENT,
  ),
  route(
    'incidents.costs.update',
    async (ctx) => {
      const input = jsonObject(ctx);
      const key = keyOf(ctx);
      if (!input || !key.ok) return bad(ctx);
      const result = await costs(ctx).update(
        ctx.token as string,
        ctx.correlationId,
        incidentId(ctx),
        input,
        key.key,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      return success(ctx, 'incidents.costs.update', costsBody(result.value));
    },
    INCIDENT,
  ),
];
