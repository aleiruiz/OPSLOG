import {
  BFF_IMPORT_ENTITIES,
  BFF_IMPORT_OUTCOMES,
  BFF_IMPORT_STATUSES,
  type BffImportEntity,
  type BffImportEvent,
  type BffImportJob,
  type BffImportOutcome,
  type BffImportRow,
  type BffImportStatus,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type { ImportJobView, SessionDetails } from '../../../composition/src/index.js';
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

const importBody = (view: ImportJobView): BffImportJob => ({ ...view });

/** Strict query of the import listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function importQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'entity', 'status']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const entity = ctx.query.get('entity');
  const status = ctx.query.get('status');
  if (
    limit === undefined ||
    (entity !== null && !(BFF_IMPORT_ENTITIES as readonly string[]).includes(entity)) ||
    (status !== null && !(BFF_IMPORT_STATUSES as readonly string[]).includes(status))
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([entity, status, limit]);
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
      ...(entity === null ? {} : { entity: entity as BffImportEntity }),
      ...(status === null ? {} : { status: status as BffImportStatus }),
    },
  };
}

/** Strict query of the per-row report: `outcome`, `limit` and a signed cursor bound to the tenant, the job and the filter. */
function importRowsQuery(ctx: RouteContext, tenantId: string, jobId: string) {
  const allowed = new Set(['limit', 'cursor', 'outcome']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const outcome = ctx.query.get('outcome');
  if (
    limit === undefined ||
    (outcome !== null && !(BFF_IMPORT_OUTCOMES as readonly string[]).includes(outcome))
  )
    return null;
  const filter = JSON.stringify(['import-rows', jobId, outcome, limit]);
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
    query: { limit, offset, ...(outcome === null ? {} : { outcome: outcome as BffImportOutcome }) },
  };
}

/** Strict query of the job history: only `limit` and a signed cursor bound to the tenant and the job. */
function importHistoryQuery(ctx: RouteContext, tenantId: string, jobId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['import', jobId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

export const IMPORT_ROUTES: readonly Route[] = [
  route('imports.list', async (ctx) => {
    const parsed = importQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.imports.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffImportJob> = {
      items: items.map(importBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'createdAt', direction: 'desc' },
    };
    return success(ctx, 'imports.list', page);
  }),
  route('imports.create', async (ctx) => {
    const input = body(
      ctx,
      ['entity', 'mode', 'idempotencyKey', 'dryRunJobId', 'rows', 'csv'],
      ['entity', 'mode'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'imports.create',
      await ctx.platform.imports.submit(ctx.token as string, ctx.correlationId, input),
      (view) => ({ job: importBody(view.job), replayed: view.replayed }),
    );
  }),
  route(
    'imports.get',
    async (ctx) =>
      reply(
        ctx,
        'imports.get',
        await ctx.platform.imports.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        importBody,
      ),
    { id: ID },
  ),
  route(
    'imports.rows',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = importRowsQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.imports.rows(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffImportRow> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'rowNumber', direction: 'asc' },
      };
      return success(ctx, 'imports.rows', page);
    },
    { id: ID },
  ),
  route(
    'imports.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = importHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.imports.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffImportEvent> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'seq', direction: 'desc' },
      };
      return success(ctx, 'imports.history', page);
    },
    { id: ID },
  ),
];
