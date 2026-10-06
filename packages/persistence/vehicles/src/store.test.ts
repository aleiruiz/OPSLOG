import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  VehicleError,
  VehicleService,
  newVehicle,
  parseNewVehicle,
  statusEntry,
  type Vehicle,
  type VehicleStatusEntry,
} from '../../../domain/vehicles/src/index.js';
import { VehicleEntity, VehicleStatusEntryEntity } from './entities.js';
import { VehicleStoreError } from './errors.js';
import { TypeOrmVehicleStore, type StoreErrorEvent } from './store.js';
import {
  CONNECTION_LOST,
  DEADLOCK,
  DUPLICATE,
  FakeDatabase,
  LOCK_TIMEOUT,
  asDataSource,
} from './test-support/fake-database.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const VIN = '1HGCM82633A004352';

const fields = (over: Record<string, unknown> = {}) => ({
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
const vehicle = (tenant: string, id: string, over: Record<string, unknown> = {}): Vehicle => ({
  ...newVehicle(tenant, id, parseNewVehicle(fields(), NOW), NOW),
  ...over,
});
const entryOf = (v: Vehicle, from: VehicleStatusEntry['from'] = null): VehicleStatusEntry =>
  statusEntry(v, from, `entry-${v.id}-${v.version}`, ACTOR, NOW);

function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmVehicleStore(asDataSource(db), {
    onError: (event) => events.push(event),
    ...options,
  });
  return { db, events, store };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) => new TypeOrmVehicleStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted vehicles account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_vehicles_x' })).toThrow(/MySQL/);
    expect(() =>
      build({ type: 'mysql', username: 'opslog_vehicles_x', synchronize: true }),
    ).toThrow(/synchronize/);
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_identity_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_vehicles_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store } = setup({ maxAttempts: 0 });
    db.failNext('insert', DEADLOCK, { entity: VehicleEntity });
    const v = vehicle(A, 'v1');
    expect(await rejection(store.insert(v, entryOf(v)))).toMatchObject({ code: 'contention' });
  });
});

describe('insert, find and history', () => {
  it('stores the vehicle and its first history entry in one transaction and reads them back', async () => {
    const { db, store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    expect(await store.find(A, 'v1')).toEqual(v);
    expect(await store.history(A, 'v1')).toEqual([entryOf(v)]);
    expect(db.isolations).toEqual(['READ COMMITTED']);
    expect(db.committed(VehicleEntity)).toMatchObject([
      {
        tenantId: A,
        economicNumberKey: 'u-001',
        plateKey: 'AB123C',
        plate: 'AB-123 C',
        registeredOn: '2026-10-06',
      },
    ]);
  });
  it('does not keep a vehicle whose history row cannot be written', async () => {
    const { db, store } = setup();
    const v = vehicle(A, 'v1');
    db.failNext('insert', CONNECTION_LOST, { entity: VehicleStatusEntryEntity });
    expect(await rejection(store.insert(v, entryOf(v)))).toMatchObject({ code: 'unavailable' });
    expect(db.committed(VehicleEntity)).toEqual([]);
  });
  it('refuses a history entry that points at another tenant vehicle (composite key)', async () => {
    const { db, store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    const other = vehicle(B, 'v9');
    const foreign = { ...entryOf(other), vehicleId: 'v1' };
    expect(await rejection(store.insert(other, foreign))).toMatchObject({ code: 'integrity' });
    expect(db.committed(VehicleEntity)).toHaveLength(1);
  });
  it('never returns another tenant rows and filters every statement by company', async () => {
    const { db, store } = setup();
    const a = vehicle(A, 'v1');
    const b = vehicle(B, 'v1', { economicNumber: 'U-001', plate: 'AB-123 C', vin: VIN });
    await store.insert(a, entryOf(a));
    await store.insert(b, entryOf(b));
    expect(await store.find(A, 'v1')).toMatchObject({ tenantId: A });
    expect(await store.find(B, 'v1')).toMatchObject({ tenantId: B });
    expect(await store.find('tenant-c', 'v1')).toBeNull();
    expect(
      (await store.list(A, { includeArchived: true }, { limit: 10, offset: 0 })).items,
    ).toEqual([a]);
    expect(await store.history('tenant-c', 'v1')).toEqual([]);
    expect(await store.history(B, 'v1')).toEqual([entryOf(b)]);
    await store.replace({ ...a, version: 2, make: 'Ford' }, 1);
    expect((await store.find(B, 'v1'))?.make).toBe('Toyota');
    for (const statement of db.statements.filter((s) => s.where !== null))
      expect(statement.where, statement.operation).toHaveProperty('tenantId');
  });
  it('reports corrupt rows as integrity failures without exposing them', async () => {
    const { db, store, events } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    db.seed(VehicleEntity, { ...db.committed(VehicleEntity)[0], status: 'Activo' });
    expect(await rejection(store.find(A, 'v1'))).toMatchObject({ code: 'integrity' });
    const history = db.committed(VehicleStatusEntryEntity)[0] as Record<string, unknown>;
    for (const broken of [{ toStatus: 'Activo' }, { fromStatus: 'Baja' }]) {
      db.seed(VehicleStatusEntryEntity, { ...history, ...broken });
      expect(await rejection(store.history(A, 'v1'))).toMatchObject({ code: 'integrity' });
    }
    expect(events.map((event) => event.code)).toEqual(['integrity', 'integrity', 'integrity']);
  });
});

describe('uniqueness', () => {
  it('names the colliding key and keeps nothing of the failed insert', async () => {
    const { db, store } = setup();
    const first = vehicle(A, 'v1');
    await store.insert(first, entryOf(first));
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ economicNumber: 'u-001', plate: 'ZZ1', vin: null }, 'economic_number'],
      [{ economicNumber: 'U-002', plate: 'AB123C', vin: null }, 'plate'],
      [{ economicNumber: 'U-002', plate: 'ZZ1', vin: VIN }, 'vin'],
    ];
    for (const [over, field] of cases) {
      const candidate = vehicle(A, 'v2', over);
      expect(await rejection(store.insert(candidate, entryOf(candidate)))).toEqual(
        new VehicleError('duplicate', field as never),
      );
    }
    // Same id: duplicate without a field name.
    const same = vehicle(A, 'v1', { economicNumber: 'U-009', plate: 'ZZ9', vin: null });
    const error = await rejection(store.insert(same, entryOf(same)));
    expect(error).toMatchObject({ code: 'duplicate' });
    expect((error as VehicleError).field).toBeUndefined();
    expect(db.committed(VehicleEntity)).toHaveLength(1);
    expect(db.committed(VehicleStatusEntryEntity)).toHaveLength(1);
  });
  it('names only keys taken in the same company, never one that exists in another', async () => {
    const { store } = setup();
    const other = vehicle(B, 'o1', { economicNumber: 'U-001', plate: 'ZZ1', vin: null });
    const mine = vehicle(A, 'v1', { economicNumber: 'U-002', plate: 'AB123C', vin: null });
    await store.insert(other, entryOf(other));
    await store.insert(mine, entryOf(mine));
    // The economic number exists only in B: the same-company plate clash must be named.
    const candidate = vehicle(A, 'v2', { economicNumber: 'U-001', plate: 'AB-123C', vin: null });
    expect(await rejection(store.insert(candidate, entryOf(candidate)))).toEqual(
      new VehicleError('duplicate', 'plate'),
    );
  });
  it('allows the same keys in another company and several vehicles without a VIN', async () => {
    const { store } = setup();
    for (const [tenant, id, n, plate] of [
      [A, 'v1', 'U-1', 'P1'],
      [B, 'v1', 'U-1', 'P1'],
      [A, 'v2', 'U-2', 'P2'],
    ] as const) {
      const v = vehicle(tenant, id, { economicNumber: n, plate, vin: null });
      await store.insert(v, entryOf(v));
    }
    const { total } = await store.list(A, { includeArchived: true }, { limit: 10, offset: 0 });
    expect(total).toBe(2);
  });
  it('maps a race on an update to a duplicate naming the key', async () => {
    const { db, store } = setup();
    const one = vehicle(A, 'v1');
    const two = vehicle(A, 'v2', { economicNumber: 'U-2', plate: 'ZZ1', vin: null });
    await store.insert(one, entryOf(one));
    await store.insert(two, entryOf(two));
    expect(await rejection(store.replace({ ...two, version: 2, plate: 'AB123C' }, 1))).toEqual(
      new VehicleError('duplicate', 'plate'),
    );
    expect(await rejection(store.replace({ ...two, version: 2, vin: VIN }, 1))).toEqual(
      new VehicleError('duplicate', 'vin'),
    );
    expect((await store.find(A, 'v2'))?.version).toBe(1);
    // Its own keys never collide with itself.
    expect(await store.replace({ ...two, version: 2, make: 'Ford' }, 1)).toBe(true);
    expect(db.committed(VehicleEntity)).toHaveLength(2);
  });
  it('still reports a duplicate when the key lookup itself fails, without leaking', async () => {
    const { db, store, events } = setup();
    const one = vehicle(A, 'v1');
    await store.insert(one, entryOf(one));
    const clash = vehicle(A, 'v2', { economicNumber: 'U-2', plate: 'AB123C', vin: null });
    db.failNext('find', CONNECTION_LOST, { leak: 'AB123C' });
    const error = await rejection(store.insert(clash, entryOf(clash)));
    expect(error).toBeInstanceOf(VehicleStoreError);
    expect(JSON.stringify(error)).not.toContain('AB123C');
    expect(events).toMatchObject([{ operation: 'insert', code: 'unavailable', errno: 2013 }]);
  });
  it('reports a driver duplicate on reads as an unavailable store (not a vehicle conflict)', async () => {
    const { db, store } = setup();
    db.failNext('find', DUPLICATE);
    expect(await rejection(store.find(A, 'v1'))).toMatchObject({
      code: 'unavailable',
      errno: 1062,
    });
  });
});

describe('replace (optimistic concurrency)', () => {
  it('writes under the expected version, bumps it and appends the history entry together', async () => {
    const { store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    const next = { ...v, status: 'inactive' as const, statusReason: 'Temporada', version: 2 };
    expect(await store.replace(next, 1, entryOf(next, 'active'))).toBe(true);
    expect(await store.find(A, 'v1')).toEqual(next);
    expect((await store.history(A, 'v1')).map((e) => [e.version, e.from, e.to])).toEqual([
      [1, null, 'active'],
      [2, 'active', 'inactive'],
    ]);
  });
  it('returns false for a stale version, an unknown id and another tenant, changing nothing', async () => {
    const { db, store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    const before = db.committed(VehicleEntity);
    const next = { ...v, version: 2, make: 'Ford' };
    expect(await store.replace(next, 7)).toBe(false);
    expect(await store.replace({ ...next, id: 'ghost' }, 1)).toBe(false);
    expect(await store.replace({ ...next, tenantId: B }, 1)).toBe(false);
    expect(db.committed(VehicleEntity)).toEqual(before);
  });
  it('lets exactly one of two writers holding the same version win', async () => {
    const { store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    const results = await Promise.all([
      store.replace({ ...v, version: 2, make: 'Ford' }, 1),
      store.replace({ ...v, version: 2, make: 'Dodge' }, 1),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.find(A, 'v1'))?.version).toBe(2);
  });
  it('never lowers the odometer, even under the right version (BR-015 guard in the statement)', async () => {
    const { store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    expect(await store.replace({ ...v, version: 2, odometerKm: 999 }, 1)).toBe(false);
    expect(await store.replace({ ...v, version: 2, odometerKm: 1000 }, 1)).toBe(true);
    expect(await store.replace({ ...v, version: 3, odometerKm: 1500 }, 2)).toBe(true);
    expect((await store.find(A, 'v1'))?.odometerKm).toBe(1500);
  });
  it('rolls back the vehicle change when the history row cannot be written', async () => {
    const { db, store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    const next = { ...v, status: 'inactive' as const, statusReason: 'x', version: 2 };
    db.failNext('insert', CONNECTION_LOST, { entity: VehicleStatusEntryEntity });
    expect(await rejection(store.replace(next, 1, entryOf(next, 'active')))).toMatchObject({
      code: 'unavailable',
    });
    expect(await store.find(A, 'v1')).toEqual(v);
  });
  it('archives by writing the timestamp and hides the vehicle from default listings', async () => {
    const { store } = setup();
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    const archived = { ...v, version: 2, archivedAt: '2026-10-07T00:00:00.000Z' };
    expect(await store.replace(archived, 1)).toBe(true);
    expect((await store.find(A, 'v1'))?.archivedAt).toBe('2026-10-07T00:00:00.000Z');
    expect((await store.list(A, { includeArchived: false }, { limit: 5, offset: 0 })).total).toBe(
      0,
    );
    expect((await store.list(A, { includeArchived: true }, { limit: 5, offset: 0 })).total).toBe(1);
  });
});

describe('list', () => {
  it('filters, orders by economic number then id, and windows with a total', async () => {
    const { store } = setup();
    const rows = [
      vehicle(A, 'v1', { economicNumber: 'B-2', plate: 'P1', vin: null, areaId: 'x' }),
      vehicle(A, 'v2', {
        economicNumber: 'A-1',
        plate: 'P2',
        vin: null,
        areaId: 'y',
        status: 'inactive',
      }),
      vehicle(A, 'v3', {
        economicNumber: 'C-3',
        plate: 'P3',
        vin: null,
        areaId: 'x',
        archivedAt: NOW.toISOString(),
      }),
    ];
    for (const row of rows) await store.insert(row, entryOf(row));
    const ids = async (
      filter: Parameters<typeof store.list>[1],
      window = { limit: 10, offset: 0 },
    ) => (await store.list(A, filter, window)).items.map((v) => v.id);
    expect(await ids({ includeArchived: false })).toEqual(['v2', 'v1']);
    expect(await ids({ includeArchived: true })).toEqual(['v2', 'v1', 'v3']);
    expect(await ids({ includeArchived: true, areaId: 'x' })).toEqual(['v1', 'v3']);
    expect(await ids({ includeArchived: false, status: 'inactive' })).toEqual(['v2']);
    expect(await ids({ includeArchived: true }, { limit: 1, offset: 1 })).toEqual(['v1']);
    expect((await store.list(A, { includeArchived: true }, { limit: 1, offset: 1 })).total).toBe(3);
  });
});

describe('failures', () => {
  it('retries deadlocks and lock timeouts, then succeeds', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: VehicleEntity });
    db.failNext('insert', LOCK_TIMEOUT, { entity: VehicleEntity });
    const v = vehicle(A, 'v1');
    await store.insert(v, entryOf(v));
    expect(db.committed(VehicleEntity)).toHaveLength(1);
    expect(db.transactions).toBe(3);
    expect(events).toEqual([]);
  });
  it('gives up after the attempt budget with a contention error', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: VehicleEntity, times: 5 });
    const v = vehicle(A, 'v1');
    expect(await rejection(store.insert(v, entryOf(v)))).toMatchObject({
      code: 'contention',
      errno: 1213,
    });
    expect(db.transactions).toBe(3);
    expect(events).toEqual([{ operation: 'insert', code: 'contention', errno: 1213 }]);
  });
  it('sanitizes driver errors: no plate, VIN, tenant or SQL in the message, JSON or event', async () => {
    const { db, store, events } = setup();
    const v = vehicle(A, 'v1');
    db.failNext('insert', CONNECTION_LOST, { entity: VehicleEntity, leak: 'secret-tenant-a' });
    const error = await rejection(store.insert(v, entryOf(v)));
    expect(error).toBeInstanceOf(VehicleStoreError);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(events)}`;
    for (const secret of [
      'secret-tenant-a',
      'AB-123 C',
      VIN,
      'INSERT INTO',
      'opslog_',
      'QueryFailedError',
    ])
      expect(text).not.toContain(secret);
    expect(events).toEqual([{ operation: 'insert', code: 'unavailable', errno: 2013 }]);
  });
  it('classifies a non-driver failure as internal and never throws from the sanitizer', async () => {
    const { db, store, events } = setup();
    db.intercept = (operation) => {
      if (operation === 'find') throw new TypeError('boom with AB-123 C');
    };
    const error = await rejection(store.find(A, 'v1'));
    expect(error).toMatchObject({ code: 'internal', errno: null });
    expect((error as Error).message).not.toContain('AB-123 C');
    expect(events).toEqual([{ operation: 'find', code: 'internal', errno: null }]);
    db.intercept = () => {
      throw new Proxy(
        {},
        {
          get() {
            throw new Error('hostile');
          },
        },
      );
    };
    expect(await rejection(store.find(A, 'v1'))).toMatchObject({ code: 'internal' });
  });
});

describe('through the domain service', () => {
  it('runs the full lifecycle over the store, with tenant isolation', async () => {
    const { store } = setup();
    let ids = 0;
    const svc = new VehicleService(store, { now: () => NOW, newId: () => `id-${(ids += 1)}` });
    const created = await svc.create(A, ACTOR, fields());
    await svc.create(B, ACTOR, fields());
    const moved = await svc.changeStatus(A, ACTOR, created.id, 1, 'out_of_service', 'Siniestro');
    await svc.recordOdometer(A, created.id, moved.version, 2500);
    await expect(svc.recordOdometer(A, created.id, 3, 2000)).rejects.toMatchObject({
      code: 'odometer_decrease',
    });
    await expect(svc.get(B, created.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await svc.history(A, created.id)).map((e) => e.to)).toEqual([
      'active',
      'out_of_service',
    ]);
    await svc.archive(A, created.id, 3);
    expect((await svc.list(A)).total).toBe(0);
    expect((await svc.list(B)).total).toBe(1);
  });
});
