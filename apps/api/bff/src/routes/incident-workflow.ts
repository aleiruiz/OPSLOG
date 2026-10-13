import {
  IDEMPOTENCY_KEY_HEADER,
  isIdempotencyKey,
  type BffIncident,
  type BffRouteId,
} from '../../../../../packages/contracts/src/index.js';
import type { IncidentApiResponse, IncidentView } from '../../../incidents/cases/src/index.js';
import { parseLooseObject } from '../body.js';
import { singleHeader, type BffResponse } from '../http.js';
import type { Route, RouteContext } from './shared.js';
import { ID, bad, failure, route, success } from './shared.js';

const api = (ctx: RouteContext) => ctx.platform.incidentWorkflow;
const incidentId = (ctx: RouteContext) => ctx.params['incidentId'] as string;
/** Compile-time proof that the API view is the contract's `BffIncident`. */
const incidentBody = (view: IncidentView): BffIncident => view;

async function answer<T>(
  ctx: RouteContext,
  result: Promise<IncidentApiResponse<T>>,
  id: BffRouteId,
  shape: (value: T) => unknown,
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

const process = (
  id: 'incidents.insurance.update' | 'incidents.resolution.update',
  call: 'updateInsurance' | 'updateResolution',
): Route =>
  route(
    id,
    async (ctx) => {
      const input = jsonObject(ctx);
      if (!input) return bad(ctx);
      return answer(
        ctx,
        api(ctx)[call](ctx.token as string, ctx.correlationId, incidentId(ctx), input),
        id,
        incidentBody,
      );
    },
    { incidentId: ID },
  );

export const INCIDENT_WORKFLOW_ROUTES: readonly Route[] = [
  route(
    'incidents.transition',
    async (ctx) => {
      const input = jsonObject(ctx);
      if (!input) return bad(ctx);
      // The key comes from the header only; a repeated or malformed header is a bad request. Which
      // commands need one is the domain's rule, so it answers 400 `idempotency_key_required` itself.
      const key = singleHeader(ctx.headers, IDEMPOTENCY_KEY_HEADER);
      if (ctx.headers[IDEMPOTENCY_KEY_HEADER] !== undefined && !isIdempotencyKey(key))
        return bad(ctx);
      return answer(
        ctx,
        api(ctx).transition(ctx.token as string, ctx.correlationId, incidentId(ctx), input, key),
        'incidents.transition',
        incidentBody,
      );
    },
    { incidentId: ID },
  ),
  route(
    'incidents.nextSteps',
    async (ctx) =>
      answer(
        ctx,
        api(ctx).nextSteps(ctx.token as string, ctx.correlationId, incidentId(ctx)),
        'incidents.nextSteps',
        (value) => value,
      ),
    { incidentId: ID },
  ),
  process('incidents.insurance.update', 'updateInsurance'),
  process('incidents.resolution.update', 'updateResolution'),
];
