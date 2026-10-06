import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  VehicleError,
  VehicleService,
  newVehicle,
  parseNewVehicle,
  statusEntry,
  type Vehicle,
} from '../../../domain/vehicles/src/index.js';
import { BINARY_COLLATION, VEHICLE_TABLES } from './entities.js';
import { VehicleStoreError } from './errors.js';
import { TypeOrmVehicleStore, type StoreErrorEvent } from './store.js';
import { adminUrl, startVehiclesDatabase, type VehiclesDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const fields = (over: Record<string, unknown> = {}) => ({
  economicNumber: `U-${randomUUID().slice(0, 8)}`,
  plate: `P${randomUUID().slice(0, 6).toUpperCase()}`,
  vin: null,
  make: 'Toyota',
  model: 'Hilux',
  year: 2022,
  areaId: 'area-1',
  odometerKm: 1000,
  ...over,
});
const vehicleOf = (tenant: string, over: Record<string, unknown> = {}): Vehicle => ({
  ...newVehicle(tenant, randomUUID(), parseNewVehicle(fields(over), NOW), NOW),
});
const entryOf = (v: Vehicle, from: Vehicle['status'] | null = null) =>
  statusEntry(v, from, randomUUID(), ACTOR, NOW);

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

const errnoOf = (error: unknown): number | undefined =>
  (error as { errno?: number; driverError?: { errno?: number } }).driverError?.errno ??
  (error as { errno?: number }).errno;

suite('persistent vehicle store on MySQL', () => {
  let db: VehiclesDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmVehicleStore;
  let storeB: TypeOrmVehicleStore;
  const events: StoreErrorEvent[] = [];

  beforeAll(async () => {
    db = await startVehiclesDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmVehicleStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmVehicleStore(sourceB);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  }, 60_000);

  describe('schema', () => {
    it('is created in its own migrations table with binary collations and company-keyed constraints', async () => {
      const tables = await db.rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [db.databaseName],
      );
      expect(tables.map((row) => row.t).sort()).toEqual(
        [...Object.values(VEHICLE_TABLES), 'opslog_vehicles_migrations'].sort(),
      );
      const columns = await db.rows<{ coll: string }>(
        `SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME <> 'opslog_vehicles_migrations'`,
        [db.databaseName],
      );
      expect(columns.length).toBeGreaterThan(10);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);
      const uniques = await db.rows<{ name: string; col: string; seq: number }>(
        `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 AND TABLE_NAME <> 'opslog_vehicles_migrations'
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db.databaseName],
      );
      // Every unique key, primary keys included, starts with company_id.
      for (const row of uniques.filter((candidate) => candidate.seq === 1))
        expect([row.name, row.col]).toEqual([row.name, 'company_id']);
      expect(
        [...new Set(uniques.map((row) => row.name))].filter((name) => name !== 'PRIMARY').sort(),
      ).toEqual([
        'uq_vehicle_status_history_version',
        'uq_vehicles_economic_number',
        'uq_vehicles_plate',
        'uq_vehicles_vin',
      ]);
    });

    it('rejects out-of-range rows by CHECK constraint, whoever writes them', async () => {
      const base = vehicleOf('tenant-checks');
      const attempt = async (patch: Record<string, unknown>) => {
        const row = {
          company_id: base.tenantId,
          id: randomUUID(),
          economic_number: `E${randomUUID().slice(0, 8)}`,
          economic_number_key: `e${randomUUID().slice(0, 8)}`,
          plate: 'PX1',
          plate_key: `PX${randomUUID().slice(0, 6)}`,
          vin: null,
          make: 'm',
          model: 'm',
          year: 2020,
          area_id: 'a',
          status: 'active',
          status_reason: 'Alta',
          odometer_km: 1,
          registered_on: '2026-10-06',
          version: 1,
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
          ...patch,
        };
        const columns = Object.keys(row);
        return rejection(
          db.admin.query(
            `INSERT INTO ${VEHICLE_TABLES.vehicles} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            Object.values(row),
          ),
        );
      };
      for (const patch of [
        { status: 'Activo' },
        { odometer_km: 10_000_000 },
        { year: 1900 },
        { version: 0 },
        { vin: 'SHORT' },
        { vin: '1HGCM82633A00435I' },
        { registered_on: '06/10/2026' },
        { status_reason: '  ' },
        { plate_key: '' },
      ])
        expect(errnoOf(await attempt(patch)), JSON.stringify(patch)).toBe(3819);
    });

    it('gives the runtime account DML only', async () => {
      const error = await rejection(sourceA.query(`DROP TABLE ${VEHICLE_TABLES.statusHistory}`));
      expect(errnoOf(error)).toBe(1142);
      const alter = await rejection(
        sourceA.query(`ALTER TABLE ${VEHICLE_TABLES.vehicles} DROP COLUMN make`),
      );
      expect(errnoOf(alter)).toBe(1142);
    });
  });

  describe('round trip and tenant isolation', () => {
    it('stores and reads a vehicle with its history, dates at microsecond precision and exact strings', async () => {
      const tenant = randomUUID();
      const v = vehicleOf(tenant, { vin: '1HGCM82633A004352', plate: 'ab-123 c' });
      await storeA.insert(v, entryOf(v));
      expect(await storeB.find(tenant, v.id)).toEqual(v);
      expect(await storeB.history(tenant, v.id)).toMatchObject([
        { from: null, to: 'active', reason: 'Alta', version: 1, actorId: ACTOR },
      ]);
      const raw = await db.rows<Record<string, unknown>>(
        `SELECT company_id, plate, plate_key, economic_number_key FROM ${VEHICLE_TABLES.vehicles} WHERE id = ?`,
        [v.id],
      );
      expect(raw).toEqual([
        {
          company_id: tenant,
          plate: 'AB-123 C',
          plate_key: 'AB123C',
          economic_number_key: v.economicNumber.toLowerCase(),
        },
      ]);
    });

    it('never reaches a row of another company: reads, writes, history and listings', async () => {
      const a = randomUUID();
      const b = randomUUID();
      const vA = vehicleOf(a);
      await storeA.insert(vA, entryOf(vA));
      const vB = vehicleOf(b);
      await storeA.insert(vB, entryOf(vB));
      expect(await storeA.find(b, vA.id)).toBeNull();
      expect(await storeA.history(b, vA.id)).toEqual([]);
      expect(await storeA.replace({ ...vA, tenantId: b, version: 2, make: 'Hacked' }, 1)).toBe(
        false,
      );
      expect((await storeA.find(a, vA.id))?.make).toBe('Toyota');
      const listB = await storeA.list(b, { includeArchived: true }, { limit: 50, offset: 0 });
      expect(listB.items.map((item) => item.id)).toEqual([vB.id]);
      expect(listB.total).toBe(1);
    });

    it('allows the same economic number, plate and VIN in two companies', async () => {
      const shared = { economicNumber: 'FLOTA-1', plate: 'SH-0001', vin: '1M8GDM9AXKP042788' };
      const one = vehicleOf(randomUUID(), shared);
      const two = vehicleOf(randomUUID(), shared);
      await storeA.insert(one, entryOf(one));
      await storeB.insert(two, entryOf(two));
      expect((await storeA.find(two.tenantId, two.id))?.plate).toBe('SH-0001');
    });

    it('refuses a history row that attaches to a vehicle of another company (composite foreign key)', async () => {
      const a = randomUUID();
      const vA = vehicleOf(a);
      await storeA.insert(vA, entryOf(vA));
      const b = randomUUID();
      const vB = vehicleOf(b);
      const foreign = { ...entryOf(vB), vehicleId: vA.id };
      expect(await rejection(storeA.insert(vB, foreign))).toMatchObject({ code: 'integrity' });
      expect(await storeA.find(b, vB.id)).toBeNull();
    });
  });

  describe('uniqueness per company (BR-010)', () => {
    it('names the colliding key; economic number and plate keys are the normalized ones', async () => {
      const tenant = randomUUID();
      const first = vehicleOf(tenant, {
        economicNumber: 'Eco-1',
        plate: 'ab 123',
        vin: '1FTFW1ET1EKE12345',
      });
      await storeA.insert(first, entryOf(first));
      const probe = (over: Record<string, unknown>) => {
        const candidate = vehicleOf(tenant, over);
        return rejection(storeB.insert(candidate, entryOf(candidate)));
      };
      expect(await probe({ economicNumber: 'ECO-1' })).toEqual(
        new VehicleError('duplicate', 'economic_number'),
      );
      expect(await probe({ plate: 'AB-123' })).toEqual(new VehicleError('duplicate', 'plate'));
      expect(await probe({ vin: '1FTFW1ET1EKE12345' })).toEqual(
        new VehicleError('duplicate', 'vin'),
      );
      // No orphan rows from the failed attempts.
      const count = await db.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${VEHICLE_TABLES.vehicles} WHERE company_id = ?`,
        [tenant],
      );
      expect(Number(count[0]?.n)).toBe(1);
    });

    it('treats many vehicles without a VIN as distinct', async () => {
      const tenant = randomUUID();
      for (let i = 0; i < 3; i += 1) {
        const v = vehicleOf(tenant);
        await storeA.insert(v, entryOf(v));
      }
      expect(
        (await storeA.list(tenant, { includeArchived: true }, { limit: 10, offset: 0 })).total,
      ).toBe(3);
    });

    it('lets exactly one of several concurrent creations of the same plate win, from two processes', async () => {
      const tenant = randomUUID();
      const attempts = Array.from({ length: 6 }, (_, i) => {
        const v = vehicleOf(tenant, { plate: 'RACE-1' });
        const store = i % 2 === 0 ? storeA : storeB;
        return store.insert(v, entryOf(v)).then(
          () => 'ok',
          (error: unknown) =>
            error instanceof VehicleError ? `${error.code}:${error.field}` : 'other',
        );
      });
      const results = await Promise.all(attempts);
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result === 'duplicate:plate')).toHaveLength(5);
    });

    it('rejects a duplicate introduced by an update and keeps the vehicle unchanged', async () => {
      const tenant = randomUUID();
      const one = vehicleOf(tenant, { plate: 'UP-1' });
      const two = vehicleOf(tenant, { plate: 'UP-2' });
      await storeA.insert(one, entryOf(one));
      await storeA.insert(two, entryOf(two));
      expect(await rejection(storeA.replace({ ...two, version: 2, plate: 'UP-1' }, 1))).toEqual(
        new VehicleError('duplicate', 'plate'),
      );
      expect((await storeA.find(tenant, two.id))?.version).toBe(1);
    });
  });

  describe('optimistic concurrency and odometer', () => {
    it('lets exactly one of many writers holding the same version win', async () => {
      const tenant = randomUUID();
      const v = vehicleOf(tenant);
      await storeA.insert(v, entryOf(v));
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? storeA : storeB).replace({ ...v, version: 2, make: `Make${i}` }, 1),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await storeA.find(tenant, v.id))?.version).toBe(2);
    });

    it('writes the vehicle change and its history entry atomically', async () => {
      const tenant = randomUUID();
      const v = vehicleOf(tenant);
      await storeA.insert(v, entryOf(v));
      const next: Vehicle = { ...v, status: 'inactive', statusReason: 'Temporada', version: 2 };
      // Two racers carry a history entry each; only the winner's entry may exist.
      const results = await Promise.all([
        storeA.replace(next, 1, entryOf(next, 'active')),
        storeB.replace(next, 1, entryOf(next, 'active')),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await storeA.history(tenant, v.id)).map((entry) => entry.version)).toEqual([1, 2]);
    });

    it('rolls the vehicle change back when its history entry violates a constraint', async () => {
      const tenant = randomUUID();
      const v = vehicleOf(tenant);
      await storeA.insert(v, entryOf(v));
      const next: Vehicle = { ...v, status: 'inactive', statusReason: 'Temporada', version: 2 };
      const bad = { ...entryOf(next, 'active'), version: 1 }; // collides with the creation entry
      expect(await rejection(storeA.replace(next, 1, bad))).toBeInstanceOf(Error);
      expect(await storeA.find(tenant, v.id)).toEqual(v);
    });

    it('never lowers the odometer: the statement itself refuses, even under the current version', async () => {
      const tenant = randomUUID();
      const v = vehicleOf(tenant, { odometerKm: 5000 });
      await storeA.insert(v, entryOf(v));
      expect(await storeA.replace({ ...v, version: 2, odometerKm: 4999 }, 1)).toBe(false);
      expect((await storeA.find(tenant, v.id))?.odometerKm).toBe(5000);
      expect(await storeA.replace({ ...v, version: 2, odometerKm: 5000 }, 1)).toBe(true);
      expect(await storeA.replace({ ...v, version: 3, odometerKm: 7000 }, 2)).toBe(true);
    });

    it('serializes concurrent odometer readings through the service: the highest committed value wins and never decreases', async () => {
      const tenant = randomUUID();
      const svcA = new VehicleService(storeA);
      const svcB = new VehicleService(storeB);
      const created = await svcA.create(tenant, ACTOR, fields({ odometerKm: 100 }));
      const readings = [900, 400, 700, 200, 800, 300];
      const results = await Promise.all(
        readings.map((km, i) =>
          (i % 2 === 0 ? svcA : svcB).recordOdometer(tenant, created.id, 1, km).then(
            () => 'ok',
            (error: unknown) => (error instanceof VehicleError ? error.code : 'other'),
          ),
        ),
      );
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result === 'stale_version')).toHaveLength(5);
      const final = await svcA.get(tenant, created.id);
      expect(readings).toContain(final.odometerKm);
      expect(final.odometerKm).toBeGreaterThan(100);
      // A later, lower reading is refused by the domain rule.
      await expect(
        svcB.recordOdometer(tenant, created.id, final.version, final.odometerKm - 1),
      ).rejects.toMatchObject({ code: 'odometer_decrease' });
    });
  });

  describe('count port for the Areas module', () => {
    it('counts, per company and area, the vehicles that are not archived or decommissioned', async () => {
      const tenant = randomUUID();
      const other = randomUUID();
      const svc = new VehicleService(storeA);
      const live = await svc.create(tenant, ACTOR, fields({ areaId: 'x' }));
      const idle = await svc.create(tenant, ACTOR, fields({ areaId: 'x' }));
      const gone = await svc.create(tenant, ACTOR, fields({ areaId: 'x' }));
      const filed = await svc.create(tenant, ACTOR, fields({ areaId: 'x' }));
      await svc.create(tenant, ACTOR, fields({ areaId: 'y' }));
      await svc.create(other, ACTOR, fields({ areaId: 'x' }));
      await svc.changeStatus(tenant, ACTOR, idle.id, 1, 'inactive', 'Temporada');
      await svc.changeStatus(tenant, ACTOR, gone.id, 1, 'decommissioned', 'Baja');
      await svc.archive(tenant, filed.id, 1);
      expect(live.areaId).toBe('x');
      expect(await storeB.countLiveInArea(tenant, 'x')).toBe(2);
      expect(await storeB.countLiveInArea(tenant, 'y')).toBe(1);
      expect(await storeB.countLiveInArea(other, 'x')).toBe(1);
      expect(await storeB.countLiveInArea(other, 'y')).toBe(0);
    });
  });

  describe('listing', () => {
    it('filters by status and area, hides archived rows by default and pages with a stable order', async () => {
      const tenant = randomUUID();
      const svc = new VehicleService(storeA);
      const created = [];
      for (const [n, area] of [
        ['B-02', 'x'],
        ['a-01', 'y'],
        ['C-03', 'x'],
        ['D-04', 'x'],
      ] as const)
        created.push(await svc.create(tenant, ACTOR, fields({ economicNumber: n, areaId: area })));
      const [b, , c] = created as [Vehicle, Vehicle, Vehicle, Vehicle];
      await svc.changeStatus(tenant, ACTOR, c.id, 1, 'inactive', 'Temporada');
      await svc.archive(tenant, b.id, 1);
      const ids = async (query: Record<string, unknown>) =>
        (await svc.list(tenant, query)).items.map((v) => v.economicNumber);
      expect(await ids({})).toEqual(['a-01', 'C-03', 'D-04']);
      expect(await ids({ includeArchived: true })).toEqual(['a-01', 'B-02', 'C-03', 'D-04']);
      expect(await ids({ areaId: 'x' })).toEqual(['C-03', 'D-04']);
      expect(await ids({ status: 'inactive' })).toEqual(['C-03']);
      expect(await ids({ includeArchived: true, limit: 2, offset: 1 })).toEqual(['B-02', 'C-03']);
      expect((await svc.list(tenant, { limit: 1 })).total).toBe(3);
    });
  });

  describe('failure hygiene', () => {
    it('does not leak plates, VINs or SQL when the database refuses a statement', async () => {
      const tenant = randomUUID();
      const v = vehicleOf(tenant, { plate: 'LEAK-1' });
      // `version` 0 violates a CHECK constraint, which the store reports as integrity.
      const error = await rejection(storeA.insert({ ...v, version: 0 }, entryOf(v)));
      expect(error).toBeInstanceOf(VehicleStoreError);
      expect(error).toMatchObject({ code: 'integrity', errno: 3819 });
      const text = `${(error as Error).message}${JSON.stringify(error)}${JSON.stringify(events)}`;
      for (const secret of ['LEAK-1', tenant, 'INSERT', 'opslog_'])
        expect(text).not.toContain(secret);
    });
  });
});
