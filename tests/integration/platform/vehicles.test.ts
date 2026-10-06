import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryVehicleStore,
  VehiclesApi,
  VEHICLE_PERMISSIONS,
  type PlatformResponse,
  type RoleName,
  type VehicleView,
} from '../../../apps/api/composition/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import { VehicleService, type VehicleStore } from '../../../packages/domain/vehicles/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

const input = (over: Record<string, unknown> = {}) => ({
  economicNumber: 'U-001',
  plate: 'ab-123 c',
  vin: '1HGCM82633A004352',
  make: 'Toyota',
  model: 'Hilux',
  year: 2022,
  areaId: 'area-1',
  odometerKm: 1000,
  ...over,
});

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

const seed = async (w: World, session: Session, over: Record<string, unknown> = {}) =>
  ok(await w.platform.vehicles.create(session.token, corr(), input(over)));

const auditOf = (w: World, tenantId: string) =>
  w.audit.list(tenantId).filter((event) => event.entityType === 'vehicle');

describe('vehicle lifecycle through the platform', () => {
  it('creates, reads, edits, changes status, records the odometer and archives, auditing each write', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;

    const created = await seed(world, admin);
    expect(created).toMatchObject({
      economicNumber: 'U-001',
      plate: 'AB-123 C',
      status: 'active',
      version: 1,
      odometerKm: 1000,
      archivedAt: null,
      registeredOn: '2026-10-06',
    });
    expect(created).not.toHaveProperty('tenantId');
    expect(ok(await platform.vehicles.get(admin.token, corr(), created.id))).toEqual(created);

    const edited = ok(
      await platform.vehicles.update(admin.token, corr(), created.id, 1, {
        make: 'Ford',
        vin: null,
      }),
    );
    expect(edited).toMatchObject({ make: 'Ford', vin: null, version: 2 });
    const moved = ok(
      await platform.vehicles.changeStatus(
        admin.token,
        corr(),
        created.id,
        2,
        'out_of_service',
        'Siniestro 12',
      ),
    );
    expect(moved).toMatchObject({
      status: 'out_of_service',
      statusReason: 'Siniestro 12',
      version: 3,
    });
    const read = ok(
      await platform.vehicles.recordOdometer(admin.token, corr(), created.id, 3, 1800),
    );
    expect(read).toMatchObject({ odometerKm: 1800, version: 4 });
    const archived = ok(await platform.vehicles.archive(admin.token, corr(), created.id, 4));
    expect(archived.archivedAt).not.toBeNull();
    expect(ok(await platform.vehicles.list(admin.token, corr(), {})).items).toEqual([]);
    expect(
      ok(await platform.vehicles.list(admin.token, corr(), { includeArchived: true })).items,
    ).toHaveLength(1);

    const history = ok(await platform.vehicles.history(admin.token, corr(), created.id));
    expect(history.map((entry) => [entry.from, entry.to, entry.reason])).toEqual([
      [null, 'active', 'Alta'],
      ['active', 'out_of_service', 'Siniestro 12'],
    ]);
    expect(history[0]?.actorId).toBe(`user-${admin.identityId}`);

    const trail = auditOf(world, f.a.tenantId);
    expect(trail.map((event) => event.action)).toEqual([
      'vehicle.created',
      'vehicle.updated',
      'vehicle.status_changed',
      'vehicle.odometer_recorded',
      'vehicle.archived',
    ]);
    for (const event of trail) {
      expect(event.entityId).toBe(created.id);
      expect(event.actor).toEqual({ id: `user-${admin.identityId}`, kind: 'user' });
    }
    // Audit carries ids and actions only: no plate, VIN, make, reason or odometer.
    const text = JSON.stringify(trail);
    for (const secret of ['AB-123', 'AB123', '1HGCM', 'Toyota', 'Ford', 'Siniestro', '1800'])
      expect(text).not.toContain(secret);
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
  });

  it('lists with filters and pagination fields, ordered by economic number', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const admin = roles.admin;
    const one = await seed(world, admin, { economicNumber: 'B-2', plate: 'P2', vin: null });
    await seed(world, admin, { economicNumber: 'a-1', plate: 'P1', vin: null, areaId: 'area-2' });
    await seed(world, admin, { economicNumber: 'C-3', plate: 'P3', vin: null });
    ok(
      await platform.vehicles.changeStatus(admin.token, corr(), one.id, 1, 'inactive', 'Temporada'),
    );
    const list = async (query: Record<string, unknown>) =>
      ok(await platform.vehicles.list(admin.token, corr(), query));
    expect((await list({})).items.map((v) => v.economicNumber)).toEqual(['a-1', 'B-2', 'C-3']);
    expect((await list({ status: 'inactive' })).items.map((v) => v.economicNumber)).toEqual([
      'B-2',
    ]);
    expect((await list({ areaId: 'area-2' })).items.map((v) => v.economicNumber)).toEqual(['a-1']);
    const page = await list({ limit: 1, offset: 1 });
    expect(page.items.map((v) => v.economicNumber)).toEqual(['B-2']);
    expect(page.total).toBe(3);
    expect(page.tenantId).toBeTruthy();
    expect((await platform.vehicles.list(admin.token, corr(), { limit: 0 })).error).toMatchObject({
      code: 'invalid_input',
      status: 400,
    });
  });
});

let serial = 0;
const fresh = (): Record<string, unknown> => {
  serial += 1;
  return { economicNumber: `T-${serial}`, plate: `TP${serial}`, vin: null };
};

type Operation = (
  w: World,
  session: Session,
  vehicle: VehicleView,
) => Promise<PlatformResponse<unknown>>;

const OPERATIONS: Readonly<Record<string, { run: Operation; permission: string }>> = {
  list: { permission: 'view', run: (w, s) => w.platform.vehicles.list(s.token, corr(), {}) },
  get: { permission: 'view', run: (w, s, v) => w.platform.vehicles.get(s.token, corr(), v.id) },
  history: {
    permission: 'view',
    run: (w, s, v) => w.platform.vehicles.history(s.token, corr(), v.id),
  },
  create: {
    permission: 'create',
    run: (w, s) => w.platform.vehicles.create(s.token, corr(), input(fresh())),
  },
  update: {
    permission: 'edit',
    run: (w, s, v) => w.platform.vehicles.update(s.token, corr(), v.id, 1, { make: 'Nuevo' }),
  },
  status: {
    permission: 'edit',
    run: (w, s, v) =>
      w.platform.vehicles.changeStatus(s.token, corr(), v.id, 1, 'inactive', 'Temporada'),
  },
  odometer: {
    permission: 'edit',
    run: (w, s, v) => w.platform.vehicles.recordOdometer(s.token, corr(), v.id, 1, 5000),
  },
  archive: {
    permission: 'delete',
    run: (w, s, v) => w.platform.vehicles.archive(s.token, corr(), v.id, 1),
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
      for (const [name, { run, permission }] of Object.entries(OPERATIONS)) {
        // A fresh vehicle per operation, so one allowed change never makes another one stale.
        const target = await seed(world, f.roles.admin, fresh());
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
            ok(await world.platform.vehicles.get(f.roles.admin.token, corr(), target.id)),
          ).toEqual(target);
        }
      }
    });
});

describe('tenant isolation', () => {
  it('answers not_found to another tenant for every id-based operation, exactly as for an unknown id, and changes nothing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const vehicle = await seed(world, f.roles.admin);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const run = (id: string) => ({
      get: platform.vehicles.get(f.adminB.token, corr(), id),
      history: platform.vehicles.history(f.adminB.token, corr(), id),
      update: platform.vehicles.update(f.adminB.token, corr(), id, 1, { make: 'Robado' }),
      status: platform.vehicles.changeStatus(f.adminB.token, corr(), id, 1, 'inactive', 'x'),
      odometer: platform.vehicles.recordOdometer(f.adminB.token, corr(), id, 1, 9999),
      archive: platform.vehicles.archive(f.adminB.token, corr(), id, 1),
    });
    const foreign = run(vehicle.id);
    const missing = run(unknown);
    for (const name of Object.keys(foreign) as (keyof typeof foreign)[]) {
      const [a, b] = await Promise.all([foreign[name], missing[name]]);
      expect(a.error, name).toMatchObject({ code: 'not_found', status: 404 });
      expect(a, name).toEqual(b);
    }
    expect(ok(await platform.vehicles.get(f.roles.admin.token, corr(), vehicle.id))).toEqual(
      vehicle,
    );
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('keeps listings, audit trails and uniqueness per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const mine = await seed(world, f.roles.admin);
    // The very same economic number, plate and VIN are free in the other company.
    const theirs = ok(await platform.vehicles.create(f.adminB.token, corr(), input()));
    expect(theirs.id).not.toBe(mine.id);
    expect(ok(await platform.vehicles.list(f.adminB.token, corr(), {})).items).toEqual([theirs]);
    expect(ok(await platform.vehicles.list(f.roles.admin.token, corr(), {})).items).toEqual([mine]);
    // ... and a second copy is still a duplicate inside each company.
    expect((await platform.vehicles.create(f.adminB.token, corr(), input())).error).toMatchObject({
      code: 'duplicate',
      status: 409,
      field: 'economic_number',
    });
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
      { status: 'decommissioned' },
      { version: 9 },
      { id: 'chosen-id' },
      { archivedAt: '2026-01-01T00:00:00.000Z' },
    ])
      expect(
        (await platform.vehicles.create(admin.token, corr(), input(extra))).error,
      ).toMatchObject({
        code: 'invalid_input',
      });
    const vehicle = await seed(world, admin);
    for (const patch of [
      { tenantId: f.b.tenantId },
      { status: 'inactive' },
      { odometerKm: 1 },
      { version: 3 },
      { archivedAt: null },
    ])
      expect(
        (await platform.vehicles.update(admin.token, corr(), vehicle.id, 1, patch)).error,
      ).toMatchObject({ code: 'invalid_input' });
    expect(ok(await platform.vehicles.list(f.adminB.token, corr(), {})).total).toBe(0);
  });
});

describe('sessions and tenants gate every call', () => {
  it('refuses a revoked session, a removed member and a suspended tenant, without writing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const vehicle = await seed(world, f.roles.admin);
    const calls = (s: Session) => [
      platform.vehicles.list(s.token, corr(), {}),
      platform.vehicles.get(s.token, corr(), vehicle.id),
      platform.vehicles.create(
        s.token,
        corr(),
        input({ economicNumber: 'X', plate: 'XX1', vin: null }),
      ),
      platform.vehicles.update(s.token, corr(), vehicle.id, 1, { make: 'x' }),
      platform.vehicles.archive(s.token, corr(), vehicle.id, 1),
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
    expect(ok(await platform.vehicles.get(f.roles.admin.token, corr(), vehicle.id))).toEqual(
      vehicle,
    );
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('rejects a token that is not a session', async () => {
    world = createWorld();
    await fixture(world);
    for (const token of ['', 'not-a-session', 'x'.repeat(2000)])
      expect((await world.platform.vehicles.list(token, corr(), {})).error?.code).toBe(
        'unauthorized',
      );
  });
});

describe('business rules through the platform', () => {
  it('keeps the odometer non-decreasing and read-only vehicles read-only', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles, a } = await fixture(world);
    const token = roles.admin.token;
    const v = await seed(world, roles.admin);
    expect(
      (await platform.vehicles.recordOdometer(token, corr(), v.id, 1, 999)).error,
    ).toMatchObject({ code: 'odometer_decrease', status: 422 });
    expect(ok(await platform.vehicles.recordOdometer(token, corr(), v.id, 1, 1000))).toMatchObject({
      odometerKm: 1000,
      version: 1,
    });
    const gone = ok(
      await platform.vehicles.changeStatus(token, corr(), v.id, 1, 'decommissioned', 'Venta'),
    );
    for (const result of [
      await platform.vehicles.update(token, corr(), v.id, gone.version, { make: 'x' }),
      await platform.vehicles.recordOdometer(token, corr(), v.id, gone.version, 5000),
    ])
      expect(result.error).toMatchObject({ code: 'immutable', status: 409 });
    expect(
      (await platform.vehicles.changeStatus(token, corr(), v.id, gone.version, 'active', 'x'))
        .error,
    ).toMatchObject({ code: 'invalid_transition', status: 409 });
    const archived = ok(await platform.vehicles.archive(token, corr(), v.id, gone.version));
    expect(archived.archivedAt).not.toBeNull();
    expect(
      (await platform.vehicles.archive(token, corr(), v.id, archived.version)).error,
    ).toMatchObject({
      code: 'immutable',
    });
    // Failed operations were not audited, and neither was the equal odometer reading (a no-op).
    expect(auditOf(world, a.tenantId).map((e) => e.action)).toEqual([
      'vehicle.created',
      'vehicle.status_changed',
      'vehicle.archived',
    ]);
  });

  it('validates every input with a uniform 400 and no echo of the value', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const token = roles.admin.token;
    const v = await seed(world, roles.admin);
    const secret = 'SECRET-VALUE-<script>';
    const bad = [
      await platform.vehicles.create(token, corr(), input({ plate: secret })),
      await platform.vehicles.create(token, corr(), input({ vin: secret })),
      await platform.vehicles.create(token, corr(), 'nope'),
      await platform.vehicles.create(token, corr(), input({ year: 1800 })),
      await platform.vehicles.get(token, corr(), '../etc/passwd'),
      await platform.vehicles.update(token, corr(), v.id, 'one', { make: 'x' }),
      await platform.vehicles.update(token, corr(), v.id, 1, {}),
      await platform.vehicles.changeStatus(token, corr(), v.id, 1, 'Activo', 'x'),
      await platform.vehicles.changeStatus(token, corr(), v.id, 1, 'inactive', ''),
      await platform.vehicles.recordOdometer(token, corr(), v.id, 1, -1),
      await platform.vehicles.archive(token, corr(), v.id, 0),
      await platform.vehicles.history(token, corr(), ''),
    ];
    for (const result of bad) {
      expect(result.error).toMatchObject({ code: 'invalid_input', status: 400 });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('exposes duplicates by field name only', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const token = roles.admin.token;
    await seed(world, roles.admin);
    const clash = async (over: Record<string, unknown>) =>
      (await platform.vehicles.create(token, corr(), input(over))).error;
    expect(await clash({ plate: 'zz9', vin: null })).toEqual({
      code: 'duplicate',
      status: 409,
      message: 'Vehicle request rejected: duplicate',
      field: 'economic_number',
    });
    expect(await clash({ economicNumber: 'U-2', plate: 'AB123C', vin: null })).toMatchObject({
      field: 'plate',
    });
    expect(await clash({ economicNumber: 'U-2', plate: 'ZZ9' })).toMatchObject({ field: 'vin' });
  });
});

describe('concurrency', () => {
  it('lets exactly one of many concurrent edits with the same version win', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const v = await seed(world, roles.admin);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        platform.vehicles.update(roles.admin.token, corr(), v.id, 1, { make: `Make${i}` }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const result of results.filter((r) => !r.ok))
      expect(result.error).toMatchObject({ code: 'stale_version', status: 409 });
    expect(ok(await platform.vehicles.get(roles.admin.token, corr(), v.id)).version).toBe(2);
  });

  it('lets exactly one of many concurrent creations of the same plate win', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        platform.vehicles.create(
          roles.admin.token,
          corr(),
          input({ economicNumber: `C-${i}`, plate: 'RACE 1', vin: null }),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.error?.field)).toEqual(Array(5).fill('plate'));
  });

  it('serializes an odometer reading racing a status change and an archive on the same version', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const t = roles.admin.token;
    const v = await seed(world, roles.admin);
    const results = await Promise.all([
      platform.vehicles.recordOdometer(t, corr(), v.id, 1, 4000),
      platform.vehicles.changeStatus(t, corr(), v.id, 1, 'inactive', 'Temporada'),
      platform.vehicles.archive(t, corr(), v.id, 1),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.error?.code === 'stale_version')).toBe(true);
  });
});

describe('adapters and failures', () => {
  it('uses the injected vehicle store', async () => {
    const store = new InMemoryVehicleStore();
    world = createWorld({ adapters: { vehicles: store } });
    const { roles, a } = await fixture(world);
    const v = await seed(world, roles.admin);
    expect(await store.find(a.tenantId, v.id)).toMatchObject({
      plate: 'AB-123 C',
      tenantId: a.tenantId,
    });
  });

  it('turns an infrastructure failure into a generic 500 without leaking its message', async () => {
    const inner = new InMemoryVehicleStore();
    const broken: VehicleStore = {
      insert: async () => {
        throw new Error('connection to db-prod.internal refused for plate AB-123 C');
      },
      find: (t, id) => inner.find(t, id),
      list: (t, f, w) => inner.list(t, f, w),
      replace: (n, e, h) => inner.replace(n, e, h),
      history: (t, v) => inner.history(t, v),
      countLiveInArea: (t, a) => inner.countLiveInArea(t, a),
    };
    world = createWorld({ adapters: { vehicles: broken } });
    const { roles } = await fixture(world);
    const result = await world.platform.vehicles.create(roles.admin.token, corr(), input());
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
    const result = await platform.vehicles.list('t', corr(), {});
    expect(result.error).toMatchObject({ code: 'internal_error', status: 500 });
    platform.identity.authenticate = original;
  });
});

describe('typed views', () => {
  it('exposes exactly the declared fields', async () => {
    world = createWorld();
    const { roles } = await fixture(world);
    const v: VehicleView = await seed(world, roles.admin);
    expect(Object.keys(v).sort()).toEqual(
      [
        'id',
        'economicNumber',
        'plate',
        'vin',
        'make',
        'model',
        'year',
        'areaId',
        'status',
        'statusReason',
        'odometerKm',
        'registeredOn',
        'version',
        'createdAt',
        'updatedAt',
        'archivedAt',
      ].sort(),
    );
  });
});

describe('permission requirements', () => {
  // Every role has `view`, so a missing read check cannot be seen through roles: assert what each
  // operation asks the authorizer for.
  it('asks the authorizer for the documented permission on every operation', async () => {
    const asked: string[][] = [];
    const service = new VehicleService(new InMemoryVehicleStore());
    const api = new VehiclesApi({
      service,
      authorize: async (_token, _correlation, required) => {
        asked.push([...required]);
        throw new AuthError('forbidden');
      },
      audit: () => undefined,
    });
    await api.get('t', 'c', 'x');
    await api.list('t', 'c', {});
    await api.history('t', 'c', 'x');
    await api.create('t', 'c', {});
    await api.update('t', 'c', 'x', 1, {});
    await api.changeStatus('t', 'c', 'x', 1, 'inactive', 'r');
    await api.recordOdometer('t', 'c', 'x', 1, 5);
    await api.archive('t', 'c', 'x', 1);
    expect(asked).toEqual([
      [...VEHICLE_PERMISSIONS.read],
      [...VEHICLE_PERMISSIONS.read],
      [...VEHICLE_PERMISSIONS.read],
      [...VEHICLE_PERMISSIONS.create],
      [...VEHICLE_PERMISSIONS.change],
      [...VEHICLE_PERMISSIONS.change],
      [...VEHICLE_PERMISSIONS.change],
      [...VEHICLE_PERMISSIONS.archive],
    ]);
    expect(VEHICLE_PERMISSIONS).toEqual({
      read: ['view'],
      create: ['create'],
      change: ['edit'],
      archive: ['delete'],
    });
  });
});
