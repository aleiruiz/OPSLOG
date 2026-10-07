import {
  BFF_ASSIGNMENT_STATUSES,
  BFF_ASSIGNMENT_TYPES,
  type BffAssignmentStatus,
  type BffAssignmentType,
  type BffVehicleAssignment,
  type BffVehicleAssignmentEvent,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type { AssignmentView, SessionDetails } from '../../../composition/src/index.js';
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

const assignmentBody = (view: AssignmentView): BffVehicleAssignment => ({ ...view });

/** Strict query of the assignment listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function assignmentQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'vehicleId', 'employeeId', 'type', 'status']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const vehicleId = ctx.query.get('vehicleId');
  const employeeId = ctx.query.get('employeeId');
  const type = ctx.query.get('type');
  const status = ctx.query.get('status');
  if (
    limit === undefined ||
    (vehicleId !== null && !ID.test(vehicleId)) ||
    (employeeId !== null && !ID.test(employeeId)) ||
    (type !== null && !(BFF_ASSIGNMENT_TYPES as readonly string[]).includes(type)) ||
    (status !== null && !(BFF_ASSIGNMENT_STATUSES as readonly string[]).includes(status))
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([vehicleId, employeeId, type, status, limit]);
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
      ...(vehicleId === null ? {} : { vehicleId }),
      ...(employeeId === null ? {} : { employeeId }),
      ...(type === null ? {} : { type: type as BffAssignmentType }),
      ...(status === null ? {} : { status: status as BffAssignmentStatus }),
    },
  };
}

/** Strict query of the assignment history: only `limit` and a signed cursor bound to the tenant and the assignment. */
function assignmentHistoryQuery(ctx: RouteContext, tenantId: string, assignmentId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['assignment', assignmentId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

export const ASSIGNMENT_ROUTES: readonly Route[] = [
  route('assignments.list', async (ctx) => {
    const parsed = assignmentQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.assignments.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffVehicleAssignment> = {
      items: items.map(assignmentBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'startedAt', direction: 'desc' },
    };
    return success(ctx, 'assignments.list', page);
  }),
  route('assignments.create', async (ctx) => {
    const input = body(
      ctx,
      ['vehicleId', 'employeeId', 'type', 'reason', 'replace'],
      ['vehicleId', 'employeeId', 'type', 'reason'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'assignments.create',
      await ctx.platform.assignments.create(ctx.token as string, ctx.correlationId, input),
      (view) => ({
        assignment: assignmentBody(view.assignment),
        replaced: view.replaced === null ? null : assignmentBody(view.replaced),
      }),
    );
  }),
  route(
    'assignments.get',
    async (ctx) =>
      reply(
        ctx,
        'assignments.get',
        await ctx.platform.assignments.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        assignmentBody,
      ),
    { id: ID },
  ),
  route(
    'assignments.end',
    async (ctx) => {
      const input = body(ctx, ['version', 'reason']);
      if (!input) return bad(ctx);
      const { version, ...ending } = input;
      return reply(
        ctx,
        'assignments.end',
        await ctx.platform.assignments.end(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          ending,
        ),
        assignmentBody,
      );
    },
    { id: ID },
  ),
  route(
    'assignments.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = assignmentHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.assignments.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffVehicleAssignmentEvent> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'seq', direction: 'desc' },
      };
      return success(ctx, 'assignments.history', page);
    },
    { id: ID },
  ),
];
