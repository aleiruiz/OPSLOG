import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryAreaStore,
  InMemoryVehicleStore,
  type PlatformResponse,
} from '../../../apps/api/composition/src/index.js';
import type { Vehicle, VehicleStatusEntry } from '../../../packages/domain/vehicles/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

/**
 * A vehicle's area must be an ACTIVE area of the SAME tenant when it is set or changed (BR-021),
 * and that check is serialized with the area deactivation, so the two cannot interleave.
 */
let world: World;
afterEach(() => world.dispose());

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const vehicle = (areaId: string, over: Record<string, unknown> = {}) => ({
  economicNumber: 'U-001',
  plate: 'ABC123',
  vin: null,
  make: 'Toyota',
  model: 'Hilux',
  year: 2022,
  areaId,
  odometerKm: 1000,
  ...over,
});

const INVALID_AREA = {
  code: 'invalid_area',
  status: 422,
  message: 'Vehicle request rejected: invalid_area',
  field: 'area_id',
};

/** A vehicle store whose writes can be held open, to interleave them with an area deactivation. */
class HeldVehicleStore extends InMemoryVehicleStore {
  public hold: Promise<void> | null = null;
  public entered: (() => void) | null = null;
  public override async insert(next: Vehicle, entry: VehicleStatusEntry): Promise<void> {
    this.entered?.();
    await this.hold;
    return super.insert(next, entry);
  }
}

const tick = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function setup(adapters: Parameters<typeof createWorld>[0] = {}) {
  world = createWorld(adapters);
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  const area = async (session: Session, name: string) =>
    ok(await world.platform.areas.create(session.token, corr(), { name }));
  return { a, b, admin: a.admin, adminB: b.admin, area };
}

describe('vehicle area validation through the platform', () => {
  it('answers the same field-level 422 for unknown, foreign and inactive areas, and writes nothing', async () => {
    const { admin, adminB, area } = await setup();
    const foreign = await area(adminB, 'Ajena');
    const inactive = await area(admin, 'Cerrada');
    ok(await world.platform.areas.deactivate(admin.token, corr(), inactive.id, 1));
    const { platform } = world;
    for (const areaId of ['desconocida', foreign.id, inactive.id]) {
      const created = await platform.vehicles.create(admin.token, corr(), vehicle(areaId));
      expect(created.error, areaId).toEqual(INVALID_AREA);
    }
    // Nothing was created or audited, and the foreign area is untouched.
    expect(ok(await platform.vehicles.list(admin.token, corr(), {})).total).toBe(0);
    expect(world.audit.list(admin.tenantId).filter((e) => e.entityType === 'vehicle')).toEqual([]);
    expect(ok(await platform.areas.get(adminB.token, corr(), foreign.id)).resourceCounts).toEqual({
      vehicles: 0,
      people: 0,
    });
  });

  it('applies the same rule when an update changes the area, and keeps the version untouched on refusal', async () => {
    const { admin, adminB, area } = await setup();
    const home = await area(admin, 'Base');
    const other = await area(admin, 'Otra');
    const foreign = await area(adminB, 'Ajena');
    const closed = await area(admin, 'Cerrada');
    ok(await world.platform.areas.deactivate(admin.token, corr(), closed.id, 1));
    const { platform } = world;
    const car = ok(await platform.vehicles.create(admin.token, corr(), vehicle(home.id)));
    for (const areaId of ['desconocida', foreign.id, closed.id])
      expect(
        (await platform.vehicles.update(admin.token, corr(), car.id, 1, { areaId })).error,
        areaId,
      ).toEqual(INVALID_AREA);
    expect(ok(await platform.vehicles.get(admin.token, corr(), car.id))).toMatchObject({
      areaId: home.id,
      version: 1,
    });
    expect(
      ok(await platform.vehicles.update(admin.token, corr(), car.id, 1, { areaId: other.id })),
    ).toMatchObject({ areaId: other.id, version: 2 });
    expect(ok(await platform.areas.get(admin.token, corr(), home.id)).resourceCounts.vehicles).toBe(
      0,
    );
  });

  it('keeps a vehicle whose area is unchanged, even when that area is inactive', async () => {
    const areas = new InMemoryAreaStore();
    const { admin, area } = await setup({ adapters: { areas } });
    const home = await area(admin, 'Base');
    const { platform } = world;
    const car = ok(await platform.vehicles.create(admin.token, corr(), vehicle(home.id)));
    // Legacy data: the area was deactivated while the vehicle was already there (BR-021 forbids it
    // through the API now, so the row is written straight into the store).
    await areas.transaction(admin.tenantId, async (tx) => {
      const current = await tx.find(home.id);
      if (!current) throw new Error('area missing');
      await tx.replace(
        { ...current, active: false, version: current.version + 1 },
        current.version,
        {
          id: 'legacy',
          tenantId: admin.tenantId,
          areaId: home.id,
          action: 'deactivated',
          fields: [],
          fromParentId: null,
          toParentId: null,
          actorId: 'user-x',
          version: current.version + 1,
          at: '2026-10-06T12:00:00.000Z',
        },
      );
    });
    // Edits that leave the area alone, or send the same id again, are not blocked.
    expect(
      ok(await platform.vehicles.update(admin.token, corr(), car.id, 1, { make: 'Ford' })),
    ).toMatchObject({ make: 'Ford', areaId: home.id, version: 2 });
    expect(
      ok(await platform.vehicles.update(admin.token, corr(), car.id, 2, { areaId: home.id })),
    ).toMatchObject({ areaId: home.id, version: 3 });
    ok(await platform.vehicles.recordOdometer(admin.token, corr(), car.id, 3, 1200));
    ok(await platform.vehicles.changeStatus(admin.token, corr(), car.id, 4, 'inactive', 'Pausa'));
  });
});

describe('vehicle writes and area deactivation are serialized (BR-021)', () => {
  it('a vehicle created while the area is being checked blocks the deactivation that waits for it', async () => {
    const vehicles = new HeldVehicleStore();
    const { admin, area } = await setup({ adapters: { vehicles } });
    const home = await area(admin, 'Base');
    const { platform } = world;
    let release: () => void = () => undefined;
    vehicles.hold = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (vehicles.entered = resolve));

    const create = platform.vehicles.create(admin.token, corr(), vehicle(home.id));
    await entered; // the area was checked and the insert is in flight under the area lock
    const deactivate = platform.areas.deactivate(admin.token, corr(), home.id, 1);
    let settled = false;
    void deactivate.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false); // waits for the vehicle write: cannot count before it commits
    release();

    const [created, deactivated] = await Promise.all([create, deactivate]);
    expect(created.ok).toBe(true);
    expect(deactivated.error).toMatchObject({
      code: 'area_in_use',
      status: 409,
      field: 'vehicles',
    });
    expect(ok(await platform.areas.get(admin.token, corr(), home.id)).active).toBe(true);
  });

  it('a deactivation in progress makes the vehicle write that waits for it fail with the 422', async () => {
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const counting = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { admin, area } = await setup({
      adapters: {
        people: {
          countActive: async () => {
            entered();
            await gate;
            return 0;
          },
        },
      },
    });
    const home = await area(admin, 'Base');
    const { platform } = world;

    const deactivate = platform.areas.deactivate(admin.token, corr(), home.id, 1);
    await counting; // under the area lock, counting resources
    const create = platform.vehicles.create(admin.token, corr(), vehicle(home.id));
    let settled = false;
    void create.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    release();

    const [created, deactivated] = await Promise.all([create, deactivate]);
    expect(deactivated.ok).toBe(true);
    expect(created.error).toEqual(INVALID_AREA);
    expect(ok(await platform.vehicles.list(admin.token, corr(), {})).total).toBe(0);
  });

  it('exactly one of a concurrent assignment and deactivation wins, and the rule holds', async () => {
    const { admin, area } = await setup();
    const { platform } = world;
    let created = 0;
    let deactivated = 0;
    for (let round = 0; round < 25; round += 1) {
      const home = await area(admin, `Area ${round}`);
      const results = await Promise.all(
        round % 2 === 0
          ? [
              platform.vehicles.create(
                admin.token,
                corr(),
                vehicle(home.id, { economicNumber: `V-${round}`, plate: `P${round}` }),
              ),
              platform.areas.deactivate(admin.token, corr(), home.id, 1),
            ]
          : [
              platform.areas.deactivate(admin.token, corr(), home.id, 1),
              platform.vehicles.create(
                admin.token,
                corr(),
                vehicle(home.id, { economicNumber: `V-${round}`, plate: `P${round}` }),
              ),
            ],
      );
      const [vehicleResult, areaResult] = round % 2 === 0 ? results : [results[1]!, results[0]!];
      expect(vehicleResult.ok !== areaResult.ok, `round ${round}`).toBe(true);
      if (vehicleResult.ok) created += 1;
      else deactivated += 1;
      // BR-021: an inactive area never holds a live vehicle.
      const state = ok(await platform.areas.get(admin.token, corr(), home.id));
      if (!state.active) expect(state.resourceCounts.vehicles).toBe(0);
    }
    expect(created + deactivated).toBe(25);
  });

  it('serializes only per tenant: another tenant is not blocked by a held deactivation', async () => {
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const counting = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { admin, adminB, area } = await setup({
      adapters: {
        people: {
          countActive: async (tenantId) => {
            if (tenantId !== admin.tenantId) return 0;
            entered();
            await gate;
            return 0;
          },
        },
      },
    });
    const home = await area(admin, 'Base');
    const theirs = await area(adminB, 'Base');
    const deactivate = world.platform.areas.deactivate(admin.token, corr(), home.id, 1);
    await counting;
    // Tenant B writes while tenant A's lock is held.
    ok(await world.platform.vehicles.create(adminB.token, corr(), vehicle(theirs.id)));
    release();
    expect((await deactivate).ok).toBe(true);
  });

  it('propagates a store failure of the vehicle write unchanged (duplicate) and releases the lock', async () => {
    const { admin, area } = await setup();
    const { platform } = world;
    const home = await area(admin, 'Base');
    ok(await platform.vehicles.create(admin.token, corr(), vehicle(home.id)));
    const dup = await platform.vehicles.create(admin.token, corr(), vehicle(home.id));
    expect(dup.error).toMatchObject({ code: 'duplicate', status: 409, field: 'economic_number' });
    // The area lock is free again: the area can still be handled.
    expect((await platform.areas.deactivate(admin.token, corr(), home.id, 1)).error).toMatchObject({
      code: 'area_in_use',
    });
  });
});
