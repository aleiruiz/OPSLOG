import {
  BFF_VEHICLE_STATUSES,
  type BffVehicle,
  type BffVehicleStatus,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type { SessionDetails, VehicleView } from '../../../composition/src/index.js';
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

const VEHICLE_CREATE_KEYS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
  'odometerKm',
  'registeredOn',
] as const;
const VEHICLE_CREATE_REQUIRED = [
  'economicNumber',
  'plate',
  'make',
  'model',
  'year',
  'areaId',
  'odometerKm',
] as const;
const VEHICLE_PATCH_KEYS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
] as const;

const vehicleBody = (view: VehicleView): BffVehicle => ({ ...view });

/** Strict query of the vehicle listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function vehicleQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'status', 'areaId', 'includeArchived']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const status = ctx.query.get('status');
  const areaId = ctx.query.get('areaId');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (status !== null && !(BFF_VEHICLE_STATUSES as readonly string[]).includes(status)) ||
    (areaId !== null && !ID.test(areaId)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([status, areaId, archived === 'true', limit]);
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
      ...(status === null ? {} : { status: status as BffVehicleStatus }),
      ...(areaId === null ? {} : { areaId }),
    },
  };
}

export const VEHICLE_ROUTES: readonly Route[] = [
  route('vehicles.list', async (ctx) => {
    const parsed = vehicleQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.vehicles.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffVehicle> = {
      items: items.map(vehicleBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'economicNumber', direction: 'asc' },
    };
    return success(ctx, 'vehicles.list', page);
  }),
  route('vehicles.create', async (ctx) => {
    const input = body(ctx, VEHICLE_CREATE_KEYS, VEHICLE_CREATE_REQUIRED);
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'vehicles.create',
      await ctx.platform.vehicles.create(ctx.token as string, ctx.correlationId, input),
      vehicleBody,
    );
  }),
  route(
    'vehicles.get',
    async (ctx) =>
      reply(
        ctx,
        'vehicles.get',
        await ctx.platform.vehicles.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        vehicleBody,
      ),
    { id: ID },
  ),
  route(
    'vehicles.update',
    async (ctx) => {
      const input = body(ctx, ['version', ...VEHICLE_PATCH_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'vehicles.update',
        await ctx.platform.vehicles.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.status',
    async (ctx) => {
      const input = body(ctx, ['version', 'status', 'reason']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'vehicles.status',
        await ctx.platform.vehicles.changeStatus(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
          input['status'],
          input['reason'],
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.odometer',
    async (ctx) => {
      const input = body(ctx, ['version', 'odometerKm']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'vehicles.odometer',
        await ctx.platform.vehicles.recordOdometer(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
          input['odometerKm'],
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'vehicles.archive',
        await ctx.platform.vehicles.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        vehicleBody,
      );
    },
    { id: ID },
  ),
  route(
    'vehicles.history',
    async (ctx) =>
      reply(
        ctx,
        'vehicles.history',
        await ctx.platform.vehicles.history(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        (items) => ({ items }),
      ),
    { id: ID },
  ),
];
