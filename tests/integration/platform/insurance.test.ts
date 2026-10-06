import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSURANCE_PERMISSIONS,
  InMemoryPolicyStore,
  InsuranceApi,
  type PlatformResponse,
  type PolicyView,
  type RoleName,
} from '../../../apps/api/composition/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import { PolicyService, type PolicyStore } from '../../../packages/domain/insurance/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => {
  world.dispose();
  vi.restoreAllMocks();
});

interface Fixture {
  readonly a: Awaited<ReturnType<World['tenant']>>;
  readonly b: Awaited<ReturnType<World['tenant']>>;
  readonly roles: Readonly<Record<RoleName, Session>>;
  readonly adminB: Session;
  readonly vehicleA: string;
  readonly vehicleB: string;
}

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const AMOUNT = { kind: 'amount', amountMinor: 500000, currency: 'MXN' } as const;

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
  const vehicleOf = async (session: Session) => {
    const area = ok(await w.platform.areas.create(session.token, corr(), { name: 'Flota' })).id;
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
  return {
    a,
    b,
    roles,
    adminB: b.admin,
    vehicleA: await vehicleOf(a.admin),
    vehicleB: await vehicleOf(b.admin),
  };
}

const input = (f: Fixture, over: Record<string, unknown> = {}) => ({
  vehicleId: f.vehicleA,
  insurer: 'Aseguradora Ficticia',
  policyNumber: 'pol-001',
  coverageType: 'comprehensive',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  ...over,
});
const renewal = (over: Record<string, unknown> = {}) => ({
  startsOn: '2027-01-01',
  endsOn: '2027-12-31',
  ...over,
});
const seed = async (w: World, f: Fixture, session: Session, over: Record<string, unknown> = {}) =>
  ok(await w.platform.insurance.create(session.token, corr(), input(f, over)));
const auditOf = (w: World, tenantId: string) =>
  w.audit.list(tenantId).filter((event) => event.entityType === 'insurance_policy');

describe('policy lifecycle through the platform', () => {
  it('creates, reads, edits, renews and archives, auditing each write without values', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const created = ok(
      await platform.insurance.create(
        admin.token,
        corr(),
        input(f, { coverageNotes: 'RC y robo', deductible: AMOUNT }),
      ),
    );
    expect(created).toMatchObject({
      vehicleId: f.vehicleA,
      insurer: 'Aseguradora Ficticia',
      revision: 1,
      version: 1,
      policyNumber: 'POL-001',
      status: 'valid',
      daysToExpiry: 86,
      covering: true,
      hasDeductible: true,
      deductible: AMOUNT,
      archivedAt: null,
    });
    expect(created).not.toHaveProperty('tenantId');
    expect(ok(await platform.insurance.get(admin.token, corr(), created.id))).toEqual(created);

    const edited = ok(
      await platform.insurance.update(admin.token, corr(), created.id, 1, {
        insurer: 'Otra Ficticia',
      }),
    );
    expect(edited).toMatchObject({ insurer: 'Otra Ficticia', version: 2, revision: 1 });
    const renewed = ok(
      await platform.insurance.renew(admin.token, corr(), created.id, 2, renewal()),
    );
    expect(renewed).toMatchObject({
      revision: 2,
      version: 3,
      endsOn: '2027-12-31',
      covering: false,
      deductible: AMOUNT,
    });
    const history = ok(await platform.insurance.history(admin.token, corr(), created.id, {}));
    expect(history.items.map((r) => [r.revision, r.endsOn, r.status])).toEqual([
      [2, '2027-12-31', 'valid'],
      [1, '2026-12-31', 'replaced'],
    ]);
    expect(history.items[0]?.actorId).toBe(`user-${admin.identityId}`);
    const archived = ok(await platform.insurance.archive(admin.token, corr(), created.id, 3));
    expect(archived.archivedAt).not.toBeNull();
    expect(ok(await platform.insurance.list(admin.token, corr(), {})).items).toEqual([]);
    expect(
      ok(await platform.insurance.list(admin.token, corr(), { includeArchived: true })).items,
    ).toHaveLength(1);

    const events = auditOf(world, f.a.tenantId);
    expect(events.map((e) => e.action)).toEqual([
      'insurance_policy.created',
      'insurance_policy.updated',
      'insurance_policy.renewed',
      'insurance_policy.archived',
    ]);
    const text = JSON.stringify(events);
    for (const fragment of [
      'POL-001',
      'Aseguradora Ficticia',
      'Otra Ficticia',
      'RC y robo',
      '500000',
      'MXN',
    ])
      expect(text).not.toContain(fragment);
  });

  it('derives the status from the service clock as the calendar moves', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    // the clock starts on 2026-10-06; the last day (2026-11-06) is inclusive
    const policy = await seed(world, f, f.roles.admin, { endsOn: '2026-11-06' });
    let session = f.roles.admin;
    const status = async () => {
      const view = ok(await platform.insurance.get(session.token, corr(), policy.id));
      return [view.status, view.daysToExpiry, view.covering];
    };
    const DAY = 86_400_000;
    // sessions are short-lived: after each jump of the calendar the administrator signs in again
    const jump = async (days: number) => {
      world.advance(days * DAY);
      session = await world.signIn('subject-admin-a', f.a.tenantId);
    };
    expect(await status()).toEqual(['valid', 31, true]);
    await jump(1);
    expect(await status()).toEqual(['expiring', 30, true]);
    await jump(30);
    expect(await status()).toEqual(['expiring', 0, true]);
    await jump(1);
    expect(await status()).toEqual(['expired', -1, false]);
    const expired = ok(await platform.insurance.list(session.token, corr(), { status: 'expired' }));
    expect(expired.items.map((d) => d.id)).toEqual([policy.id]);
    ok(
      await platform.insurance.renew(
        session.token,
        corr(),
        policy.id,
        1,
        renewal({ startsOn: '2026-11-07', endsOn: '2027-12-31' }),
      ),
    );
    expect(await status()).toEqual(['valid', 419, true]);
    expect(
      ok(await platform.insurance.list(session.token, corr(), { status: 'expired' })).total,
    ).toBe(0);
  });

  it('lists with filters in end-date order and finds the policy covering a day', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const late = await seed(world, f, admin, { insurer: 'Tardía Ficticia', endsOn: '2027-06-01' });
    const soon = await seed(world, f, admin, { insurer: 'Pronto Ficticia', endsOn: '2026-10-10' });
    const future = await seed(world, f, admin, {
      insurer: 'Futura Ficticia',
      coverageType: 'mandatory_liability',
      startsOn: '2027-07-01',
      endsOn: '2028-06-30',
    });
    const gone = await seed(world, f, admin, { insurer: 'Vieja Ficticia', endsOn: '2026-09-30' });
    const ids = async (query: Record<string, unknown>) =>
      ok(await platform.insurance.list(admin.token, corr(), query)).items.map((d) => d.id);
    expect(await ids({})).toEqual([gone.id, soon.id, late.id, future.id]);
    expect(await ids({ vehicleId: f.vehicleA, coverageType: 'mandatory_liability' })).toEqual([
      future.id,
    ]);
    expect(await ids({ status: 'expiring' })).toEqual([soon.id]);
    expect(await ids({ status: 'expired' })).toEqual([gone.id]);
    // BR-019: the policies in force on the day of an event
    expect(await ids({ coversOn: '2026-10-06' })).toEqual([soon.id, late.id]);
    expect(await ids({ coversOn: '2026-10-10' })).toEqual([soon.id, late.id]);
    expect(await ids({ coversOn: '2026-10-11' })).toEqual([late.id]);
    expect(await ids({ coversOn: '2027-07-01' })).toEqual([future.id]);
    expect(await ids({ coversOn: '2027-06-01' })).toEqual([late.id]);
    const page = ok(await platform.insurance.list(admin.token, corr(), { limit: 2, offset: 1 }));
    expect(page.items.map((d) => d.id)).toEqual([soon.id, late.id]);
    expect(page.total).toBe(4);
    expect(page.tenantId).toBe(f.a.tenantId);
  });
});

type Run = (w: World, s: Session, p: PolicyView) => Promise<PlatformResponse<unknown>>;
const OPERATIONS: Readonly<Record<string, { permissions: string[]; run: Run }>> = {
  get: { permissions: ['view'], run: (w, s, p) => w.platform.insurance.get(s.token, corr(), p.id) },
  list: { permissions: ['view'], run: (w, s) => w.platform.insurance.list(s.token, corr(), {}) },
  history: {
    permissions: ['view'],
    run: (w, s, p) => w.platform.insurance.history(s.token, corr(), p.id, {}),
  },
  create: {
    permissions: ['create'],
    run: (w, s, p) =>
      w.platform.insurance.create(s.token, corr(), {
        vehicleId: p.vehicleId,
        insurer: 'Otra Ficticia',
        policyNumber: 'POL-9',
        coverageType: 'other',
        startsOn: '2026-01-01',
        endsOn: '2030-01-01',
      }),
  },
  createWithDeductible: {
    permissions: ['create', 'view_costs'],
    run: (w, s, p) =>
      w.platform.insurance.create(s.token, corr(), {
        vehicleId: p.vehicleId,
        insurer: 'Otra Ficticia',
        policyNumber: 'POL-9',
        coverageType: 'other',
        startsOn: '2026-01-01',
        endsOn: '2030-01-01',
        deductible: AMOUNT,
      }),
  },
  update: {
    permissions: ['edit'],
    run: (w, s, p) =>
      w.platform.insurance.update(s.token, corr(), p.id, 1, { insurer: 'Cambio Ficticio' }),
  },
  renew: {
    permissions: ['edit'],
    run: (w, s, p) => w.platform.insurance.renew(s.token, corr(), p.id, 1, renewal()),
  },
  renewWithDeductible: {
    permissions: ['edit', 'view_costs'],
    run: (w, s, p) =>
      w.platform.insurance.renew(s.token, corr(), p.id, 1, renewal({ deductible: AMOUNT })),
  },
  archive: {
    permissions: ['delete'],
    run: (w, s, p) => w.platform.insurance.archive(s.token, corr(), p.id, 1),
  },
};

const ROLE_GRANTS: Readonly<Record<RoleName, readonly string[]>> = {
  admin: ['view', 'create', 'edit', 'delete', 'view_pii', 'view_costs'],
  editor: ['view', 'create', 'edit'],
  viewer: ['view'],
  auditor: ['view'],
  pii_reader: ['view', 'create', 'view_pii'],
};

describe('role matrix over the existing generic permissions', () => {
  for (const role of Object.keys(ROLE_GRANTS) as RoleName[])
    it(`${role}: allowed exactly ${ROLE_GRANTS[role].join(', ')}; denied operations change nothing and are not audited`, async () => {
      world = createWorld();
      const f = await fixture(world);
      for (const [name, { run, permissions }] of Object.entries(OPERATIONS)) {
        // A fresh policy per operation, so one allowed change never makes another one stale.
        const target = await seed(world, f, f.roles.admin);
        const audited = auditOf(world, f.a.tenantId).length;
        const result = await run(world, f.roles[role], target);
        const allowed = permissions.every((permission) => ROLE_GRANTS[role].includes(permission));
        if (allowed) {
          expect(result.ok, `${role} ${name}`).toBe(true);
          const reads = permissions.length === 1 && permissions[0] === 'view';
          expect(auditOf(world, f.a.tenantId).length - audited, `${role} ${name}`).toBe(
            reads ? 0 : 1,
          );
        } else {
          expect(result.error, `${role} ${name}`).toMatchObject({ code: 'forbidden', status: 403 });
          expect(result.value).toBeUndefined();
          expect(auditOf(world, f.a.tenantId)).toHaveLength(audited);
          expect(
            ok(await world.platform.insurance.get(f.roles.admin.token, corr(), target.id)),
          ).toEqual(target);
        }
      }
    });

  it('asks the authorizer for the documented permissions on every operation', async () => {
    const asked: string[][] = [];
    const api = new InsuranceApi({
      service: new PolicyService(new InMemoryPolicyStore()),
      authorize: async (_token, _correlation, required) => {
        asked.push([...required]);
        throw new AuthError('forbidden');
      },
      can: async () => false,
      audit: () => undefined,
    });
    const deductible = { deductible: { kind: 'percent', basisPoints: 5 } };
    await api.get('t', 'c', 'x');
    await api.list('t', 'c', {});
    await api.history('t', 'c', 'x', {});
    await api.create('t', 'c', {});
    await api.create('t', 'c', deductible);
    await api.create('t', 'c', { deductible: null });
    await api.create('t', 'c', { deductible: 0 });
    await api.update('t', 'c', 'x', 1, {});
    await api.renew('t', 'c', 'x', 1, {});
    await api.renew('t', 'c', 'x', 1, deductible);
    await api.archive('t', 'c', 'x', 1);
    expect(asked).toEqual([
      ['view'],
      ['view'],
      ['view'],
      ['create'],
      ['create', 'view_costs'],
      ['create', 'view_costs'],
      ['create', 'view_costs'],
      ['edit'],
      ['edit'],
      ['edit', 'view_costs'],
      ['delete'],
    ]);
    expect(INSURANCE_PERMISSIONS).toEqual({
      read: ['view'],
      create: ['create'],
      change: ['edit'],
      archive: ['delete'],
      costs: ['view_costs'],
    });
  });

  it('shows the deductible only to a role with view_costs, in every read and write response', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin, { deductible: AMOUNT });
    const roles = Object.keys(ROLE_GRANTS) as RoleName[];
    for (const role of roles) {
      const costs = ROLE_GRANTS[role].includes('view_costs');
      const session = f.roles[role];
      const views = [
        ok(await platform.insurance.get(session.token, corr(), policy.id)),
        ...ok(await platform.insurance.list(session.token, corr(), {})).items,
        ...ok(await platform.insurance.history(session.token, corr(), policy.id, {})).items,
      ];
      for (const view of views) {
        expect(view.hasDeductible, role).toBe(true);
        expect(view.deductible, role).toEqual(costs ? AMOUNT : null);
      }
      expect(JSON.stringify(views).includes('500000'), role).toBe(costs);
    }
    // a write response hides it from a caller without view_costs too
    const edited = ok(
      await platform.insurance.update(f.roles.editor.token, corr(), policy.id, 1, {
        insurer: 'Editada Ficticia',
      }),
    );
    expect(edited).toMatchObject({ hasDeductible: true, deductible: null });
    // and an editor renewing without mentioning the deductible neither reads nor erases it
    const renewed = ok(
      await platform.insurance.renew(f.roles.editor.token, corr(), policy.id, 2, renewal()),
    );
    expect(renewed).toMatchObject({ hasDeductible: true, deductible: null });
    expect(
      ok(await platform.insurance.get(f.roles.admin.token, corr(), policy.id)).deductible,
    ).toEqual(AMOUNT);
    // mentioning the deductible at all, an explicit null included, needs view_costs
    const attempt = (session: Session, version: number) =>
      platform.insurance.renew(
        session.token,
        corr(),
        policy.id,
        version,
        renewal({ startsOn: '2028-01-01', endsOn: '2028-12-31', deductible: null }),
      );
    expect((await attempt(f.roles.editor, 3)).error).toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    const removed = ok(await attempt(f.roles.admin, 3));
    expect(removed).toMatchObject({ hasDeductible: false, deductible: null });
  });

  it('answers 403, not 400, to a caller without view_costs who sends a malformed deductible', async () => {
    world = createWorld();
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin);
    const audited = auditOf(world, f.a.tenantId).length;
    for (const deductible of [0, 'x', {}, { kind: 'percent', basisPoints: 0 }, null]) {
      const created = await world.platform.insurance.create(
        f.roles.editor.token,
        corr(),
        input(f, { deductible }),
      );
      const renewed = await world.platform.insurance.renew(
        f.roles.editor.token,
        corr(),
        policy.id,
        1,
        renewal({ deductible }),
      );
      for (const result of [created, renewed])
        expect(result.error, JSON.stringify(deductible)).toMatchObject({
          code: 'forbidden',
          status: 403,
        });
    }
    // with the permission the same value is a 400
    expect(
      (
        await world.platform.insurance.create(
          f.roles.admin.token,
          corr(),
          input(f, { deductible: 0 }),
        )
      ).error,
    ).toMatchObject({ code: 'invalid_input', status: 400 });
    expect(auditOf(world, f.a.tenantId)).toHaveLength(audited);
  });

  it('resolves view_costs before writing: a failure there writes and audits nothing', async () => {
    const store = new InMemoryPolicyStore();
    const events: string[] = [];
    const context = { tenantId: 'tenant-a', actor: { subject: 'sub-1' } } as never;
    const api = (can: () => Promise<boolean>) =>
      new InsuranceApi({
        service: new PolicyService(store),
        authorize: async () => context,
        can,
        audit: (_c, action) => {
          events.push(action);
        },
      });
    const failing = api(async () => {
      throw new Error('permission store unavailable');
    });
    const valid = {
      vehicleId: 'veh-1',
      insurer: 'Aseguradora Ficticia',
      policyNumber: 'POL-1',
      coverageType: 'other',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    };
    const result = await failing.create('t', 'c', valid);
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expect(events).toEqual([]);
    expect(
      (await store.list('tenant-a', { includeArchived: true }, { limit: 10, offset: 0 })).total,
    ).toBe(0);
    // once it resolves, the same call writes exactly once
    const working = api(async () => false);
    const created = await working.create('t', 'c', valid);
    expect(created.ok).toBe(true);
    expect(events).toEqual(['insurance_policy.created']);
    expect(
      (await store.list('tenant-a', { includeArchived: true }, { limit: 10, offset: 0 })).total,
    ).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('answers not_found to another tenant for every id-based operation, exactly as for an unknown id, and changes nothing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const run = (id: string) => ({
      get: platform.insurance.get(f.adminB.token, corr(), id),
      history: platform.insurance.history(f.adminB.token, corr(), id, {}),
      update: platform.insurance.update(f.adminB.token, corr(), id, 1, { insurer: 'Robada' }),
      renew: platform.insurance.renew(f.adminB.token, corr(), id, 1, renewal()),
      archive: platform.insurance.archive(f.adminB.token, corr(), id, 1),
    });
    const foreign = run(policy.id);
    const missing = run(unknown);
    for (const name of Object.keys(foreign) as (keyof typeof foreign)[]) {
      const [a, b] = await Promise.all([foreign[name], missing[name]]);
      expect(a.error, name).toMatchObject({ code: 'not_found', status: 404 });
      expect(a, name).toEqual(b);
    }
    expect(ok(await platform.insurance.get(f.roles.admin.token, corr(), policy.id))).toEqual(
      policy,
    );
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
  });

  it('keeps listings and audit trails per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const mine = await seed(world, f, f.roles.admin);
    const theirs = ok(
      await platform.insurance.create(f.adminB.token, corr(), input(f, { vehicleId: f.vehicleB })),
    );
    expect(theirs.id).not.toBe(mine.id);
    expect(ok(await platform.insurance.list(f.adminB.token, corr(), {})).items).toEqual([theirs]);
    expect(ok(await platform.insurance.list(f.roles.admin.token, corr(), {})).items).toEqual([
      mine,
    ]);
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
      { version: 9 },
      { revision: 4 },
      { id: 'chosen-id' },
      { status: 'expired' },
      { archivedAt: '2026-01-01T00:00:00.000Z' },
    ])
      expect(
        (await platform.insurance.create(admin.token, corr(), input(f, extra))).error,
      ).toMatchObject({ code: 'invalid_input' });
    const policy = await seed(world, f, admin);
    for (const patch of [
      { tenantId: f.b.tenantId },
      { vehicleId: f.vehicleB },
      { policyNumber: 'X1' },
      { endsOn: '2030-01-01' },
      { deductible: AMOUNT },
      { version: 3 },
    ])
      expect(
        (await platform.insurance.update(admin.token, corr(), policy.id, 1, patch)).error,
      ).toMatchObject({ code: 'invalid_input' });
    for (const bad of [{ insurer: 'x' }, { vehicleId: f.vehicleB }, { revision: 9 }])
      expect(
        (await platform.insurance.renew(admin.token, corr(), policy.id, 1, renewal(bad))).error,
      ).toMatchObject({ code: 'invalid_input' });
    expect(ok(await platform.insurance.list(f.adminB.token, corr(), {})).total).toBe(0);
  });

  it('denies a vehicle of another tenant, an unknown vehicle and an archived one with the same 422', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const archivedVehicle = ok(await platform.vehicles.archive(admin.token, corr(), f.vehicleA, 1));
    expect(archivedVehicle.archivedAt).not.toBeNull();
    const attempts = await Promise.all([
      platform.insurance.create(admin.token, corr(), input(f, { vehicleId: f.vehicleB })),
      platform.insurance.create(
        admin.token,
        corr(),
        input(f, { vehicleId: '00000000-0000-4000-8000-000000000000' }),
      ),
      platform.insurance.create(admin.token, corr(), input(f)),
    ]);
    for (const result of attempts)
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'invalid_vehicle',
          status: 422,
          message: 'Policy request rejected: invalid_vehicle',
          field: 'vehicle_id',
        },
      });
    expect(auditOf(world, f.a.tenantId)).toEqual([]);
  });

  it('keeps policies readable after their vehicle is archived, but refuses a renewal', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const policy = await seed(world, f, admin);
    ok(await platform.vehicles.archive(admin.token, corr(), f.vehicleA, 1));
    expect(ok(await platform.insurance.get(admin.token, corr(), policy.id)).version).toBe(1);
    expect(
      ok(
        await platform.insurance.update(admin.token, corr(), policy.id, 1, {
          insurer: 'Sigue editable',
        }),
      ).version,
    ).toBe(2);
    expect(
      (await platform.insurance.renew(admin.token, corr(), policy.id, 2, renewal())).error,
    ).toMatchObject({ code: 'invalid_vehicle', status: 422, field: 'vehicle_id' });
    expect(ok(await platform.insurance.history(admin.token, corr(), policy.id, {})).total).toBe(1);
  });
});

describe('sessions and tenants gate every call', () => {
  it('refuses a revoked session, a removed member and a suspended tenant, without writing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin);
    const calls = (s: Session) => [
      platform.insurance.list(s.token, corr(), {}),
      platform.insurance.get(s.token, corr(), policy.id),
      platform.insurance.history(s.token, corr(), policy.id, {}),
      platform.insurance.create(s.token, corr(), input(f)),
      platform.insurance.update(s.token, corr(), policy.id, 1, { insurer: 'xx' }),
      platform.insurance.renew(s.token, corr(), policy.id, 1, renewal()),
      platform.insurance.archive(s.token, corr(), policy.id, 1),
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
    expect(ok(await platform.insurance.get(f.roles.admin.token, corr(), policy.id))).toEqual(
      policy,
    );
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('rejects a token that is not a session', async () => {
    world = createWorld();
    await fixture(world);
    for (const token of ['', 'not-a-session', 'x'.repeat(2000)])
      expect((await world.platform.insurance.list(token, corr(), {})).error?.code).toBe(
        'unauthorized',
      );
  });

  it('applies a role change immediately', async () => {
    world = createWorld();
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin);
    expect((await world.platform.insurance.get(f.roles.editor.token, corr(), policy.id)).ok).toBe(
      true,
    );
    await world.platform.removeMember(f.roles.admin.token, corr(), f.roles.editor.identityId);
    expect(
      (await world.platform.insurance.get(f.roles.editor.token, corr(), policy.id)).error,
    ).toMatchObject({ code: 'unauthorized' });
  });
});

describe('business rules through the platform', () => {
  it('requires the number, the coverage and a real, ordered period', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const bad = [
      { policyNumber: ' ' },
      { coverageType: 'gold' },
      { startsOn: '2026-02-30' },
      { endsOn: '2025-12-31' },
      { endsOn: '2101-01-01' },
      { deductible: { kind: 'amount', amountMinor: 0, currency: 'MXN' } },
      { deductible: { kind: 'percent', basisPoints: 10001 } },
    ];
    for (const over of bad)
      expect(
        (await platform.insurance.create(admin.token, corr(), input(f, over))).error,
        JSON.stringify(over),
      ).toMatchObject({ code: 'invalid_input' });
    // a renewal needs a new period and keeps the number, coverage and deductible when omitted
    const policy = await seed(world, f, admin, {
      deductible: { kind: 'percent', basisPoints: 1500 },
      coverageType: 'third_party',
    });
    expect(
      (await platform.insurance.renew(admin.token, corr(), policy.id, 1, {})).error,
    ).toMatchObject({ code: 'invalid_input' });
    const renewed = ok(
      await platform.insurance.renew(admin.token, corr(), policy.id, 1, renewal()),
    );
    expect(renewed).toMatchObject({
      policyNumber: 'POL-001',
      coverageType: 'third_party',
      deductible: { kind: 'percent', basisPoints: 1500 },
    });
  });

  it('allows several policies in force at once for one vehicle', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    await seed(world, f, admin, { coverageType: 'mandatory_liability', policyNumber: 'RC-1' });
    await seed(world, f, admin, { coverageType: 'comprehensive', policyNumber: 'TR-1' });
    const covering = ok(
      await platform.insurance.list(admin.token, corr(), { coversOn: '2026-10-06' }),
    );
    expect(covering.items.map((p) => p.coverageType).sort()).toEqual([
      'comprehensive',
      'mandatory_liability',
    ]);
  });

  it('keeps archived policies read-only and every revision available', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const policy = await seed(world, f, admin);
    ok(await platform.insurance.renew(admin.token, corr(), policy.id, 1, renewal()));
    ok(await platform.insurance.archive(admin.token, corr(), policy.id, 2));
    for (const result of [
      await platform.insurance.update(admin.token, corr(), policy.id, 3, { insurer: 'xx' }),
      await platform.insurance.renew(admin.token, corr(), policy.id, 3, renewal()),
      await platform.insurance.archive(admin.token, corr(), policy.id, 3),
    ])
      expect(result.error).toMatchObject({ code: 'immutable', status: 409 });
    expect(ok(await platform.insurance.history(admin.token, corr(), policy.id, {})).total).toBe(2);
  });

  it('validates every input with a uniform 400 and no echo of the value', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const fake = 'FAKE-<script>-TEXT';
    const policy = await seed(world, f, admin);
    const results = [
      await platform.insurance.create(admin.token, corr(), input(f, { insurer: `${fake}\u0007` })),
      await platform.insurance.create(admin.token, corr(), input(f, { policyNumber: fake })),
      await platform.insurance.create(admin.token, corr(), input(f, { coverageType: fake })),
      await platform.insurance.create(admin.token, corr(), { insurer: 'x' }),
      await platform.insurance.update(admin.token, corr(), policy.id, 'one', { insurer: 'xx' }),
      await platform.insurance.update(admin.token, corr(), policy.id, 1, {}),
      await platform.insurance.renew(
        admin.token,
        corr(),
        policy.id,
        1,
        renewal({ endsOn: '2027-02-30' }),
      ),
      await platform.insurance.list(admin.token, corr(), { status: fake }),
      await platform.insurance.list(admin.token, corr(), { coversOn: fake }),
      await platform.insurance.list(admin.token, corr(), { limit: 1000 }),
      await platform.insurance.history(admin.token, corr(), policy.id, { offset: -1 }),
      await platform.insurance.get(admin.token, corr(), 'has space'),
    ];
    for (const result of results) {
      expect(result.error).toMatchObject({ code: 'invalid_input', status: 400 });
      expect(JSON.stringify(result)).not.toContain(fake);
    }
  });
});

describe('concurrency', () => {
  it('lets exactly one of many concurrent renewals with the same version win', async () => {
    world = createWorld();
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        world.platform.insurance.renew(
          f.roles.admin.token,
          corr(),
          policy.id,
          1,
          renewal({ endsOn: `${2028 + i}-01-01` }),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'stale_version')).toHaveLength(11);
    expect(
      ok(await world.platform.insurance.history(f.roles.admin.token, corr(), policy.id, {})).total,
    ).toBe(2);
  });

  it('serializes a renewal, an edit and an archive on the same version: one wins', async () => {
    world = createWorld();
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin);
    const admin = f.roles.admin.token;
    const results = await Promise.all([
      world.platform.insurance.renew(admin, corr(), policy.id, 1, renewal()),
      world.platform.insurance.update(admin, corr(), policy.id, 1, { insurer: 'Otra Ficticia' }),
      world.platform.insurance.archive(admin, corr(), policy.id, 1),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'stale_version')).toHaveLength(2);
  });
});

describe('adapters and failures', () => {
  it('uses the injected policy store', async () => {
    const store = new InMemoryPolicyStore();
    world = createWorld({ adapters: { insurance: store } });
    const f = await fixture(world);
    const policy = await seed(world, f, f.roles.admin);
    expect(await store.find(f.a.tenantId, policy.id)).toMatchObject({
      insurer: 'Aseguradora Ficticia',
      tenantId: f.a.tenantId,
    });
  });

  it('turns an infrastructure failure into a generic 500 without leaking its message', async () => {
    const inner = new InMemoryPolicyStore();
    const broken: PolicyStore = {
      insert: async () => {
        throw new Error('connection to db-prod.internal refused for POL-FICTICIA-1');
      },
      find: (t, id) => inner.find(t, id),
      list: (t, f, w) => inner.list(t, f, w),
      replace: (n, e, r) => inner.replace(n, e, r),
      revisions: (t, d, w) => inner.revisions(t, d, w),
    };
    world = createWorld({ adapters: { insurance: broken } });
    const f = await fixture(world);
    const result = await world.platform.insurance.create(f.roles.admin.token, corr(), input(f));
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
    const result = await platform.insurance.list('t', corr(), {});
    expect(result.error).toMatchObject({ code: 'internal_error', status: 500 });
    platform.identity.authenticate = original;
  });
});

describe('typed views', () => {
  it('exposes exactly the declared fields', async () => {
    world = createWorld();
    const f = await fixture(world);
    const v: PolicyView = await seed(world, f, f.roles.admin);
    expect(Object.keys(v).sort()).toEqual(
      [
        'id',
        'vehicleId',
        'insurer',
        'coverageNotes',
        'revision',
        'policyNumber',
        'coverageType',
        'startsOn',
        'endsOn',
        'status',
        'daysToExpiry',
        'covering',
        'hasDeductible',
        'deductible',
        'version',
        'createdAt',
        'updatedAt',
        'archivedAt',
      ].sort(),
    );
    const history = ok(
      await world.platform.insurance.history(f.roles.admin.token, corr(), v.id, {}),
    );
    expect(Object.keys(history.items[0] ?? {}).sort()).toEqual(
      [
        'revision',
        'policyNumber',
        'coverageType',
        'startsOn',
        'endsOn',
        'status',
        'hasDeductible',
        'deductible',
        'actorId',
        'at',
      ].sort(),
    );
  });
});
