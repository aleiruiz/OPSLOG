import {
  BFF_AUDIT_RESULTS,
  type BffAuditPage,
  type BffAuditReconciliation,
} from '../../../../../packages/contracts/src/index.js';
import type { AuditQueryInput } from '../../../../../packages/domain/audit-query/src/index.js';
import type { SessionDetails } from '../../../composition/src/index.js';
import { bad, failure, route, success, LIMITS, type Route, type RouteContext } from './shared.js';

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_.]{0,63}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Position of an audit page: tenant, the row it continues after, the window it was issued for and the filters. */
interface AuditCursor {
  readonly t: string;
  readonly a: string;
  readonly e: string;
  readonly f: string;
  readonly o: string;
  readonly q: string;
}

function isAuditCursor(value: unknown): value is AuditCursor {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return ['t', 'a', 'e', 'f', 'o', 'q'].every((key) => typeof c[key] === 'string');
}

/** The only keys each audit route reads; unknown or repeated keys are a 400. */
const GLOBAL_KEYS = [
  'from',
  'to',
  'actorId',
  'entityType',
  'entityId',
  'action',
  'result',
  'limit',
  'cursor',
];
const ENTITY_KEYS = ['from', 'to', 'action', 'result', 'limit', 'cursor'];

function strictQuery(ctx: RouteContext, allowed: readonly string[]): Map<string, string> | null {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) return null;
  return new Map(keys.map((key) => [key, ctx.query.get(key) as string]));
}

/**
 * Reads the listing query: shape checks here, rules (range, allowlists) in the domain. The cursor is signed and
 * bound to the company, to the filters and to the window of the first page.
 */
function listQuery(
  ctx: RouteContext,
  tenantId: string,
  allowed: readonly string[],
  fixed: Pick<AuditQueryInput, 'entityType' | 'entityId'> = {},
): { readonly input: AuditQueryInput; readonly filter: string } | null {
  const query = strictQuery(ctx, allowed);
  if (!query) return null;
  const limitText = query.get('limit');
  const limit = limitText === undefined ? 25 : LIMITS.find((value) => String(value) === limitText);
  const text = (key: string, pattern: RegExp): string | undefined | null => {
    const value = query.get(key);
    return value === undefined ? undefined : pattern.test(value) ? value : null;
  };
  const from = text('from', INSTANT);
  const to = text('to', INSTANT);
  const actorId = text('actorId', OPAQUE);
  const entityType = text('entityType', ENTITY_TYPE);
  const entityId = text('entityId', OPAQUE);
  const action = text('action', ACTION);
  const result = query.get('result');
  if (
    limit === undefined ||
    [from, to, actorId, entityType, entityId, action].includes(null) ||
    (result !== undefined && !(BFF_AUDIT_RESULTS as readonly string[]).includes(result))
  )
    return null;
  const input: AuditQueryInput = {
    ...(from === undefined ? {} : { from: from as string }),
    ...(to === undefined ? {} : { to: to as string }),
    ...(actorId === undefined ? {} : { actorId: actorId as string }),
    ...(entityType === undefined ? {} : { entityType: entityType as string }),
    ...(entityId === undefined ? {} : { entityId: entityId as string }),
    ...(action === undefined ? {} : { action: action as string }),
    ...(result === undefined ? {} : { result }),
    ...fixed,
    limit,
  };
  const filter = JSON.stringify([
    'audit',
    input.from ?? null,
    input.to ?? null,
    input.actorId ?? null,
    input.entityType ?? null,
    input.entityId ?? null,
    input.action ?? null,
    input.result ?? null,
    limit,
  ]);
  const cursorText = query.get('cursor');
  if (cursorText === undefined) return { input, filter };
  const opened = ctx.crypto.openCursor(cursorText);
  if (!isAuditCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
  // The next pages keep the window of the first one, even when no range was asked for.
  return {
    input: {
      ...input,
      from: opened.f,
      to: opened.o,
      after: { occurredAt: opened.a, eventId: opened.e },
    },
    filter,
  };
}

function pageOf(ctx: RouteContext, value: PageValue, filter: string): BffAuditPage {
  const { tenantId, items, total, next, from, to } = value;
  return {
    items: items as BffAuditPage['items'],
    nextCursor: next
      ? ctx.crypto.signCursor({
          t: tenantId,
          a: next.occurredAt,
          e: next.eventId,
          f: from,
          o: to,
          q: filter,
        })
      : null,
    total,
    sort: { field: 'occurredAt', direction: 'desc' },
    from,
    to,
  };
}

interface PageValue {
  readonly tenantId: string;
  readonly items: readonly unknown[];
  readonly total: number;
  readonly next: { readonly occurredAt: string; readonly eventId: string } | null;
  readonly from: string;
  readonly to: string;
}

const tenantOf = (ctx: RouteContext): string => (ctx.session as SessionDetails).tenantId;

export const AUDIT_ROUTES: readonly Route[] = [
  route('audit.list', async (ctx) => {
    const query = listQuery(ctx, tenantOf(ctx), GLOBAL_KEYS);
    if (!query) return bad(ctx);
    const result = await ctx.platform.auditQuery.list(
      ctx.token as string,
      ctx.correlationId,
      query.input,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    return success(ctx, 'audit.list', pageOf(ctx, result.value, query.filter));
  }),
  route('audit.reconciliation', async (ctx) => {
    const query = strictQuery(ctx, ['from', 'to']);
    const from = query?.get('from');
    const to = query?.get('to');
    if (
      !query ||
      (from !== undefined && !INSTANT.test(from)) ||
      (to !== undefined && !INSTANT.test(to))
    )
      return bad(ctx);
    const result = await ctx.platform.auditQuery.reconciliation(
      ctx.token as string,
      ctx.correlationId,
      { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    return success(ctx, 'audit.reconciliation', result.value as BffAuditReconciliation);
  }),
  route(
    'audit.entity',
    async (ctx) => {
      const entityType = ctx.params['entityType'] as string;
      const entityId = ctx.params['entityId'] as string;
      const query = listQuery(ctx, tenantOf(ctx), ENTITY_KEYS, { entityType, entityId });
      if (!query) return bad(ctx);
      const rest = { ...query.input } as Record<string, unknown>;
      delete rest['entityType'];
      delete rest['entityId'];
      const result = await ctx.platform.auditQuery.forEntity(
        ctx.token as string,
        ctx.correlationId,
        entityType,
        entityId,
        rest,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      return success(ctx, 'audit.entity', pageOf(ctx, result.value, query.filter));
    },
    { entityType: ENTITY_TYPE, entityId: OPAQUE },
  ),
];
