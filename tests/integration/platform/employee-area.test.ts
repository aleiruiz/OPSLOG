import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryAreaStore,
  EnvelopePiiCipher,
  InMemoryEmployeeStore,
  LocalDevKms,
  type PlatformResponse,
} from '../../../apps/api/composition/src/index.js';
import type {
  Employee,
  EmployeeHistoryEntry,
} from '../../../packages/domain/employees/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

/**
 * An employee's area must be an ACTIVE area of the SAME tenant when it is set or changed, and the
 * check is serialized with the area deactivation (BR-021), which counts live employees.
 */
let world: World;
afterEach(() => world.dispose());

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

let serial = 0;
const person = (areaId: string, over: Record<string, unknown> = {}) => {
  serial += 1;
  return {
    kind: 'other',
    firstName: 'Luis',
    lastName: 'Gómez',
    areaId,
    employeeNumber: `N-${serial}`,
    ...over,
  };
};

const INVALID_AREA = {
  code: 'invalid_area',
  status: 422,
  message: 'Employee request rejected: invalid_area',
  field: 'area_id',
};

/** An employee store whose inserts can be held open, to interleave them with an area deactivation. */
class HeldEmployeeStore extends InMemoryEmployeeStore {
  public hold: Promise<void> | null = null;
  public entered: (() => void) | null = null;
  public override async insert(next: Employee, entry: EmployeeHistoryEntry): Promise<void> {
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

describe('employee area validation through the platform', () => {
  it('answers the same field-level 422 for unknown, foreign and inactive areas, and writes nothing', async () => {
    const { admin, adminB, area } = await setup();
    const foreign = await area(adminB, 'Ajena');
    const inactive = await area(admin, 'Cerrada');
    ok(await world.platform.areas.deactivate(admin.token, corr(), inactive.id, 1));
    const { platform } = world;
    for (const areaId of ['desconocida', foreign.id, inactive.id])
      expect(
        (await platform.employees.create(admin.token, corr(), person(areaId))).error,
        areaId,
      ).toEqual(INVALID_AREA);
    expect(ok(await platform.employees.list(admin.token, corr(), {})).total).toBe(0);
    expect(world.audit.list(admin.tenantId).filter((e) => e.entityType === 'employee')).toEqual([]);
    expect(ok(await platform.areas.get(adminB.token, corr(), foreign.id)).resourceCounts).toEqual({
      vehicles: 0,
      people: 0,
    });
  });

  it('applies the same rule on updates and keeps the version untouched on refusal', async () => {
    const { admin, adminB, area } = await setup();
    const home = await area(admin, 'Base');
    const other = await area(admin, 'Otra');
    const foreign = await area(adminB, 'Ajena');
    const closed = await area(admin, 'Cerrada');
    ok(await world.platform.areas.deactivate(admin.token, corr(), closed.id, 1));
    const { platform } = world;
    const e = ok(await platform.employees.create(admin.token, corr(), person(home.id)));
    for (const areaId of ['desconocida', foreign.id, closed.id])
      expect(
        (await platform.employees.update(admin.token, corr(), e.id, 1, { areaId })).error,
        areaId,
      ).toEqual(INVALID_AREA);
    expect(ok(await platform.employees.get(admin.token, corr(), e.id))).toMatchObject({
      areaId: home.id,
      version: 1,
    });
    expect(
      ok(await platform.employees.update(admin.token, corr(), e.id, 1, { areaId: other.id })),
    ).toMatchObject({
      areaId: other.id,
      version: 2,
    });
    expect(ok(await platform.areas.get(admin.token, corr(), home.id)).resourceCounts.people).toBe(
      0,
    );
    expect(ok(await platform.areas.get(admin.token, corr(), other.id)).resourceCounts.people).toBe(
      1,
    );
  });

  it('keeps an employee whose area is unchanged, even when that area is inactive', async () => {
    const areas = new InMemoryAreaStore();
    const { admin, area } = await setup({ adapters: { areas } });
    const home = await area(admin, 'Base');
    const { platform } = world;
    const e = ok(await platform.employees.create(admin.token, corr(), person(home.id)));
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
    expect(
      ok(await platform.employees.update(admin.token, corr(), e.id, 1, { position: 'Jefe' })),
    ).toMatchObject({ areaId: home.id, version: 2 });
    expect(
      ok(await platform.employees.update(admin.token, corr(), e.id, 2, { areaId: home.id })),
    ).toMatchObject({ version: 3 });
    ok(await platform.employees.changeStatus(admin.token, corr(), e.id, 3, 'inactive', 'Pausa'));
  });
});

describe('BR-021: live employees block deactivating their area', () => {
  it('counts active, inactive and suspended employees, and frees the area on terminate or archive', async () => {
    const { admin, area } = await setup();
    const { platform } = world;
    const home = await area(admin, 'Base');
    const make = async () =>
      ok(await platform.employees.create(admin.token, corr(), person(home.id)));
    const e1 = await make();
    const e2 = await make();
    const e3 = await make();
    const people = async () =>
      ok(await platform.areas.get(admin.token, corr(), home.id)).resourceCounts.people;
    expect(await people()).toBe(3);
    ok(
      await platform.employees.changeStatus(admin.token, corr(), e2.id, 1, 'inactive', 'Licencia'),
    );
    ok(await platform.employees.changeStatus(admin.token, corr(), e3.id, 1, 'suspended', 'Caso 1'));
    expect(await people()).toBe(3); // inactive and suspended still belong to the area
    expect((await platform.areas.deactivate(admin.token, corr(), home.id, 1)).error).toMatchObject({
      code: 'area_in_use',
      status: 409,
      field: 'people',
    });
    ok(
      await platform.employees.changeStatus(
        admin.token,
        corr(),
        e1.id,
        1,
        'terminated',
        'Renuncia',
      ),
    );
    ok(await platform.employees.changeStatus(admin.token, corr(), e2.id, 2, 'terminated', 'Baja'));
    expect(await people()).toBe(1);
    ok(await platform.employees.archive(admin.token, corr(), e3.id, 2));
    expect(await people()).toBe(0);
    expect((await platform.areas.deactivate(admin.token, corr(), home.id, 1)).ok).toBe(true);
  });

  it('counts per tenant and per area only', async () => {
    const { admin, adminB, area } = await setup();
    const { platform } = world;
    const mine = await area(admin, 'Base');
    const other = await area(admin, 'Otra');
    const theirs = await area(adminB, 'Base');
    ok(await platform.employees.create(adminB.token, corr(), person(theirs.id)));
    ok(await platform.employees.create(admin.token, corr(), person(other.id)));
    expect((await platform.areas.deactivate(admin.token, corr(), mine.id, 1)).ok).toBe(true);
    expect(
      (await platform.areas.deactivate(adminB.token, corr(), theirs.id, 1)).error,
    ).toMatchObject({ field: 'people' });
  });

  it('keeps an adapters.people override working for tests', async () => {
    const { admin, area } = await setup({ adapters: { people: { countActive: async () => 7 } } });
    const home = await area(admin, 'Base');
    expect(
      ok(await world.platform.areas.get(admin.token, corr(), home.id)).resourceCounts.people,
    ).toBe(7);
  });
});

describe('employee writes and area deactivation are serialized (BR-021)', () => {
  it('an employee created while the area is being checked blocks the deactivation that waits for it', async () => {
    const employees = new HeldEmployeeStore();
    const { admin, area } = await setup({
      adapters: { employees, pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')) },
    });
    const home = await area(admin, 'Base');
    const { platform } = world;
    let release: () => void = () => undefined;
    employees.hold = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (employees.entered = resolve));
    const create = platform.employees.create(admin.token, corr(), person(home.id));
    await entered;
    const deactivate = platform.areas.deactivate(admin.token, corr(), home.id, 1);
    let settled = false;
    void deactivate.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    release();
    const [created, deactivated] = await Promise.all([create, deactivate]);
    expect(created.ok).toBe(true);
    expect(deactivated.error).toMatchObject({ code: 'area_in_use', status: 409, field: 'people' });
    expect(ok(await platform.areas.get(admin.token, corr(), home.id)).active).toBe(true);
  });

  it('a deactivation in progress makes the employee write that waits for it fail with the 422', async () => {
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
    await counting;
    const create = platform.employees.create(admin.token, corr(), person(home.id));
    let settled = false;
    void create.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    release();
    const [created, deactivated] = await Promise.all([create, deactivate]);
    expect(deactivated.ok).toBe(true);
    expect(created.error).toEqual(INVALID_AREA);
    expect(ok(await platform.employees.list(admin.token, corr(), {})).total).toBe(0);
  });

  it('exactly one of a concurrent assignment and deactivation wins, and the rule holds', async () => {
    const { admin, area } = await setup();
    const { platform } = world;
    let created = 0;
    for (let round = 0; round < 25; round += 1) {
      const home = await area(admin, `Area ${round}`);
      const assign = () => platform.employees.create(admin.token, corr(), person(home.id));
      const deactivate = () => platform.areas.deactivate(admin.token, corr(), home.id, 1);
      const [employeeResult, areaResult] =
        round % 2 === 0
          ? await Promise.all([assign(), deactivate()])
          : (await Promise.all([deactivate(), assign()])).reverse();
      expect(employeeResult!.ok !== areaResult!.ok, `round ${round}`).toBe(true);
      if (employeeResult!.ok) created += 1;
      const state = ok(await platform.areas.get(admin.token, corr(), home.id));
      if (!state.active) expect(state.resourceCounts.people).toBe(0);
    }
    expect(created).toBeGreaterThan(-1);
  });

  it('a move into an area racing its deactivation also obeys the lock', async () => {
    const { admin, area } = await setup();
    const { platform } = world;
    for (let round = 0; round < 10; round += 1) {
      const from = await area(admin, `Origen ${round}`);
      const to = await area(admin, `Destino ${round}`);
      const e = ok(await platform.employees.create(admin.token, corr(), person(from.id)));
      const [moved, closed] = await Promise.all([
        platform.employees.update(admin.token, corr(), e.id, 1, { areaId: to.id }),
        platform.areas.deactivate(admin.token, corr(), to.id, 1),
      ]);
      expect(moved.ok !== closed.ok, `round ${round}`).toBe(true);
      const state = ok(await platform.areas.get(admin.token, corr(), to.id));
      if (!state.active) expect(state.resourceCounts.people).toBe(0);
    }
  });

  it('serializes only per tenant', async () => {
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
    ok(await world.platform.employees.create(adminB.token, corr(), person(theirs.id)));
    release();
    expect((await deactivate).ok).toBe(true);
  });

  it('releases the lock after a duplicate refusal', async () => {
    const { admin, area } = await setup();
    const { platform } = world;
    const home = await area(admin, 'Base');
    ok(
      await platform.employees.create(
        admin.token,
        corr(),
        person(home.id, { employeeNumber: 'D-1' }),
      ),
    );
    const dup = await platform.employees.create(
      admin.token,
      corr(),
      person(home.id, { employeeNumber: 'D-1' }),
    );
    expect(dup.error).toMatchObject({ code: 'duplicate', status: 409, field: 'employee_number' });
    expect((await platform.areas.deactivate(admin.token, corr(), home.id, 1)).error).toMatchObject({
      code: 'area_in_use',
    });
  });
});
