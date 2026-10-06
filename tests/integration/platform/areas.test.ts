import { afterEach, describe, expect, it } from 'vitest';
import {
  AREA_PERMISSIONS,
  AreasApi,
  InMemoryAreaStore,
  type AreaView,
  type PlatformResponse,
  type RoleName,
} from '../../../apps/api/composition/src/index.js';
import {
  AreaService,
  NO_RESOURCES,
  type AreaStore,
} from '../../../packages/domain/areas/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

interface Fixture {
  readonly a: Awaited<ReturnType<World['tenant']>>;
  readonly b: Awaited<ReturnType<World['tenant']>>;
  readonly roles: Readonly<Record<RoleName, Session>>;
  readonly adminB: Session;
}

async function fixture(w: World): Promise<Fixture> {
  const a = await w.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await w.tenant('Empresa Beta', 'subject-admin-b');
  const roles = {
    admin: a.admin,
    editor: await w.member(a.admin, 'editor', 'subject-editor-a'),
    viewer: await w.member(a.admin, 'viewer', 'subject-viewer-a'),
    auditor: await w.member(a.admin, 'auditor', 'subject-auditor-a'),
    pii_reader: await w.member(a.admin, 'pii_reader', 'subject-pii-a'),
  } as const;
  return { a, b, roles, adminB: b.admin };
}

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const seed = async (w: World, session: Session, input: Record<string, unknown> = {}) =>
  ok(await w.platform.areas.create(session.token, corr(), { name: 'Operaciones', ...input }));

const auditOf = (w: World, tenantId: string) =>
  w.audit.list(tenantId).filter((event) => event.entityType === 'area');

const vehicleInput = (areaId: string, over: Record<string, unknown> = {}) => ({
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

describe('area lifecycle through the platform', () => {
  it('creates, reads, edits, moves, deactivates and reactivates, auditing each write without field values', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;

    const root = await seed(world, admin, { name: 'Pais Secreto', code: 'mx' });
    expect(root).toMatchObject({
      name: 'Pais Secreto',
      code: 'MX',
      parentId: null,
      depth: 1,
      active: true,
      version: 1,
      responsibleIds: [],
      deactivatedAt: null,
    });
    expect(root).not.toHaveProperty('tenantId');
    const city = await seed(world, admin, { name: 'Ciudad', parentId: root.id });
    expect(city).toMatchObject({ depth: 2, parentId: root.id });
    expect(ok(await platform.areas.get(admin.token, corr(), root.id))).toEqual({
      ...root,
      resourceCounts: { vehicles: 0, people: 0 },
    });

    const edited = ok(
      await platform.areas.update(admin.token, corr(), city.id, 1, {
        name: 'Ciudad Norte',
        responsibleIds: [f.roles.editor.identityId, admin.identityId],
      }),
    );
    expect(edited).toMatchObject({ name: 'Ciudad Norte', version: 2 });
    expect(edited.responsibleIds).toEqual([f.roles.editor.identityId, admin.identityId].sort());
    // A no-op edit changes nothing and is not audited.
    expect(
      ok(await platform.areas.update(admin.token, corr(), city.id, 2, { name: 'Ciudad Norte' })),
    ).toEqual(edited);
    const moved = ok(
      await platform.areas.update(admin.token, corr(), city.id, 2, { parentId: null }),
    );
    expect(moved).toMatchObject({ parentId: null, depth: 1, version: 3 });
    const off = ok(await platform.areas.deactivate(admin.token, corr(), city.id, 3));
    expect(off).toMatchObject({ active: false, version: 4 });
    expect(off.deactivatedAt).not.toBeNull();
    expect(ok(await platform.areas.list(admin.token, corr(), {})).items.map((a) => a.id)).toEqual([
      root.id,
    ]);
    expect(
      ok(await platform.areas.list(admin.token, corr(), { includeInactive: true })).total,
    ).toBe(2);
    expect(ok(await platform.areas.activate(admin.token, corr(), city.id, 4))).toMatchObject({
      active: true,
      deactivatedAt: null,
      version: 5,
    });

    const history = ok(await platform.areas.history(admin.token, corr(), city.id, {}));
    expect(history.total).toBe(5);
    expect(history.items.map((entry) => [entry.version, entry.action, entry.fields])).toEqual([
      [5, 'activated', []],
      [4, 'deactivated', []],
      [3, 'updated', ['parent']],
      [2, 'updated', ['name', 'responsibles']],
      [1, 'created', []],
    ]);
    expect(history.items[2]).toMatchObject({ fromParentId: root.id, toParentId: null });
    expect(history.items[0]?.actorId).toBe(`user-${admin.identityId}`);

    const trail = auditOf(world, f.a.tenantId);
    expect(trail.map((event) => event.action)).toEqual([
      'area.created',
      'area.created',
      'area.updated',
      'area.updated',
      'area.moved',
      'area.deactivated',
      'area.activated',
    ]);
    for (const event of trail)
      expect(event.actor).toEqual({ id: `user-${admin.identityId}`, kind: 'user' });
    // Audit carries ids and actions only: no names, codes or user ids.
    const text = JSON.stringify(trail);
    for (const secret of ['Pais Secreto', 'Ciudad', 'MX', f.roles.editor.identityId])
      expect(text).not.toContain(secret);
    expect(JSON.stringify(history)).not.toContain('Ciudad');
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
  });

  it('enforces the tree rules end to end: four levels, cycles, subtree depth and parents', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const admin = roles.admin;
    const l1 = await seed(world, admin, { name: 'N1' });
    const l2 = await seed(world, admin, { name: 'N2', parentId: l1.id });
    const l3 = await seed(world, admin, { name: 'N3', parentId: l2.id });
    const l4 = await seed(world, admin, { name: 'N4', parentId: l3.id });
    expect(l4.depth).toBe(4);
    const rejected = async (p: Promise<PlatformResponse<unknown>>) => (await p).error;
    expect(
      await rejected(platform.areas.create(admin.token, corr(), { name: 'N5', parentId: l4.id })),
    ).toMatchObject({ code: 'invalid_hierarchy', status: 422 });
    expect(
      await rejected(platform.areas.update(admin.token, corr(), l1.id, 1, { parentId: l4.id })),
    ).toMatchObject({ code: 'invalid_hierarchy', status: 422 });
    const other = await seed(world, admin, { name: 'Otra' });
    const deep = await seed(world, admin, { name: 'Deep', parentId: other.id });
    // l2 (height 2) under `deep` (level 2) would reach level 6.
    expect(
      await rejected(platform.areas.update(admin.token, corr(), l2.id, 1, { parentId: deep.id })),
    ).toMatchObject({ code: 'invalid_hierarchy' });
    // Moving the whole subtree up works and re-levels it.
    ok(await platform.areas.update(admin.token, corr(), l2.id, 1, { parentId: null }));
    expect(ok(await platform.areas.get(admin.token, corr(), l4.id)).depth).toBe(3);
  });
});

describe('deactivation rules (FR-042, BR-021)', () => {
  it('refuses with 409 while active vehicles remain, and allows it once they are archived or decommissioned', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles, a } = await fixture(world);
    const admin = roles.admin;
    const area = await seed(world, admin);
    const car = ok(await platform.vehicles.create(admin.token, corr(), vehicleInput(area.id)));
    const blocked = await platform.areas.deactivate(admin.token, corr(), area.id, 1);
    expect(blocked.error).toEqual({
      code: 'area_in_use',
      status: 409,
      message: 'Area request rejected: area_in_use',
      field: 'vehicles',
    });
    expect(ok(await platform.areas.get(admin.token, corr(), area.id)).resourceCounts).toEqual({
      vehicles: 1,
      people: 0,
    });
    expect(ok(await platform.areas.get(admin.token, corr(), area.id)).active).toBe(true);
    // The refusal is not audited.
    expect(auditOf(world, a.tenantId).map((e) => e.action)).toEqual(['area.created']);
    // Inactive still counts: the vehicle can come back to service in this area.
    ok(await platform.vehicles.changeStatus(admin.token, corr(), car.id, 1, 'inactive', 'Pausa'));
    expect((await platform.areas.deactivate(admin.token, corr(), area.id, 1)).error).toMatchObject({
      code: 'area_in_use',
      field: 'vehicles',
    });
    ok(
      await platform.vehicles.changeStatus(
        admin.token,
        corr(),
        car.id,
        2,
        'decommissioned',
        'Baja',
      ),
    );
    expect(ok(await platform.areas.deactivate(admin.token, corr(), area.id, 1)).active).toBe(false);
  });

  it('counts vehicles of the same tenant only', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const mine = await seed(world, f.roles.admin);
    // A vehicle of the other company that carries the same opaque area id does not block.
    ok(await platform.vehicles.create(f.adminB.token, corr(), vehicleInput(mine.id)));
    expect(
      ok(await platform.areas.deactivate(f.roles.admin.token, corr(), mine.id, 1)).active,
    ).toBe(false);
  });

  it('asks the people port, and refuses while active people remain', async () => {
    let people = 2;
    world = createWorld({
      adapters: { people: { countActive: async () => people } },
    });
    const { platform } = world;
    const { roles } = await fixture(world);
    const area = await seed(world, roles.admin);
    expect(
      (await platform.areas.deactivate(roles.admin.token, corr(), area.id, 1)).error,
    ).toMatchObject({ code: 'area_in_use', status: 409, field: 'people' });
    people = 0;
    expect(ok(await platform.areas.deactivate(roles.admin.token, corr(), area.id, 1)).active).toBe(
      false,
    );
  });

  it('refuses while active sub-areas remain, with no cascade', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const root = await seed(world, roles.admin, { name: 'Raiz' });
    const child = await seed(world, roles.admin, { name: 'Hija', parentId: root.id });
    expect(
      (await platform.areas.deactivate(roles.admin.token, corr(), root.id, 1)).error,
    ).toMatchObject({ code: 'area_in_use', status: 409, field: 'sub_areas' });
    expect(ok(await platform.areas.get(roles.admin.token, corr(), child.id)).active).toBe(true);
    ok(await platform.areas.deactivate(roles.admin.token, corr(), child.id, 1));
    expect(ok(await platform.areas.deactivate(roles.admin.token, corr(), root.id, 1)).active).toBe(
      false,
    );
  });
});

describe('responsible users (FR-041)', () => {
  it('accepts only active members of the same tenant, by opaque id', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const area = await seed(world, admin, {
      responsibleIds: [f.roles.viewer.identityId, f.roles.admin.identityId],
    });
    expect(area.responsibleIds).toEqual([f.roles.viewer.identityId, admin.identityId].sort());
    // A member of another company, an unknown id and a revoked member are refused alike.
    await platform.removeMember(admin.token, corr(), f.roles.auditor.identityId);
    for (const id of [f.adminB.identityId, 'no-such-user', f.roles.auditor.identityId])
      expect(
        (await platform.areas.create(admin.token, corr(), { name: 'X', responsibleIds: [id] }))
          .error,
      ).toMatchObject({ code: 'invalid_responsible', status: 422 });
    expect(
      (
        await platform.areas.update(admin.token, corr(), area.id, 1, {
          responsibleIds: [f.adminB.identityId],
        })
      ).error,
    ).toMatchObject({ code: 'invalid_responsible' });
    expect(ok(await platform.areas.get(admin.token, corr(), area.id)).version).toBe(1);
    expect(ok(await platform.areas.list(admin.token, corr(), {})).total).toBe(1);
  });
});

const OPERATIONS: Readonly<
  Record<
    string,
    {
      permission: string;
      run: (w: World, s: Session, area: AreaView) => Promise<PlatformResponse<unknown>>;
    }
  >
> = {
  list: { permission: 'view', run: (w, s) => w.platform.areas.list(s.token, corr(), {}) },
  get: { permission: 'view', run: (w, s, a) => w.platform.areas.get(s.token, corr(), a.id) },
  history: {
    permission: 'view',
    run: (w, s, a) => w.platform.areas.history(s.token, corr(), a.id, {}),
  },
  create: {
    permission: 'create',
    run: (w, s) => w.platform.areas.create(s.token, corr(), { name: `Nueva ${corr()}` }),
  },
  update: {
    permission: 'edit',
    run: (w, s, a) => w.platform.areas.update(s.token, corr(), a.id, 1, { name: `Otra ${corr()}` }),
  },
  deactivate: {
    permission: 'delete',
    run: (w, s, a) => w.platform.areas.deactivate(s.token, corr(), a.id, 1),
  },
};

const ROLE_GRANTS: Readonly<Record<RoleName, readonly string[]>> = {
  admin: ['view', 'create', 'edit', 'delete'],
  editor: ['view', 'create', 'edit'],
  viewer: ['view'],
  auditor: ['view'],
  pii_reader: ['view', 'create'],
};

describe('role matrix over the existing generic permissions', () => {
  for (const role of Object.keys(ROLE_GRANTS) as RoleName[])
    it(`${role}: allowed exactly ${ROLE_GRANTS[role].join(', ')}; denied operations change nothing and are not audited`, async () => {
      world = createWorld();
      const f = await fixture(world);
      let n = 0;
      for (const [name, { run, permission }] of Object.entries(OPERATIONS)) {
        const target = await seed(world, f.roles.admin, { name: `Objetivo ${(n += 1)}` });
        const audited = auditOf(world, f.a.tenantId).length;
        const result = await run(world, f.roles[role], target);
        const allowed = ROLE_GRANTS[role].includes(permission);
        if (allowed) {
          expect(result.ok, `${role} ${name}`).toBe(true);
          expect(auditOf(world, f.a.tenantId).length - audited).toBe(permission === 'view' ? 0 : 1);
        } else {
          expect(result.error, `${role} ${name}`).toMatchObject({ code: 'forbidden', status: 403 });
          expect(result.value).toBeUndefined();
          expect(auditOf(world, f.a.tenantId)).toHaveLength(audited);
          expect(
            ok(await world.platform.areas.get(f.roles.admin.token, corr(), target.id)),
          ).toMatchObject({ ...target });
        }
      }
    });

  it('requires the edit permission to reactivate and delete to deactivate', async () => {
    world = createWorld();
    const f = await fixture(world);
    const area = await seed(world, f.roles.admin);
    expect(
      (await world.platform.areas.deactivate(f.roles.editor.token, corr(), area.id, 1)).error,
    ).toMatchObject({ code: 'forbidden' });
    ok(await world.platform.areas.deactivate(f.roles.admin.token, corr(), area.id, 1));
    expect(
      (await world.platform.areas.activate(f.roles.viewer.token, corr(), area.id, 2)).error,
    ).toMatchObject({ code: 'forbidden' });
    expect(
      ok(await world.platform.areas.activate(f.roles.editor.token, corr(), area.id, 2)).active,
    ).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('answers not_found to another tenant for every id-based operation, exactly as for an unknown id, and changes nothing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const area = await seed(world, f.roles.admin);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const run = (id: string) => ({
      get: platform.areas.get(f.adminB.token, corr(), id),
      history: platform.areas.history(f.adminB.token, corr(), id, {}),
      update: platform.areas.update(f.adminB.token, corr(), id, 1, { name: 'Robada' }),
      deactivate: platform.areas.deactivate(f.adminB.token, corr(), id, 1),
      activate: platform.areas.activate(f.adminB.token, corr(), id, 1),
    });
    const foreign = run(area.id);
    const missing = run(unknown);
    for (const name of Object.keys(foreign) as (keyof typeof foreign)[]) {
      const [a, b] = await Promise.all([foreign[name], missing[name]]);
      expect(a.error, name).toMatchObject({ code: 'not_found', status: 404 });
      expect(a, name).toEqual(b);
    }
    expect(ok(await platform.areas.get(f.roles.admin.token, corr(), area.id))).toMatchObject(area);
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
  });

  it('hides foreign parents: a parent of another company is refused exactly like an unknown one', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const theirs = await seed(world, f.adminB);
    const mine = await seed(world, f.roles.admin, { name: 'Mia' });
    const attempts = async (parentId: string) => [
      await platform.areas.create(f.roles.admin.token, corr(), { name: 'Hija', parentId }),
      await platform.areas.update(f.roles.admin.token, corr(), mine.id, 1, { parentId }),
    ];
    expect(await attempts(theirs.id)).toEqual(
      await attempts('00000000-0000-4000-8000-000000000000'),
    );
    expect((await attempts(theirs.id))[0]?.error).toMatchObject({ code: 'invalid_hierarchy' });
  });

  it('keeps listings, audit trails and uniqueness per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const mine = await seed(world, f.roles.admin, { code: 'OPS' });
    // The very same name and code are free in the other company.
    const theirs = await seed(world, f.adminB, { code: 'OPS' });
    expect(theirs.id).not.toBe(mine.id);
    expect(ok(await platform.areas.list(f.adminB.token, corr(), {})).items).toEqual([theirs]);
    expect(ok(await platform.areas.list(f.roles.admin.token, corr(), {})).items).toEqual([mine]);
    expect(
      (await platform.areas.create(f.adminB.token, corr(), { name: 'operaciones' })).error,
    ).toMatchObject({ code: 'duplicate', status: 409, field: 'name' });
    expect(
      (await platform.areas.create(f.adminB.token, corr(), { name: 'Otra', code: 'ops' })).error,
    ).toMatchObject({ code: 'duplicate', status: 409, field: 'code' });
    expect(auditOf(world, f.a.tenantId).map((event) => event.entityId)).toEqual([mine.id]);
    expect(auditOf(world, f.b.tenantId).map((event) => event.entityId)).toEqual([theirs.id]);
  });

  it('never takes the tenant (or any protected field) from the request', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    for (const extra of [
      { tenantId: f.b.tenantId },
      { companyId: f.b.tenantId },
      { active: false },
      { version: 9 },
      { id: 'chosen-id' },
      { depth: 1 },
      { deactivatedAt: null },
    ])
      expect(
        (await platform.areas.create(admin.token, corr(), { name: 'X', ...extra })).error,
      ).toMatchObject({ code: 'invalid_input' });
    const area = await seed(world, admin);
    for (const patch of [{ tenantId: f.b.tenantId }, { active: false }, { depth: 2 }, {}])
      expect(
        (await platform.areas.update(admin.token, corr(), area.id, 1, patch)).error,
      ).toMatchObject({ code: 'invalid_input' });
    expect(ok(await platform.areas.list(f.adminB.token, corr(), {})).total).toBe(0);
  });
});

describe('sessions and tenants gate every call', () => {
  it('refuses a revoked session, a removed member and a suspended tenant, without writing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const area = await seed(world, f.roles.admin);
    const calls = (s: Session) => [
      platform.areas.list(s.token, corr(), {}),
      platform.areas.get(s.token, corr(), area.id),
      platform.areas.create(s.token, corr(), { name: 'X' }),
      platform.areas.update(s.token, corr(), area.id, 1, { name: 'Y' }),
      platform.areas.deactivate(s.token, corr(), area.id, 1),
      platform.areas.activate(s.token, corr(), area.id, 1),
      platform.areas.history(s.token, corr(), area.id, {}),
    ];
    const denied = async (s: Session) => {
      for (const result of await Promise.all(calls(s)))
        expect(result.error).toMatchObject({ code: 'unauthorized', status: 401 });
    };
    await platform.signOut(f.roles.viewer.token);
    await denied(f.roles.viewer);
    await platform.removeMember(f.roles.admin.token, corr(), f.roles.editor.identityId);
    await denied(f.roles.editor);
    await platform.suspendTenant(f.a.tenantId);
    await denied(f.roles.admin);
    await platform.reactivateTenant(f.a.tenantId);
    expect(ok(await platform.areas.get(f.roles.admin.token, corr(), area.id))).toMatchObject(area);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('rejects a token that is not a session', async () => {
    world = createWorld();
    await fixture(world);
    for (const token of ['', 'not-a-session', 'x'.repeat(2000)])
      expect((await world.platform.areas.list(token, corr(), {})).error?.code).toBe('unauthorized');
  });
});

describe('errors', () => {
  it('uses the documented status for each business conflict and validates inputs uniformly', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const admin = roles.admin;
    const area = await seed(world, admin);
    const err = async (p: Promise<PlatformResponse<unknown>>) => {
      const { error } = await p;
      return [error?.status, error?.code, error?.field];
    };
    expect(
      await err(platform.areas.update(admin.token, corr(), area.id, 9, { name: 'Z' })),
    ).toEqual([409, 'stale_version', undefined]);
    ok(await platform.areas.deactivate(admin.token, corr(), area.id, 1));
    expect(
      await err(platform.areas.update(admin.token, corr(), area.id, 2, { name: 'Z' })),
    ).toEqual([409, 'immutable', undefined]);
    expect(await err(platform.areas.deactivate(admin.token, corr(), area.id, 2))).toEqual([
      409,
      'invalid_transition',
      undefined,
    ]);
    expect(await err(platform.areas.create(admin.token, corr(), { name: '' }))).toEqual([
      400,
      'invalid_input',
      undefined,
    ]);
    expect(await err(platform.areas.list(admin.token, corr(), { limit: 0 }))).toEqual([
      400,
      'invalid_input',
      undefined,
    ]);
    const text = JSON.stringify(
      await platform.areas.create(admin.token, corr(), { name: 'secreto-xyz', extra: 1 }),
    );
    expect(text).not.toContain('secreto-xyz');
  });
});

describe('concurrency', () => {
  it('lets exactly one of many concurrent edits with the same version win', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const area = await seed(world, roles.admin);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        platform.areas.update(roles.admin.token, corr(), area.id, 1, { name: `Nombre ${i}` }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.error?.code === 'stale_version')).toBe(true);
  });

  it('lets exactly one of two crossing moves win and never forms a cycle', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const a = await seed(world, roles.admin, { name: 'A' });
    const b = await seed(world, roles.admin, { name: 'B' });
    const results = await Promise.all([
      platform.areas.update(roles.admin.token, corr(), a.id, 1, { parentId: b.id }),
      platform.areas.update(roles.admin.token, corr(), b.id, 1, { parentId: a.id }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.error?.code).toBe('invalid_hierarchy');
  });

  it('lets exactly one of many concurrent creations of the same name win', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        platform.areas.create(roles.admin.token, corr(), { name: 'Carrera' }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'duplicate')).toHaveLength(5);
  });
});

describe('adapters and failures', () => {
  it('uses the injected area store', async () => {
    const store = new InMemoryAreaStore();
    world = createWorld({ adapters: { areas: store } });
    const { roles, a } = await fixture(world);
    const area = await seed(world, roles.admin);
    expect(await store.find(a.tenantId, area.id)).toMatchObject({ tenantId: a.tenantId });
  });

  it('turns an infrastructure failure into a generic 500 without leaking its message', async () => {
    const inner = new InMemoryAreaStore();
    const broken: AreaStore = {
      transaction: async () => {
        throw new Error('connection to db-prod.internal refused for area Operaciones');
      },
      find: (t, id) => inner.find(t, id),
      list: (t, f, w) => inner.list(t, f, w),
      history: (t, a, w) => inner.history(t, a, w),
    };
    world = createWorld({ adapters: { areas: broken } });
    const { roles } = await fixture(world);
    const result = await world.platform.areas.create(roles.admin.token, corr(), {
      name: 'Operaciones',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
  });

  it('maps an identity failure that is neither auth nor permission to a generic error', async () => {
    world = createWorld();
    const { platform } = world;
    await fixture(world);
    const original = platform.identity.authenticate.bind(platform.identity);
    platform.identity.authenticate = async () => {
      throw new AuthError('conflict');
    };
    expect((await platform.areas.list('t', corr(), {})).error).toMatchObject({
      code: 'internal_error',
      status: 500,
    });
    platform.identity.authenticate = original;
  });
});

describe('typed views', () => {
  it('exposes exactly the declared fields', async () => {
    world = createWorld();
    const { roles } = await fixture(world);
    const area: AreaView = await seed(world, roles.admin);
    expect(Object.keys(area).sort()).toEqual(
      [
        'id',
        'name',
        'code',
        'parentId',
        'depth',
        'active',
        'responsibleIds',
        'version',
        'createdAt',
        'updatedAt',
        'deactivatedAt',
      ].sort(),
    );
    const history = ok(await world.platform.areas.history(roles.admin.token, corr(), area.id, {}));
    expect(Object.keys(history.items[0] ?? {}).sort()).toEqual(
      ['id', 'action', 'fields', 'fromParentId', 'toParentId', 'actorId', 'version', 'at'].sort(),
    );
  });
});

describe('permission requirements', () => {
  // Every role has `view`, so a missing read check cannot be seen through roles: assert what each
  // operation asks the authorizer for.
  it('asks the authorizer for the documented permission on every operation', async () => {
    const asked: string[][] = [];
    const api = new AreasApi({
      service: new AreaService(new InMemoryAreaStore(), {
        resources: { vehicles: NO_RESOURCES, people: NO_RESOURCES },
      }),
      authorize: async (_token, _correlation, required) => {
        asked.push([...required]);
        throw new AuthError('forbidden');
      },
      audit: () => undefined,
    });
    await api.get('t', 'c', 'x');
    await api.list('t', 'c', {});
    await api.history('t', 'c', 'x', {});
    await api.create('t', 'c', {});
    await api.update('t', 'c', 'x', 1, {});
    await api.activate('t', 'c', 'x', 1);
    await api.deactivate('t', 'c', 'x', 1);
    expect(asked).toEqual([
      [...AREA_PERMISSIONS.read],
      [...AREA_PERMISSIONS.read],
      [...AREA_PERMISSIONS.read],
      [...AREA_PERMISSIONS.create],
      [...AREA_PERMISSIONS.change],
      [...AREA_PERMISSIONS.change],
      [...AREA_PERMISSIONS.deactivate],
    ]);
    expect(AREA_PERMISSIONS).toEqual({
      read: ['view'],
      create: ['create'],
      change: ['edit'],
      deactivate: ['delete'],
    });
  });
});
