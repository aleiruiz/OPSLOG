import {
  BFF_COVERAGE_TYPES,
  BFF_POLICY_STATUSES,
  type BffCoverageType,
  type BffInsurancePolicy,
  type BffInsurancePolicyRevision,
  type BffPolicyStatus,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type { PolicyView, SessionDetails } from '../../../composition/src/index.js';
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const POLICY_RENEWAL_KEYS = [
  'version',
  'startsOn',
  'endsOn',
  'policyNumber',
  'coverageType',
  'deductible',
] as const;

const policyBody = (view: PolicyView): BffInsurancePolicy => ({ ...view });

/** Strict query of the policy listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function policyQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set([
    'limit',
    'cursor',
    'vehicleId',
    'coverageType',
    'status',
    'coversOn',
    'includeArchived',
  ]);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const vehicleId = ctx.query.get('vehicleId');
  const coverageType = ctx.query.get('coverageType');
  const status = ctx.query.get('status');
  const coversOn = ctx.query.get('coversOn');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (vehicleId !== null && !ID.test(vehicleId)) ||
    (coverageType !== null && !(BFF_COVERAGE_TYPES as readonly string[]).includes(coverageType)) ||
    (status !== null && !(BFF_POLICY_STATUSES as readonly string[]).includes(status)) ||
    (coversOn !== null && !ISO_DAY.test(coversOn)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([
    vehicleId,
    coverageType,
    status,
    coversOn,
    archived === 'true',
    limit,
  ]);
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
      includeArchived: archived === 'true',
      ...(vehicleId === null ? {} : { vehicleId }),
      ...(coverageType === null ? {} : { coverageType: coverageType as BffCoverageType }),
      ...(status === null ? {} : { status: status as BffPolicyStatus }),
      ...(coversOn === null ? {} : { coversOn }),
    },
  };
}

/** Strict query of the policy history: only `limit` and a signed cursor bound to the tenant and the policy. */
function policyHistoryQuery(ctx: RouteContext, tenantId: string, policyId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['policy', policyId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

export const INSURANCE_ROUTES: readonly Route[] = [
  route('insurance.list', async (ctx) => {
    const parsed = policyQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.insurance.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffInsurancePolicy> = {
      items: items.map(policyBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'endsOn', direction: 'asc' },
    };
    return success(ctx, 'insurance.list', page);
  }),
  route('insurance.create', async (ctx) => {
    const input = body(
      ctx,
      [
        'vehicleId',
        'insurer',
        'coverageNotes',
        'policyNumber',
        'coverageType',
        'startsOn',
        'endsOn',
        'deductible',
      ],
      ['vehicleId', 'insurer', 'policyNumber', 'coverageType', 'startsOn', 'endsOn'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'insurance.create',
      await ctx.platform.insurance.create(ctx.token as string, ctx.correlationId, input),
      policyBody,
    );
  }),
  route(
    'insurance.get',
    async (ctx) =>
      reply(
        ctx,
        'insurance.get',
        await ctx.platform.insurance.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        policyBody,
      ),
    { id: ID },
  ),
  route(
    'insurance.update',
    async (ctx) => {
      const input = body(ctx, ['version', 'insurer', 'coverageNotes'], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'insurance.update',
        await ctx.platform.insurance.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        policyBody,
      );
    },
    { id: ID },
  ),
  route(
    'insurance.renew',
    async (ctx) => {
      const input = body(ctx, POLICY_RENEWAL_KEYS, ['version', 'startsOn', 'endsOn']);
      if (!input) return bad(ctx);
      const { version, ...renewal } = input;
      return reply(
        ctx,
        'insurance.renew',
        await ctx.platform.insurance.renew(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          renewal,
        ),
        policyBody,
      );
    },
    { id: ID },
  ),
  route(
    'insurance.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'insurance.archive',
        await ctx.platform.insurance.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        policyBody,
      );
    },
    { id: ID },
  ),
  route(
    'insurance.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = policyHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.insurance.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffInsurancePolicyRevision> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'revision', direction: 'desc' },
      };
      return success(ctx, 'insurance.history', page);
    },
    { id: ID },
  ),
];
