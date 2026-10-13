import type { BffIncidentAlertPage } from '../../../../../packages/contracts/src/index.js';
import type { AlertPage } from '../../../../../packages/domain/incidents/sla/src/index.js';
import type { Route } from './shared.js';
import { bad, failure, route, success } from './shared.js';

/** Compile-time proof that the API page is the contract's type. */
const pageBody = (page: AlertPage): BffIncidentAlertPage => page;

const NUMBERS = new Set<string>(['limit', 'offset']);

/**
 * Strict query: each key once, no unknown key. `limit` and `offset` arrive as digits and are handed
 * on as numbers; every other check (kinds, ids, 25/50/100) belongs to the domain and names the field.
 */
function alertQuery(query: URLSearchParams): Record<string, unknown> | null {
  const keys = [...query.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const input: Record<string, unknown> = {};
  for (const key of keys) {
    const value = query.get(key) as string;
    input[key] = NUMBERS.has(key) && /^[0-9]{1,9}$/.test(value) ? Number(value) : value;
  }
  return input;
}

export const INCIDENT_SLA_ROUTES: readonly Route[] = [
  route('incidents.alerts.list', async (ctx) => {
    const input = alertQuery(ctx.query);
    if (!input) return bad(ctx);
    const result = await ctx.platform.incidentSla.alerts(
      ctx.token as string,
      ctx.correlationId,
      input,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    return success(ctx, 'incidents.alerts.list', pageBody(result.value));
  }),
];
