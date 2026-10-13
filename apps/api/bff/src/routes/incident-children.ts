import {
  IDEMPOTENCY_KEY_HEADER,
  isIdempotencyKey,
  type BffRouteId,
} from '../../../../../packages/contracts/src/index.js';
import type { IncidentApiResponse } from '../../../incidents/cases/src/index.js';
import { parseLooseObject } from '../body.js';
import { singleHeader, type BffResponse } from '../http.js';
import type { Route, RouteContext } from './shared.js';
import { ID, bad, failure, route, success } from './shared.js';

const api = (ctx: RouteContext) => ctx.platform.incidentChildren;
const incidentId = (ctx: RouteContext) => ctx.params['incidentId'] as string;
const param = (ctx: RouteContext, name: string) => ctx.params[name] as string;

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

/** The key comes from the header only; a repeated or malformed header is a bad request. */
function keyOf(ctx: RouteContext): { ok: true; key: string | undefined } | { ok: false } {
  const key = singleHeader(ctx.headers, IDEMPOTENCY_KEY_HEADER);
  if (ctx.headers[IDEMPOTENCY_KEY_HEADER] !== undefined && !isIdempotencyKey(key))
    return { ok: false };
  return { ok: true, key };
}

const INCIDENT = { incidentId: ID };
const PARTY = { incidentId: ID, partyId: ID };
const EVIDENCE = { incidentId: ID, evidenceId: ID };

export const INCIDENT_CHILD_ROUTES: readonly Route[] = [
  route(
    'incidents.thirdParties.list',
    (ctx) =>
      answer(
        ctx,
        api(ctx).listThirdParties(ctx.token as string, ctx.correlationId, incidentId(ctx)),
        'incidents.thirdParties.list',
      ),
    INCIDENT,
  ),
  route(
    'incidents.thirdParties.create',
    (ctx) => {
      const input = jsonObject(ctx);
      const key = keyOf(ctx);
      if (!input || !key.ok) return Promise.resolve(bad(ctx));
      return answer(
        ctx,
        api(ctx).createThirdParty(
          ctx.token as string,
          ctx.correlationId,
          incidentId(ctx),
          input,
          key.key,
        ),
        'incidents.thirdParties.create',
      );
    },
    INCIDENT,
  ),
  route(
    'incidents.thirdParties.update',
    (ctx) => {
      const input = jsonObject(ctx);
      if (!input) return Promise.resolve(bad(ctx));
      return answer(
        ctx,
        api(ctx).updateThirdParty(
          ctx.token as string,
          ctx.correlationId,
          incidentId(ctx),
          param(ctx, 'partyId'),
          input,
        ),
        'incidents.thirdParties.update',
      );
    },
    PARTY,
  ),
  route(
    'incidents.thirdParties.remove',
    (ctx) => {
      const input = jsonObject(ctx);
      if (!input) return Promise.resolve(bad(ctx));
      return answer(
        ctx,
        api(ctx).removeThirdParty(
          ctx.token as string,
          ctx.correlationId,
          incidentId(ctx),
          param(ctx, 'partyId'),
          input,
        ),
        'incidents.thirdParties.remove',
      );
    },
    PARTY,
  ),
  route(
    'incidents.evidence.list',
    (ctx) =>
      answer(
        ctx,
        api(ctx)
          .listEvidence(ctx.token as string, ctx.correlationId, incidentId(ctx))
          .then((result) =>
            result.ok && result.value
              ? { ...result, value: { items: result.value } }
              : (result as IncidentApiResponse<never>),
          ),
        'incidents.evidence.list',
      ),
    INCIDENT,
  ),
  route(
    'incidents.evidence.upload',
    (ctx) => {
      const input = jsonObject(ctx);
      const key = keyOf(ctx);
      if (!input || !key.ok) return Promise.resolve(bad(ctx));
      return answer(
        ctx,
        api(ctx).uploadEvidence(
          ctx.token as string,
          ctx.correlationId,
          incidentId(ctx),
          input,
          key.key,
        ),
        'incidents.evidence.upload',
      );
    },
    INCIDENT,
  ),
  route(
    'incidents.evidence.detach',
    (ctx) => {
      const input = jsonObject(ctx);
      if (!input) return Promise.resolve(bad(ctx));
      return answer(
        ctx,
        api(ctx).detachEvidence(
          ctx.token as string,
          ctx.correlationId,
          incidentId(ctx),
          param(ctx, 'evidenceId'),
          input,
        ),
        'incidents.evidence.detach',
      );
    },
    EVIDENCE,
  ),
  route(
    'incidents.evidence.content',
    (ctx) =>
      answer(
        ctx,
        api(ctx).evidenceContent(
          ctx.token as string,
          ctx.correlationId,
          incidentId(ctx),
          param(ctx, 'evidenceId'),
        ),
        'incidents.evidence.content',
      ),
    EVIDENCE,
  ),
];
