import {
  BFF_EMPLOYEE_KINDS,
  BFF_EMPLOYEE_STATUSES,
  type BffEmployee,
  type BffEmployeeDetail,
  type BffEmployeeHistoryEntry,
  type BffEmployeeKind,
  type BffEmployeeStatus,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type {
  EmployeeDetailView,
  EmployeeView,
  SessionDetails,
} from '../../../composition/src/index.js';
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

const EMPLOYEE_KEYS = [
  'firstName',
  'lastName',
  'areaId',
  'employeeNumber',
  'position',
  'hireDate',
  'idType',
  'nationalId',
  'phone',
  'email',
  'licenseNumber',
  'licenseType',
  'licenseExpiresOn',
] as const;

const employeeBody = (view: EmployeeView): BffEmployee => ({ ...view });
const employeeDetailBody = (view: EmployeeDetailView): BffEmployeeDetail => ({ ...view });

/** Strict query of the employee listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function employeeQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'kind', 'status', 'areaId', 'includeArchived']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const kind = ctx.query.get('kind');
  const status = ctx.query.get('status');
  const areaId = ctx.query.get('areaId');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (kind !== null && !(BFF_EMPLOYEE_KINDS as readonly string[]).includes(kind)) ||
    (status !== null && !(BFF_EMPLOYEE_STATUSES as readonly string[]).includes(status)) ||
    (areaId !== null && !ID.test(areaId)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([kind, status, areaId, archived === 'true', limit]);
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
      ...(kind === null ? {} : { kind: kind as BffEmployeeKind }),
      ...(status === null ? {} : { status: status as BffEmployeeStatus }),
      ...(areaId === null ? {} : { areaId }),
    },
  };
}

/** Strict query of the employee history: only `limit` and a signed cursor bound to the tenant and the employee. */
function employeeHistoryQuery(ctx: RouteContext, tenantId: string, employeeId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['employee', employeeId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

export const EMPLOYEE_ROUTES: readonly Route[] = [
  route('employees.list', async (ctx) => {
    const parsed = employeeQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.employees.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffEmployee> = {
      items: items.map(employeeBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'lastName', direction: 'asc' },
    };
    return success(ctx, 'employees.list', page);
  }),
  route('employees.create', async (ctx) => {
    const input = body(
      ctx,
      ['kind', ...EMPLOYEE_KEYS],
      ['kind', 'firstName', 'lastName', 'areaId'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'employees.create',
      await ctx.platform.employees.create(ctx.token as string, ctx.correlationId, input),
      employeeBody,
    );
  }),
  route(
    'employees.get',
    async (ctx) =>
      reply(
        ctx,
        'employees.get',
        await ctx.platform.employees.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        employeeDetailBody,
      ),
    { id: ID },
  ),
  route(
    'employees.update',
    async (ctx) => {
      const input = body(ctx, ['version', ...EMPLOYEE_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'employees.update',
        await ctx.platform.employees.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        employeeBody,
      );
    },
    { id: ID },
  ),
  route(
    'employees.status',
    async (ctx) => {
      const input = body(ctx, ['version', 'status', 'reason']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'employees.status',
        await ctx.platform.employees.changeStatus(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
          input['status'],
          input['reason'],
        ),
        employeeBody,
      );
    },
    { id: ID },
  ),
  route(
    'employees.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'employees.archive',
        await ctx.platform.employees.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        employeeBody,
      );
    },
    { id: ID },
  ),
  route(
    'employees.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = employeeHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.employees.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffEmployeeHistoryEntry> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'version', direction: 'desc' },
      };
      return success(ctx, 'employees.history', page);
    },
    { id: ID },
  ),
];
