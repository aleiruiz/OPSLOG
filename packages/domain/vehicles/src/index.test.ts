import { describe, expect, it } from 'vitest';
import {
  InMemoryVehicleStore,
  STATUS_TRANSITIONS,
  VEHICLE_STATUSES,
  VehicleError,
  VehicleService,
  applyArchive,
  applyOdometer,
  applyPatch,
  applyStatus,
  canTransition,
  economicNumberKey,
  isLiveVehicle,
  isVehicleStatus,
  newVehicle,
  normalizeEconomicNumber,
  normalizePlate,
  normalizeReason,
  normalizeVin,
  parseNewVehicle,
  parseVehiclePatch,
  plateKey,
  requireOpaqueId,
  requireVersion,
  statusEntry,
  type Vehicle,
  type VehicleStore,
} from './index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const VIN = '1HGCM82633A004352';

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  economicNumber: 'U-001',
  plate: 'ab-123 c',
  vin: VIN,
  make: 'Toyota',
  model: 'Hilux',
  year: 2022,
  areaId: 'area-1',
  odometerKm: 1000,
  ...over,
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof VehicleError ? error.code : 'other';
  }
  return undefined;
};
const rejection = async (promise: Promise<unknown>): Promise<VehicleError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VehicleError) return error;
    throw error;
  }
  throw new Error('expected a VehicleError');
};

function service(store: VehicleStore = new InMemoryVehicleStore()) {
  let ids = 0;
  let clock = NOW;
  const svc = new VehicleService(store, {
    now: () => clock,
    newId: () => `id-${(ids += 1)}`,
  });
  return {
    svc,
    store,
    tick: (ms = 1000) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe('statuses and transitions', () => {
  it('declares the six BRD statuses and a transition table over exactly those', () => {
    expect(VEHICLE_STATUSES).toEqual([
      'active',
      'restricted',
      'in_maintenance',
      'out_of_service',
      'inactive',
      'decommissioned',
    ]);
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...VEHICLE_STATUSES].sort());
    for (const targets of Object.values(STATUS_TRANSITIONS))
      for (const target of targets) expect(VEHICLE_STATUSES).toContain(target);
  });
  it('never lets a status transition to itself and keeps decommissioned terminal', () => {
    for (const status of VEHICLE_STATUSES) expect(canTransition(status, status)).toBe(false);
    for (const status of VEHICLE_STATUSES)
      expect(canTransition('decommissioned', status)).toBe(false);
    expect(STATUS_TRANSITIONS.decommissioned).toEqual([]);
  });
  it('reaches decommissioned from every live status and keeps idle out of workshop states', () => {
    for (const status of VEHICLE_STATUSES.filter((s) => s !== 'decommissioned'))
      expect(canTransition(status, 'decommissioned')).toBe(true);
    expect(canTransition('inactive', 'in_maintenance')).toBe(false);
    expect(canTransition('inactive', 'out_of_service')).toBe(false);
    expect(canTransition('in_maintenance', 'inactive')).toBe(false);
    expect(canTransition('active', 'in_maintenance')).toBe(true);
  });
  it('recognises status ids only', () => {
    expect(isVehicleStatus('active')).toBe(true);
    expect(isVehicleStatus('Activo')).toBe(false);
    expect(isVehicleStatus(1)).toBe(false);
  });
});

describe('field normalization', () => {
  it('normalizes plates and compares them without spaces or hyphens', () => {
    expect(normalizePlate('  ab-123   c ')).toBe('AB-123 C');
    expect(plateKey(normalizePlate('ab-123 c'))).toBe(plateKey('AB123C'));
    for (const bad of [
      '',
      ' ',
      '-AB',
      'AB-',
      'A_B',
      'ABCDEFGHIJKLMNOPQ',
      'ÁB123',
      5,
      null,
      undefined,
    ])
      expect(code(() => normalizePlate(bad))).toBe('invalid_input');
    expect(normalizePlate('A')).toBe('A');
  });
  it('normalizes economic numbers, keeping case for display and folding it for uniqueness', () => {
    expect(normalizeEconomicNumber(' u-001 ')).toBe('u-001');
    expect(economicNumberKey('U-001')).toBe(economicNumberKey('u-001'));
    for (const bad of ['', '-1', 'a'.repeat(33), 'a\nb', 'ñ1', 3])
      expect(code(() => normalizeEconomicNumber(bad))).toBe('invalid_input');
  });
  it('accepts a VIN of 17 ISO characters, upper-cased, or none', () => {
    expect(normalizeVin(null)).toBeNull();
    expect(normalizeVin(undefined)).toBeNull();
    expect(normalizeVin(` ${VIN.toLowerCase()} `)).toBe(VIN);
    for (const bad of [
      '',
      VIN.slice(1),
      `${VIN}0`,
      '1HGCM82633A00435I',
      '1HGCM82633A00435O',
      'Q'.repeat(17),
      7,
    ])
      expect(code(() => normalizeVin(bad))).toBe('invalid_input');
  });
  it('validates reasons', () => {
    expect(normalizeReason('  Siniestro 12 ')).toBe('Siniestro 12');
    for (const bad of ['', '   ', 'a'.repeat(201), 'a\nb', 4, undefined])
      expect(code(() => normalizeReason(bad))).toBe('invalid_input');
    expect(normalizeReason('a'.repeat(200))).toHaveLength(200);
  });
  it('validates identifiers and versions', () => {
    expect(requireOpaqueId('area-1')).toBe('area-1');
    for (const bad of ['', '-a', 'a/b', 'a'.repeat(65), 1, null])
      expect(code(() => requireOpaqueId(bad))).toBe('invalid_input');
    expect(requireVersion(1)).toBe(1);
    for (const bad of [0, 1.5, '1', -1, 2_147_483_647, null])
      expect(code(() => requireVersion(bad))).toBe('invalid_input');
  });
});

describe('parseNewVehicle', () => {
  it('normalizes a complete input and defaults the registration date to today', () => {
    expect(parseNewVehicle(input({ make: ' Toyota ' }), NOW)).toEqual({
      economicNumber: 'U-001',
      plate: 'AB-123 C',
      vin: VIN,
      make: 'Toyota',
      model: 'Hilux',
      year: 2022,
      areaId: 'area-1',
      odometerKm: 1000,
      registeredOn: '2026-10-06',
    });
  });
  it('treats the VIN as optional and accepts a past registration date', () => {
    const withoutVin: Record<string, unknown> = input({ registeredOn: '2020-02-29' });
    delete withoutVin['vin'];
    expect(parseNewVehicle(withoutVin, NOW)).toMatchObject({
      vin: null,
      registeredOn: '2020-02-29',
    });
  });
  it('rejects what is not an object, unknown keys and missing required fields', () => {
    for (const bad of [null, 'x', [], 4])
      expect(code(() => parseNewVehicle(bad, NOW))).toBe('invalid_input');
    expect(code(() => parseNewVehicle(input({ tenantId: 'tenant-b' }), NOW))).toBe('invalid_input');
    expect(code(() => parseNewVehicle(input({ status: 'active' }), NOW))).toBe('invalid_input');
    for (const key of [
      'economicNumber',
      'plate',
      'make',
      'model',
      'year',
      'areaId',
      'odometerKm',
    ]) {
      const rest: Record<string, unknown> = input();
      delete rest[key];
      expect(code(() => parseNewVehicle(rest, NOW))).toBe('invalid_input');
    }
  });
  it('validates every field', () => {
    const bad: Record<string, unknown[]> = {
      make: ['', 'a'.repeat(61), 'a\nb', 3],
      model: ['', ' ', 3],
      year: [1949, 2028, 2022.5, '2022', null],
      areaId: ['', 'a/b', 3],
      odometerKm: [-1, 10_000_000, 1.5, '5', null],
      registeredOn: ['2026-10-07', '2026-02-30', '06/10/2026', 20261006, '2026-13-01'],
    };
    for (const [key, values] of Object.entries(bad))
      for (const value of values)
        expect(
          code(() => parseNewVehicle(input({ [key]: value }), NOW)),
          `${key}=${String(value)}`,
        ).toBe('invalid_input');
    expect(parseNewVehicle(input({ year: 2027 }), NOW).year).toBe(2027);
    expect(parseNewVehicle(input({ registeredOn: '2026-10-06' }), NOW).registeredOn).toBe(
      '2026-10-06',
    );
    expect(parseNewVehicle(input({ odometerKm: 0 }), NOW).odometerKm).toBe(0);
    expect(parseNewVehicle(input({ odometerKm: 9_999_999 }), NOW).odometerKm).toBe(9_999_999);
  });
});

describe('parseVehiclePatch', () => {
  it('returns only the fields that are present, normalized', () => {
    expect(parseVehiclePatch({ plate: 'zz 99', vin: null }, NOW)).toEqual({
      plate: 'ZZ 99',
      vin: null,
    });
    expect(
      parseVehiclePatch(
        { economicNumber: 'X1', make: 'Ford', model: 'Ranger', year: 2020, areaId: 'a2', vin: VIN },
        NOW,
      ),
    ).toEqual({
      economicNumber: 'X1',
      make: 'Ford',
      model: 'Ranger',
      year: 2020,
      areaId: 'a2',
      vin: VIN,
    });
  });
  it('rejects empty patches, unknown or protected keys and invalid values', () => {
    for (const bad of [
      {},
      null,
      [],
      'x',
      { status: 'active' },
      { odometerKm: 5 },
      { tenantId: 'b' },
      { version: 2 },
    ])
      expect(code(() => parseVehiclePatch(bad, NOW))).toBe('invalid_input');
    expect(code(() => parseVehiclePatch({ plate: '' }, NOW))).toBe('invalid_input');
    expect(code(() => parseVehiclePatch({ year: 1800 }, NOW))).toBe('invalid_input');
  });
});

describe('pure state changes', () => {
  const base = (): Vehicle => newVehicle(A, 'v1', parseNewVehicle(input(), NOW), NOW);
  const later = new Date(NOW.getTime() + 5000);

  it('creates an active vehicle at version 1 with an initial history entry', () => {
    const vehicle = base();
    expect(vehicle).toMatchObject({
      status: 'active',
      statusReason: 'Alta',
      version: 1,
      archivedAt: null,
      tenantId: A,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(statusEntry(vehicle, null, 'e1', ACTOR, NOW)).toEqual({
      id: 'e1',
      tenantId: A,
      vehicleId: 'v1',
      from: null,
      to: 'active',
      reason: 'Alta',
      actorId: ACTOR,
      version: 1,
      at: NOW.toISOString(),
    });
  });
  it('patches under the expected version and bumps it', () => {
    const next = applyPatch(base(), { make: 'Ford' }, 1, later);
    expect(next).toMatchObject({ make: 'Ford', version: 2, updatedAt: later.toISOString() });
    expect(code(() => applyPatch(base(), { make: 'Ford' }, 2, later))).toBe('stale_version');
  });
  it('changes status only along allowed transitions, with the reason, and bumps the version', () => {
    const next = applyStatus(base(), 'out_of_service', 'Siniestro 7', 1, later);
    expect(next).toMatchObject({
      status: 'out_of_service',
      statusReason: 'Siniestro 7',
      version: 2,
    });
    expect(code(() => applyStatus(next, 'out_of_service', 'x', 2, later))).toBe(
      'invalid_transition',
    );
    expect(code(() => applyStatus(base(), 'inactive', 'x', 9, later))).toBe('stale_version');
    const inactive = applyStatus(base(), 'inactive', 'Temporada', 1, later);
    expect(code(() => applyStatus(inactive, 'in_maintenance', 'x', 2, later))).toBe(
      'invalid_transition',
    );
  });
  it('makes decommissioned and archived vehicles read-only', () => {
    const gone = applyStatus(base(), 'decommissioned', 'Venta', 1, later);
    expect(code(() => applyStatus(gone, 'active', 'x', 2, later))).toBe('invalid_transition');
    expect(code(() => applyPatch(gone, { make: 'x' }, 2, later))).toBe('immutable');
    expect(code(() => applyOdometer(gone, 5000, 2, later))).toBe('immutable');
    const archived = applyArchive(gone, 2, later);
    expect(archived.archivedAt).toBe(later.toISOString());
    expect(code(() => applyArchive(archived, 3, later))).toBe('immutable');
    expect(code(() => applyStatus(archived, 'active', 'x', 3, later))).toBe('immutable');
    expect(code(() => applyPatch(archived, { make: 'x' }, 3, later))).toBe('immutable');
  });
  it('lets the odometer grow or stay, never decrease (BR-015)', () => {
    const vehicle = base();
    expect(applyOdometer(vehicle, 1500, 1, later)).toMatchObject({ odometerKm: 1500, version: 2 });
    expect(applyOdometer(vehicle, 1000, 1, later)).toBe(vehicle);
    expect(code(() => applyOdometer(vehicle, 999, 1, later))).toBe('odometer_decrease');
    expect(code(() => applyOdometer(vehicle, 2000, 4, later))).toBe('stale_version');
  });
  it('archives under the expected version', () => {
    expect(applyArchive(base(), 1, later)).toMatchObject({
      archivedAt: later.toISOString(),
      version: 2,
    });
    expect(code(() => applyArchive(base(), 3, later))).toBe('stale_version');
  });
});

describe('in-memory store', () => {
  const vehicleOf = (tenant: string, id: string, over: Partial<Vehicle> = {}): Vehicle => ({
    ...newVehicle(tenant, id, parseNewVehicle(input(), NOW), NOW),
    ...over,
  });
  const entryOf = (v: Vehicle) => statusEntry(v, null, `e-${v.id}`, ACTOR, NOW);

  it('keeps tenants apart: same id and same keys in two tenants are different vehicles', async () => {
    const store = new InMemoryVehicleStore();
    const a = vehicleOf(A, 'v1');
    const b = vehicleOf(B, 'v1');
    await store.insert(a, entryOf(a));
    await store.insert(b, entryOf(b));
    expect(await store.find(A, 'v1')).toEqual(a);
    expect(await store.find(B, 'v1')).toEqual(b);
    expect(await store.find('tenant-c', 'v1')).toBeNull();
    expect((await store.list(A, { includeArchived: false }, { limit: 10, offset: 0 })).total).toBe(
      1,
    );
  });
  it('counts live vehicles of one area of one tenant for the Areas module (BR-021 port)', async () => {
    const store = new InMemoryVehicleStore();
    const rows: [string, string, Partial<Vehicle>][] = [
      [A, 'v1', {}],
      [A, 'v2', { economicNumber: 'U-2', plate: 'P2', vin: null, status: 'inactive' }],
      [A, 'v3', { economicNumber: 'U-3', plate: 'P3', vin: null, status: 'decommissioned' }],
      [
        A,
        'v4',
        { economicNumber: 'U-4', plate: 'P4', vin: null, archivedAt: '2026-10-07T00:00:00.000Z' },
      ],
      [A, 'v5', { economicNumber: 'U-5', plate: 'P5', vin: null, areaId: 'area-2' }],
      [B, 'v1', {}],
    ];
    for (const [tenant, id, over] of rows) {
      const v = vehicleOf(tenant, id, over);
      await store.insert(v, entryOf(v));
    }
    // Active and inactive count; decommissioned and archived do not.
    expect(await store.countLiveInArea(A, 'area-1')).toBe(2);
    expect(await store.countLiveInArea(A, 'area-2')).toBe(1);
    expect(await store.countLiveInArea(B, 'area-1')).toBe(1);
    expect(await store.countLiveInArea('tenant-c', 'area-1')).toBe(0);
    expect(isLiveVehicle({ status: 'out_of_service', archivedAt: null })).toBe(true);
    expect(isLiveVehicle({ status: 'decommissioned', archivedAt: null })).toBe(false);
  });
  it('rejects duplicate id, economic number, plate and VIN within one tenant, naming the field', async () => {
    const store = new InMemoryVehicleStore();
    const a = vehicleOf(A, 'v1');
    await store.insert(a, entryOf(a));
    const clash = (over: Partial<Vehicle>) => vehicleOf(A, 'v2', over);
    const fields: [Partial<Vehicle>, string | undefined][] = [
      [{ economicNumber: 'u-001', plate: 'ZZ1', vin: null }, 'economic_number'],
      [{ economicNumber: 'U-002', plate: 'AB123C', vin: null }, 'plate'],
      [{ economicNumber: 'U-002', plate: 'ZZ1', vin: VIN }, 'vin'],
    ];
    for (const [over, field] of fields) {
      const candidate = clash(over);
      expect(await rejection(store.insert(candidate, entryOf(candidate)))).toMatchObject({
        code: 'duplicate',
        field,
      });
    }
    expect(await rejection(store.insert(a, entryOf(a)))).toMatchObject({ code: 'duplicate' });
    const free = clash({ economicNumber: 'U-002', plate: 'ZZ1', vin: null });
    await store.insert(free, entryOf(free));
    const free2 = vehicleOf(A, 'v3', { economicNumber: 'U-003', plate: 'ZZ2', vin: null });
    await store.insert(free2, entryOf(free2)); // several vehicles without VIN are fine
  });
  it('filters, orders and windows listings', async () => {
    const store = new InMemoryVehicleStore();
    const rows = [
      vehicleOf(A, 'v1', { economicNumber: 'B-2', plate: 'P1', vin: null, areaId: 'x' }),
      vehicleOf(A, 'v2', {
        economicNumber: 'a-1',
        plate: 'P2',
        vin: null,
        areaId: 'y',
        status: 'inactive',
      }),
      vehicleOf(A, 'v3', {
        economicNumber: 'C-3',
        plate: 'P3',
        vin: null,
        areaId: 'x',
        archivedAt: NOW.toISOString(),
      }),
    ];
    for (const row of rows) await store.insert(row, entryOf(row));
    const ids = async (filter: Parameters<VehicleStore['list']>[1], limit = 10, offset = 0) =>
      (await store.list(A, filter, { limit, offset })).items.map((v) => v.id);
    expect(await ids({ includeArchived: false })).toEqual(['v2', 'v1']);
    expect(await ids({ includeArchived: true })).toEqual(['v2', 'v1', 'v3']);
    expect(await ids({ includeArchived: true, areaId: 'x' })).toEqual(['v1', 'v3']);
    expect(await ids({ includeArchived: false, status: 'inactive' })).toEqual(['v2']);
    expect(await ids({ includeArchived: true }, 1, 1)).toEqual(['v1']);
    expect((await store.list(A, { includeArchived: true }, { limit: 1, offset: 1 })).total).toBe(3);
    // Same economic number key in another tenant never mixes in.
    const other = vehicleOf(B, 'v1', { economicNumber: 'a-1', plate: 'P2', vin: null });
    await store.insert(other, entryOf(other));
    expect(await ids({ includeArchived: true })).toEqual(['v2', 'v1', 'v3']);
  });
  it('orders equal economic-number keys by id when ids differ (ids are unique per tenant)', async () => {
    const store = new InMemoryVehicleStore();
    const x = vehicleOf(A, 'v-b', { economicNumber: 'N-1', plate: 'Q1', vin: null });
    await store.insert(x, entryOf(x));
    expect(
      (await store.list(A, { includeArchived: false }, { limit: 5, offset: 0 })).items,
    ).toHaveLength(1);
  });
  it('replaces only under the expected version and a non-decreasing odometer', async () => {
    const store = new InMemoryVehicleStore();
    const v = vehicleOf(A, 'v1');
    await store.insert(v, entryOf(v));
    const next = { ...v, version: 2, odometerKm: 1200 };
    expect(await store.replace(next, 5)).toBe(false);
    expect(await store.replace({ ...next, odometerKm: 10 }, 1)).toBe(false);
    expect(await store.replace(vehicleOf(A, 'ghost'), 1)).toBe(false);
    expect(await store.replace(next, 1, statusEntry(next, 'active', 'e2', ACTOR, NOW))).toBe(true);
    expect((await store.find(A, 'v1'))?.version).toBe(2);
    expect(await store.history(A, 'v1')).toHaveLength(2);
    expect(await store.history(B, 'v1')).toEqual([]);
    expect(await store.replace({ ...next, version: 3 }, 2)).toBe(true);
    expect(await store.history(A, 'v1')).toHaveLength(2);
  });
  it('refuses a replace that would collide with another vehicle of the tenant', async () => {
    const store = new InMemoryVehicleStore();
    const one = vehicleOf(A, 'v1');
    const two = vehicleOf(A, 'v2', { economicNumber: 'U-002', plate: 'ZZ1', vin: null });
    await store.insert(one, entryOf(one));
    await store.insert(two, entryOf(two));
    expect(
      await rejection(store.replace({ ...two, version: 2, plate: 'AB123C' }, 1)),
    ).toMatchObject({ code: 'duplicate', field: 'plate' });
    // Keeping its own keys is not a collision with itself.
    expect(await store.replace({ ...two, version: 2, make: 'Ford' }, 1)).toBe(true);
  });
  it('returns copies, so callers cannot change stored rows', async () => {
    const store = new InMemoryVehicleStore();
    const v = vehicleOf(A, 'v1');
    await store.insert(v, entryOf(v));
    const found = (await store.find(A, 'v1')) as { make: string };
    found.make = 'Hacked';
    expect((await store.find(A, 'v1'))?.make).toBe('Toyota');
  });
});

describe('VehicleService', () => {
  it('creates, reads and lists within the tenant, with a history entry for the creation', async () => {
    const { svc } = service();
    const created = await svc.create(A, ACTOR, input());
    expect(created).toMatchObject({ id: 'id-1', tenantId: A, status: 'active', version: 1 });
    expect(await svc.get(A, 'id-1')).toEqual(created);
    expect((await svc.list(A)).items).toEqual([created]);
    expect(await svc.history(A, 'id-1')).toMatchObject([
      { id: 'id-2', from: null, to: 'active', actorId: ACTOR, vehicleId: 'id-1' },
    ]);
  });
  it('answers not_found for ids of another tenant exactly as for unknown ids', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, input());
    const foreign = await rejection(svc.get(B, 'id-1'));
    const unknown = await rejection(svc.get(B, 'nope'));
    expect(foreign).toMatchObject({ code: 'not_found' });
    expect(foreign.message).toBe(unknown.message);
    expect(await rejection(svc.update(B, 'id-1', 1, { make: 'x' }))).toMatchObject({
      code: 'not_found',
    });
    expect(await rejection(svc.changeStatus(B, ACTOR, 'id-1', 1, 'inactive', 'x'))).toMatchObject({
      code: 'not_found',
    });
    expect(await rejection(svc.recordOdometer(B, 'id-1', 1, 5000))).toMatchObject({
      code: 'not_found',
    });
    expect(await rejection(svc.archive(B, 'id-1', 1))).toMatchObject({ code: 'not_found' });
    expect(await rejection(svc.history(B, 'id-1'))).toMatchObject({ code: 'not_found' });
    expect((await svc.get(A, 'id-1')).version).toBe(1);
  });
  it('refuses a store that returns a row of another tenant', async () => {
    const inner = new InMemoryVehicleStore();
    const leaky: VehicleStore = {
      insert: (v, e) => inner.insert(v, e),
      find: async (_tenant, id) => inner.find(A, id),
      list: (t, f, w) => inner.list(t, f, w),
      replace: (n, e, h) => inner.replace(n, e, h),
      history: (t, v) => inner.history(t, v),
      countLiveInArea: (t, a) => inner.countLiveInArea(t, a),
    };
    const { svc } = service(leaky);
    await svc.create(A, ACTOR, input());
    expect(await rejection(svc.get(B, 'id-1'))).toMatchObject({ code: 'not_found' });
  });
  it('validates ids, actor and inputs before touching the store', async () => {
    const { svc } = service();
    expect(await rejection(svc.create('', ACTOR, input()))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.create(A, 'bad actor', input()))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.create(A, ACTOR, { ...input(), tenantId: B }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.get(A, '../x'))).toMatchObject({ code: 'invalid_input' });
    expect(await rejection(svc.get('', 'x'))).toMatchObject({ code: 'invalid_input' });
    expect(await rejection(svc.update(A, 'id-1', 'one', { make: 'x' }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.update(A, 'id-1', 1, {}))).toMatchObject({ code: 'invalid_input' });
    expect(
      await rejection(svc.changeStatus(A, 'bad actor', 'id-1', 1, 'inactive', 'x')),
    ).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, 'id-1', 1, 'Baja', 'x'))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, 'id-1', 1, 'inactive', ''))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.recordOdometer(A, 'id-1', 1, -3))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.archive(A, 'id-1', 0))).toMatchObject({ code: 'invalid_input' });
  });
  it('reports duplicates by field and leaves the store unchanged', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, input());
    expect(
      await rejection(svc.create(A, ACTOR, input({ plate: 'zz1', vin: undefined }))),
    ).toMatchObject({
      code: 'duplicate',
      field: 'economic_number',
    });
    expect(
      await rejection(svc.create(A, ACTOR, input({ economicNumber: 'U-9', vin: undefined }))),
    ).toMatchObject({
      code: 'duplicate',
      field: 'plate',
    });
    expect(
      await rejection(svc.create(A, ACTOR, input({ economicNumber: 'U-9', plate: 'ZZ1' }))),
    ).toMatchObject({
      code: 'duplicate',
      field: 'vin',
    });
    expect((await svc.list(A)).total).toBe(1);
    // The same data is free in another tenant.
    await svc.create(B, ACTOR, input());
    expect((await svc.list(B)).total).toBe(1);
  });
  it('updates under the expected version and rejects a duplicate introduced by the update', async () => {
    const { svc, tick } = service();
    await svc.create(A, ACTOR, input());
    await svc.create(A, ACTOR, input({ economicNumber: 'U-2', plate: 'ZZ1', vin: null }));
    tick();
    const updated = await svc.update(A, 'id-1', 1, { make: 'Ford', vin: null });
    expect(updated).toMatchObject({ make: 'Ford', vin: null, version: 2 });
    expect(updated.updatedAt).not.toBe(updated.createdAt);
    expect(await rejection(svc.update(A, 'id-1', 1, { make: 'Dodge' }))).toMatchObject({
      code: 'stale_version',
    });
    expect(await rejection(svc.update(A, 'id-3', 1, { plate: 'ab123c' }))).toMatchObject({
      code: 'duplicate',
      field: 'plate',
    });
    expect((await svc.get(A, 'id-3')).version).toBe(1);
    expect((await svc.get(A, 'id-1')).make).toBe('Ford');
  });
  it('changes status with reason and history, rejecting stale versions and bad transitions', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, input());
    const out = await svc.changeStatus(A, ACTOR, 'id-1', 1, 'out_of_service', ' Siniestro 12 ');
    expect(out).toMatchObject({
      status: 'out_of_service',
      statusReason: 'Siniestro 12',
      version: 2,
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, 'id-1', 1, 'active', 'x'))).toMatchObject({
      code: 'stale_version',
    });
    expect(
      await rejection(svc.changeStatus(A, ACTOR, 'id-1', 2, 'out_of_service', 'x')),
    ).toMatchObject({
      code: 'invalid_transition',
    });
    await svc.changeStatus(A, ACTOR, 'id-1', 2, 'active', 'Reparado');
    expect((await svc.history(A, 'id-1')).map((e) => [e.from, e.to, e.reason])).toEqual([
      [null, 'active', 'Alta'],
      ['active', 'out_of_service', 'Siniestro 12'],
      ['out_of_service', 'active', 'Reparado'],
    ]);
  });
  it('records the odometer monotonically and treats an equal reading as a no-op', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, input());
    expect(await svc.recordOdometer(A, 'id-1', 1, 1500)).toMatchObject({
      odometerKm: 1500,
      version: 2,
    });
    expect(await rejection(svc.recordOdometer(A, 'id-1', 2, 1499))).toMatchObject({
      code: 'odometer_decrease',
    });
    const same = await svc.recordOdometer(A, 'id-1', 2, 1500);
    expect(same).toMatchObject({ odometerKm: 1500, version: 2 });
    expect((await svc.get(A, 'id-1')).odometerKm).toBe(1500);
  });
  it('archives, hides from default listings and then refuses changes', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, input());
    const archived = await svc.archive(A, 'id-1', 1);
    expect(archived.archivedAt).not.toBeNull();
    expect((await svc.list(A)).items).toEqual([]);
    expect((await svc.list(A, { includeArchived: true })).items).toHaveLength(1);
    expect((await svc.get(A, 'id-1')).archivedAt).not.toBeNull();
    expect(await rejection(svc.update(A, 'id-1', 2, { make: 'x' }))).toMatchObject({
      code: 'immutable',
    });
    expect(await rejection(svc.recordOdometer(A, 'id-1', 2, 9000))).toMatchObject({
      code: 'immutable',
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, 'id-1', 2, 'inactive', 'x'))).toMatchObject({
      code: 'immutable',
    });
    expect(await rejection(svc.archive(A, 'id-1', 2))).toMatchObject({ code: 'immutable' });
  });
  it('validates and applies list filters and windows', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, input());
    await svc.create(
      A,
      ACTOR,
      input({ economicNumber: 'U-2', plate: 'ZZ1', vin: null, areaId: 'area-2' }),
    );
    await svc.changeStatus(A, ACTOR, 'id-3', 1, 'inactive', 'Temporada');
    expect((await svc.list(A, { status: 'inactive' })).items.map((v) => v.id)).toEqual(['id-3']);
    expect((await svc.list(A, { areaId: 'area-1' })).items.map((v) => v.id)).toEqual(['id-1']);
    expect((await svc.list(A, { limit: 1, offset: 1 })).items.map((v) => v.id)).toEqual(['id-3']);
    expect((await svc.list(A, { includeArchived: false, limit: 100 })).total).toBe(2);
    for (const bad of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: '5' },
      { offset: -1 },
      { offset: 1_000_001 },
      { status: 'Activo' },
      { areaId: 'a/b' },
      { includeArchived: 'yes' },
    ])
      expect(await rejection(svc.list(A, bad)), JSON.stringify(bad)).toMatchObject({
        code: 'invalid_input',
      });
    expect(await rejection(svc.list(''))).toMatchObject({ code: 'invalid_input' });
  });
  it('turns a row that vanishes between read and write into not_found', async () => {
    const inner = new InMemoryVehicleStore();
    let vanish = false;
    const racy: VehicleStore = {
      insert: (v, e) => inner.insert(v, e),
      find: async (t, id) => (vanish ? null : inner.find(t, id)),
      list: (t, f, w) => inner.list(t, f, w),
      replace: async () => {
        vanish = true;
        return false;
      },
      history: (t, v) => inner.history(t, v),
      countLiveInArea: (t, a) => inner.countLiveInArea(t, a),
    };
    const { svc } = service(racy);
    await svc.create(A, ACTOR, input());
    expect(await rejection(svc.update(A, 'id-1', 1, { make: 'x' }))).toMatchObject({
      code: 'not_found',
    });
  });
  it('uses the real clock and random ids by default', async () => {
    const svc = new VehicleService(new InMemoryVehicleStore());
    const created = await svc.create(A, ACTOR, input());
    expect(created.id).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    expect(Math.abs(Date.parse(created.createdAt) - Date.now())).toBeLessThan(5000);
  });
  it('errors never carry the offending value', () => {
    const error = new VehicleError('duplicate', 'plate');
    expect(error.message).toBe('Vehicle request rejected: duplicate');
    expect(error.field).toBe('plate');
    expect(error.name).toBe('VehicleError');
  });
});
