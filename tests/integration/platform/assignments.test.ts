import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSIGNMENT_PERMISSIONS,
  AssignmentsApi,
  InMemoryAssignmentStore,
  type AssignedView,
  type AssignmentView,
  type PlatformResponse,
  type RoleName,
} from '../../../apps/api/composition/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import {
  AssignmentService,
  type AssignmentStore,
} from '../../../packages/domain/assignments/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => {
  world.dispose();
  vi.restoreAllMocks();
});

interface Side {
  readonly area: string;
  readonly vehicle: string;
  readonly vehicle2: string;
  readonly driver: string;
  readonly driver2: string;
  readonly dispatcher: string;
}

interface Fixture {
  readonly a: Awaited<ReturnType<World['tenant']>>;
  readonly b: Awaited<ReturnType<World['tenant']>>;
  readonly roles: Readonly<Record<RoleName, Session>>;
  readonly adminB: Session;
  readonly sa: Side;
  readonly sb: Side;
}

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

let serial = 0;
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
  const sideOf = async (session: Session): Promise<Side> => {
    const area = ok(await w.platform.areas.create(session.token, corr(), { name: 'Flota' })).id;
    const vehicle = async () => {
      serial += 1;
      return ok(
        await w.platform.vehicles.create(session.token, corr(), {
          economicNumber: `U-${serial}`,
          plate: `ABC${serial}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId: area,
          odometerKm: 10,
        }),
      ).id;
    };
    const employee = async (kind: 'driver' | 'dispatcher') =>
      ok(
        await w.platform.employees.create(session.token, corr(), {
          kind,
          firstName: 'Luis',
          lastName: 'Gómez',
          areaId: area,
        }),
      ).id;
    return {
      area,
      vehicle: await vehicle(),
      vehicle2: await vehicle(),
      driver: await employee('driver'),
      driver2: await employee('driver'),
      dispatcher: await employee('dispatcher'),
    };
  };
  return { a, b, roles, adminB: b.admin, sa: await sideOf(a.admin), sb: await sideOf(b.admin) };
}

const input = (f: Fixture, over: Record<string, unknown> = {}) => ({
  vehicleId: f.sa.vehicle,
  employeeId: f.sa.driver,
  type: 'principal',
  reason: 'Alta de unidad',
  ...over,
});
const seed = async (w: World, f: Fixture, session: Session, over: Record<string, unknown> = {}) =>
  ok(await w.platform.assignments.create(session.token, corr(), input(f, over))).assignment;
const auditOf = (w: World, tenantId: string) =>
  w.audit.snapshotForTesting(tenantId).filter((event) => event.entityType === 'vehicle_assignment');

describe('assignment lifecycle through the platform', () => {
  it('assigns, reads, replaces and ends, auditing each write without values', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const created = ok(await platform.assignments.create(admin.token, corr(), input(f)));
    expect(created.replaced).toBeNull();
    expect(created.assignment).toMatchObject({
      vehicleId: f.sa.vehicle,
      employeeId: f.sa.driver,
      type: 'principal',
      reason: 'Alta de unidad',
      assignedBy: `user-${admin.identityId}`,
      current: true,
      version: 1,
      endedAt: null,
    });
    expect(created.assignment).not.toHaveProperty('tenantId');
    const id = created.assignment.id;
    expect(ok(await platform.assignments.get(admin.token, corr(), id))).toEqual(created.assignment);

    const swapped: AssignedView = ok(
      await platform.assignments.create(
        admin.token,
        corr(),
        input(f, { employeeId: f.sa.driver2, replace: true, reason: 'Relevo de turno' }),
      ),
    );
    expect(swapped.replaced).toMatchObject({
      id,
      current: false,
      endKind: 'replaced',
      endReason: 'Relevo de turno',
      version: 2,
    });
    const ended = ok(
      await platform.assignments.end(admin.token, corr(), swapped.assignment.id, 1, {
        reason: 'Fin de turno',
      }),
    );
    expect(ended).toMatchObject({ current: false, endKind: 'ended', version: 2 });
    const history = ok(await platform.assignments.history(admin.token, corr(), id, {}));
    expect(history.items.map((e) => [e.seq, e.kind])).toEqual([
      [2, 'replaced'],
      [1, 'assigned'],
    ]);
    expect(history.items[1]?.actorId).toBe(`user-${admin.identityId}`);

    const events = auditOf(world, f.a.tenantId);
    expect(events.map((e) => e.action)).toEqual([
      'vehicle_assignment.created',
      'vehicle_assignment.ended',
      'vehicle_assignment.created',
      'vehicle_assignment.ended',
    ]);
    const text = JSON.stringify(events);
    for (const fragment of ['Alta de unidad', 'Relevo de turno', 'Fin de turno', 'principal'])
      expect(text).not.toContain(fragment);
  });

  it('lists both views of an assignment: the vehicle ficha and the driver ficha (FR-053, US-013)', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const first = await seed(world, f, admin);
    world.advance(60_000);
    await seed(world, f, admin, { employeeId: f.sa.driver2, replace: true });
    const byVehicle = ok(
      await platform.assignments.list(admin.token, corr(), { vehicleId: f.sa.vehicle }),
    );
    expect(byVehicle.items.map((a) => [a.employeeId === f.sa.driver2, a.current])).toEqual([
      [true, true],
      [false, false],
    ]);
    const byDriver = ok(
      await platform.assignments.list(admin.token, corr(), { employeeId: f.sa.driver }),
    );
    expect(byDriver.items).toEqual([
      expect.objectContaining({ id: first.id, current: false, endKind: 'replaced' }),
    ]);
    expect(byDriver.tenantId).toBe(f.a.tenantId);
    expect(
      ok(await platform.assignments.list(admin.token, corr(), { status: 'current' })).total,
    ).toBe(1);
  });
});

describe('BR-002 / BR-003 / BR-014 through the platform', () => {
  it('names the field of a second principal and allows the other types', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    await seed(world, f, admin);
    expect(
      (
        await platform.assignments.create(
          admin.token,
          corr(),
          input(f, { employeeId: f.sa.driver2 }),
        )
      ).error,
    ).toMatchObject({ code: 'principal_taken', status: 409, field: 'vehicle_id' });
    expect(
      (
        await platform.assignments.create(
          admin.token,
          corr(),
          input(f, { vehicleId: f.sa.vehicle2 }),
        )
      ).error,
    ).toMatchObject({ code: 'principal_taken', status: 409, field: 'employee_id' });
    expect(
      (await platform.assignments.create(admin.token, corr(), input(f, { type: 'secondary' })))
        .error,
    ).toMatchObject({ code: 'already_assigned', status: 409, field: 'employee_id' });
    for (const [type, vehicleId] of [
      ['secondary', f.sa.vehicle2],
      ['temporary', f.sa.vehicle],
    ] as const)
      expect(
        (
          await platform.assignments.create(
            admin.token,
            corr(),
            input(f, { type, employeeId: f.sa.driver2, vehicleId }),
          )
        ).ok,
        type,
      ).toBe(true);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(3);
  });

  it('refuses ineligible vehicles and drivers with one uniform 422 each', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const vehicle = ok(await platform.vehicles.get(admin.token, corr(), f.sa.vehicle2));
    for (const status of ['inactive', 'decommissioned'] as const)
      ok(
        await platform.vehicles.changeStatus(
          admin.token,
          corr(),
          f.sa.vehicle2,
          status === 'inactive' ? vehicle.version : vehicle.version + 1,
          status,
          'Prueba',
        ),
      );
    const bad = [
      await platform.assignments.create(admin.token, corr(), input(f, { vehicleId: f.sb.vehicle })),
      await platform.assignments.create(admin.token, corr(), input(f, { vehicleId: 'nope' })),
      await platform.assignments.create(
        admin.token,
        corr(),
        input(f, { vehicleId: f.sa.vehicle2 }),
      ),
    ];
    for (const result of bad)
      expect(result.error).toEqual({
        code: 'invalid_vehicle',
        status: 422,
        message: 'Assignment request rejected: invalid_vehicle',
        field: 'vehicle_id',
      });
    const drivers = [
      await platform.assignments.create(admin.token, corr(), input(f, { employeeId: f.sb.driver })),
      await platform.assignments.create(admin.token, corr(), input(f, { employeeId: 'nope' })),
      await platform.assignments.create(
        admin.token,
        corr(),
        input(f, { employeeId: f.sa.dispatcher }),
      ),
    ];
    for (const result of drivers)
      expect(result.error).toEqual({
        code: 'invalid_employee',
        status: 422,
        message: 'Assignment request rejected: invalid_employee',
        field: 'employee_id',
      });
    ok(
      await platform.employees.changeStatus(
        admin.token,
        corr(),
        f.sa.driver2,
        1,
        'inactive',
        'Pausa',
      ),
    );
    expect(
      (
        await platform.assignments.create(
          admin.token,
          corr(),
          input(f, { employeeId: f.sa.driver2 }),
        )
      ).error?.code,
    ).toBe('invalid_employee');
    expect(auditOf(world, f.a.tenantId)).toHaveLength(0);
  });

  it('keeps closed assignments readable after the vehicle is archived', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const made = await seed(world, f, admin);
    ok(await platform.vehicles.archive(admin.token, corr(), f.sa.vehicle, 1));
    expect(ok(await platform.assignments.get(admin.token, corr(), made.id))).toEqual(made);
    expect(
      ok(await platform.assignments.end(admin.token, corr(), made.id, 1, { reason: 'Baja' }))
        .current,
    ).toBe(false);
    expect((await platform.assignments.create(admin.token, corr(), input(f))).error?.code).toBe(
      'invalid_vehicle',
    );
  });
});

const ROLE_GRANTS: Readonly<Record<RoleName, readonly string[]>> = {
  admin: ['view', 'create', 'edit', 'delete', 'view_pii', 'view_costs'],
  editor: ['view', 'create', 'edit'],
  viewer: ['view'],
  auditor: ['view'],
  pii_reader: ['view', 'create', 'view_pii'],
};

type Run = (
  w: World,
  s: Session,
  f: Fixture,
  target: AssignmentView,
) => Promise<PlatformResponse<unknown>>;
const OPERATIONS: Readonly<Record<string, { run: Run; permissions: readonly string[] }>> = {
  list: { run: (w, s) => w.platform.assignments.list(s.token, corr(), {}), permissions: ['view'] },
  get: {
    run: (w, s, _f, t) => w.platform.assignments.get(s.token, corr(), t.id),
    permissions: ['view'],
  },
  history: {
    run: (w, s, _f, t) => w.platform.assignments.history(s.token, corr(), t.id, {}),
    permissions: ['view'],
  },
  create: {
    run: (w, s, f) =>
      w.platform.assignments.create(
        s.token,
        corr(),
        input(f, { type: 'temporary', employeeId: f.sa.driver2 }),
      ),
    permissions: ['create'],
  },
  replace: {
    run: (w, s, f) =>
      w.platform.assignments.create(
        s.token,
        corr(),
        input(f, { employeeId: f.sa.driver2, replace: true }),
      ),
    permissions: ['create', 'edit'],
  },
  end: {
    run: (w, s, _f, t) => w.platform.assignments.end(s.token, corr(), t.id, 1, { reason: 'Fin' }),
    permissions: ['edit'],
  },
};

describe('role matrix over the existing generic permissions', () => {
  for (const role of Object.keys(ROLE_GRANTS) as RoleName[])
    it(`${role}: allowed exactly ${ROLE_GRANTS[role].join(', ')}; denied operations change nothing and are not audited`, async () => {
      world = createWorld();
      const f = await fixture(world);
      for (const [name, { run, permissions }] of Object.entries(OPERATIONS)) {
        // A fresh state per operation: the target is current, nothing else is.
        const target = await seed(world, f, f.roles.admin);
        const audited = auditOf(world, f.a.tenantId).length;
        const result = await run(world, f.roles[role], f, target);
        const allowed = permissions.every((permission) => ROLE_GRANTS[role].includes(permission));
        if (allowed) {
          expect(result.ok, `${role} ${name}`).toBe(true);
          const reads = permissions.length === 1 && permissions[0] === 'view';
          const delta = name === 'replace' ? 2 : reads ? 0 : 1;
          expect(auditOf(world, f.a.tenantId).length - audited, `${role} ${name}`).toBe(delta);
        } else {
          expect(result.error, `${role} ${name}`).toMatchObject({ code: 'forbidden', status: 403 });
          expect(result.value).toBeUndefined();
          expect(auditOf(world, f.a.tenantId)).toHaveLength(audited);
          expect(
            ok(await world.platform.assignments.get(f.roles.admin.token, corr(), target.id)),
          ).toEqual(target);
        }
        // Back to an empty vehicle for the next operation.
        for (const open of ok(
          await world.platform.assignments.list(f.roles.admin.token, corr(), { status: 'current' }),
        ).items)
          ok(
            await world.platform.assignments.end(
              f.roles.admin.token,
              corr(),
              open.id,
              open.version,
              {
                reason: 'Limpieza',
              },
            ),
          );
      }
    });

  it('asks the authorizer for the documented permissions on every operation', async () => {
    const asked: string[][] = [];
    const api = new AssignmentsApi({
      service: new AssignmentService(new InMemoryAssignmentStore()),
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
    await api.create('t', 'c', { replace: true });
    await api.create('t', 'c', { replace: 'yes' });
    await api.create('t', 'c', null);
    await api.create('t', 'c', [true]);
    await api.end('t', 'c', 'x', 1, {});
    expect(asked).toEqual([
      ['view'],
      ['view'],
      ['view'],
      ['create'],
      ['create', 'edit'],
      ['create'],
      ['create'],
      ['create'],
      ['edit'],
    ]);
    expect(ASSIGNMENT_PERMISSIONS).toEqual({
      read: ['view'],
      create: ['create'],
      replace: ['create', 'edit'],
      end: ['edit'],
    });
  });
});

describe('tenant isolation', () => {
  it('answers not_found to another tenant for every id-based operation, exactly as for an unknown id, and changes nothing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const made = await seed(world, f, f.roles.admin);
    const other = f.adminB;
    const calls = (id: string) => [
      platform.assignments.get(other.token, corr(), id),
      platform.assignments.history(other.token, corr(), id, {}),
      platform.assignments.end(other.token, corr(), id, 1, { reason: 'Robada' }),
    ];
    const foreign = await Promise.all(calls(made.id));
    const unknown = await Promise.all(calls('00000000-0000-4000-8000-000000000000'));
    for (const [index, result] of foreign.entries()) expect(result).toEqual(unknown[index]);
    for (const result of foreign)
      expect(result.error).toMatchObject({ code: 'not_found', status: 404 });
    expect(ok(await platform.assignments.get(f.roles.admin.token, corr(), made.id))).toEqual(made);
  });

  it('keeps listings, principals and audit trails per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    await seed(world, f, f.roles.admin);
    // The same principal slot in the other tenant is independent.
    ok(
      await platform.assignments.create(
        f.adminB.token,
        corr(),
        input(f, { vehicleId: f.sb.vehicle, employeeId: f.sb.driver }),
      ),
    );
    expect(ok(await platform.assignments.list(f.adminB.token, corr(), {})).total).toBe(1);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
    expect(auditOf(world, f.b.tenantId)).toHaveLength(1);
  });

  it('never takes the tenant (or any protected field) from the request', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    for (const extra of [
      { tenantId: f.b.tenantId },
      { companyId: f.b.tenantId },
      { assignedBy: 'user-someone' },
      { startedAt: '2020-01-01T00:00:00.000Z' },
      { endedAt: null },
      { version: 9 },
      { id: 'forced' },
    ])
      expect(
        (await platform.assignments.create(f.roles.admin.token, corr(), input(f, extra))).error,
      ).toMatchObject({ code: 'invalid_input', status: 400 });
    expect(
      (
        await platform.assignments.list(f.roles.admin.token, corr(), {
          tenantId: f.b.tenantId,
        } as never)
      ).ok,
    ).toBe(true);
    expect(ok(await platform.assignments.list(f.adminB.token, corr(), {})).total).toBe(0);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(0);
  });
});

describe('sessions and tenants gate every call', () => {
  it('refuses a revoked session, a removed member and a suspended tenant, without writing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const made = await seed(world, f, f.roles.admin);
    const calls = (s: Session) => [
      platform.assignments.list(s.token, corr(), {}),
      platform.assignments.get(s.token, corr(), made.id),
      platform.assignments.history(s.token, corr(), made.id, {}),
      platform.assignments.create(s.token, corr(), input(f, { vehicleId: f.sa.vehicle2 })),
      platform.assignments.end(s.token, corr(), made.id, 1, { reason: 'Fin' }),
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
    expect(ok(await platform.assignments.get(f.roles.admin.token, corr(), made.id))).toEqual(made);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('rejects a token that is not a session', async () => {
    world = createWorld();
    await fixture(world);
    for (const token of ['', 'not-a-session', 'x'.repeat(2000)])
      expect((await world.platform.assignments.list(token, corr(), {})).error?.code).toBe(
        'unauthorized',
      );
  });
});

describe('validation and the closed state', () => {
  it('validates every input with a uniform 400 and no echo of the value', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const made = await seed(world, f, admin);
    const results = await Promise.all([
      platform.assignments.create(
        admin.token,
        corr(),
        input(f, { reason: 'ECO-9999-secreto' + '\u0007' }),
      ),
      platform.assignments.create(admin.token, corr(), input(f, { type: 'ECO-9999-secreto' })),
      platform.assignments.create(admin.token, corr(), 'ECO-9999-secreto'),
      platform.assignments.end(admin.token, corr(), made.id, 1, { reason: '' }),
      platform.assignments.end(admin.token, corr(), made.id, 'ECO-9999-secreto', { reason: 'x' }),
      platform.assignments.list(admin.token, corr(), { status: 'ECO-9999-secreto' }),
      platform.assignments.history(admin.token, corr(), made.id, { limit: 0 }),
    ]);
    for (const result of results) {
      expect(result.error).toMatchObject({ code: 'invalid_input', status: 400 });
      expect(JSON.stringify(result)).not.toContain('ECO-9999-secreto');
    }
  });

  it('keeps ended assignments read-only: 409 immutable, and a stale version is 409 stale_version', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const made = await seed(world, f, admin);
    expect(
      (await platform.assignments.end(admin.token, corr(), made.id, 7, { reason: 'x' })).error,
    ).toMatchObject({ code: 'stale_version', status: 409 });
    ok(await platform.assignments.end(admin.token, corr(), made.id, 1, { reason: 'Fin' }));
    expect(
      (await platform.assignments.end(admin.token, corr(), made.id, 2, { reason: 'Otra' })).error,
    ).toMatchObject({ code: 'immutable', status: 409 });
    expect(ok(await platform.assignments.history(admin.token, corr(), made.id, {})).total).toBe(2);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(2);
  });
});

describe('concurrency', () => {
  it('lets exactly one of many concurrent principals for a vehicle win', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const results = await Promise.all(
      [f.sa.driver, f.sa.driver2].map((employeeId) =>
        platform.assignments.create(f.roles.admin.token, corr(), input(f, { employeeId })),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)[0]?.error).toMatchObject({
      code: 'principal_taken',
      field: 'vehicle_id',
    });
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('lets exactly one of many concurrent closings with the same version win', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const made = await seed(world, f, f.roles.admin);
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        platform.assignments.end(f.roles.admin.token, corr(), made.id, 1, { reason: `Fin ${n}` }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const result of results.filter((r) => !r.ok))
      expect(['stale_version', 'immutable']).toContain(result.error?.code);
    expect(
      ok(await platform.assignments.history(f.roles.admin.token, corr(), made.id, {})).total,
    ).toBe(2);
  });
});

describe('adapters and failures', () => {
  it('uses the injected assignment store', async () => {
    const store = new InMemoryAssignmentStore();
    world = createWorld({ adapters: { assignments: store } });
    const f = await fixture(world);
    const made = await seed(world, f, f.roles.admin);
    expect(await store.find(f.a.tenantId, made.id)).toMatchObject({
      reason: 'Alta de unidad',
      tenantId: f.a.tenantId,
    });
  });

  it('turns an infrastructure failure into a generic 500 without leaking its message', async () => {
    const inner = new InMemoryAssignmentStore();
    const broken: AssignmentStore = {
      insert: async () => {
        throw new Error('connection to db-prod.internal refused for ECO-FICTICIA-1');
      },
      find: (t, id) => inner.find(t, id),
      list: (t, f, w) => inner.list(t, f, w),
      replace: (n, e, ev) => inner.replace(n, e, ev),
      events: (t, a, w) => inner.events(t, a, w),
    };
    world = createWorld({ adapters: { assignments: broken } });
    const f = await fixture(world);
    const result = await world.platform.assignments.create(f.roles.admin.token, corr(), input(f));
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expect(auditOf(world, f.a.tenantId)).toHaveLength(0);
  });

  it('maps an identity failure that is neither auth nor permission to a generic error', async () => {
    world = createWorld();
    const { platform } = world;
    await fixture(world);
    const original = platform.identity.authenticate.bind(platform.identity);
    platform.identity.authenticate = async () => {
      throw new AuthError('conflict');
    };
    const result = await platform.assignments.list('t', corr(), {});
    expect(result.error).toMatchObject({ code: 'internal_error', status: 500 });
    platform.identity.authenticate = original;
  });

  it('maps an invalid-input identity failure to a 400', async () => {
    world = createWorld();
    const { platform } = world;
    await fixture(world);
    platform.identity.authenticate = async () => {
      throw new AuthError('invalid_input');
    };
    expect((await platform.assignments.list('t', corr(), {})).error).toMatchObject({
      code: 'invalid_input',
      status: 400,
    });
  });
});

describe('typed views', () => {
  it('exposes exactly the declared fields', async () => {
    world = createWorld();
    const f = await fixture(world);
    const v: AssignmentView = await seed(world, f, f.roles.admin);
    expect(Object.keys(v).sort()).toEqual(
      [
        'id',
        'vehicleId',
        'employeeId',
        'type',
        'reason',
        'assignedBy',
        'startedAt',
        'endedAt',
        'endKind',
        'endReason',
        'endedBy',
        'current',
        'version',
        'updatedAt',
      ].sort(),
    );
    const history = ok(
      await world.platform.assignments.history(f.roles.admin.token, corr(), v.id, {}),
    );
    expect(Object.keys(history.items[0] ?? {}).sort()).toEqual(
      ['seq', 'kind', 'actorId', 'reason', 'at'].sort(),
    );
  });
});
