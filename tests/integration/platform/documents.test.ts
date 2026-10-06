import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_PERMISSIONS,
  DocumentsApi,
  InMemoryDocumentStore,
  type DocumentView,
  type PlatformResponse,
  type RoleName,
} from '../../../apps/api/composition/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import {
  DocumentService,
  type DocumentStore,
} from '../../../packages/domain/documents/src/index.js';
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
  readonly employeeA: string;
  readonly vehicleB: string;
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
  const owners = async (session: Session) => {
    const area = ok(await w.platform.areas.create(session.token, corr(), { name: 'Flota' })).id;
    serial += 1;
    const vehicle = ok(
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
    const employee = ok(
      await w.platform.employees.create(session.token, corr(), {
        kind: 'other',
        firstName: 'Luis',
        lastName: 'Gómez',
        areaId: area,
      }),
    ).id;
    return { vehicle, employee };
  };
  const ownersA = await owners(a.admin);
  const ownersB = await owners(b.admin);
  return {
    a,
    b,
    roles,
    adminB: b.admin,
    vehicleA: ownersA.vehicle,
    employeeA: ownersA.employee,
    vehicleB: ownersB.vehicle,
  };
}

const input = (f: Fixture, over: Record<string, unknown> = {}) => ({
  ownerType: 'vehicle',
  ownerId: f.vehicleA,
  typeCode: 'registration_card',
  title: 'Tarjeta de circulación',
  expiresOn: '2027-03-31',
  ...over,
});
const seed = async (w: World, f: Fixture, session: Session, over: Record<string, unknown> = {}) =>
  ok(await w.platform.documents.create(session.token, corr(), input(f, over)));
const auditOf = (w: World, tenantId: string) =>
  w.audit.list(tenantId).filter((event) => event.entityType === 'document');

describe('document lifecycle through the platform', () => {
  it('creates, reads, edits, renews and archives, auditing each write without values', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const created = ok(
      await platform.documents.create(
        admin.token,
        corr(),
        input(f, { issuedOn: '2025-03-31', documentNumber: 'tc-001', notes: 'Original' }),
      ),
    );
    expect(created).toMatchObject({
      ownerType: 'vehicle',
      ownerId: f.vehicleA,
      typeCode: 'registration_card',
      revision: 1,
      version: 1,
      documentNumber: 'TC-001',
      status: 'valid',
      daysToExpiry: 176,
      archivedAt: null,
    });
    expect(created).not.toHaveProperty('tenantId');
    expect(ok(await platform.documents.get(admin.token, corr(), created.id))).toEqual(created);

    const edited = ok(
      await platform.documents.update(admin.token, corr(), created.id, 1, { title: 'Nueva' }),
    );
    expect(edited).toMatchObject({ title: 'Nueva', version: 2, revision: 1 });
    const renewed = ok(
      await platform.documents.renew(admin.token, corr(), created.id, 2, {
        issuedOn: '2026-10-01',
        expiresOn: '2028-03-31',
      }),
    );
    expect(renewed).toMatchObject({ revision: 2, version: 3, expiresOn: '2028-03-31' });
    const history = ok(await platform.documents.history(admin.token, corr(), created.id, {}));
    expect(history.items.map((r) => [r.revision, r.expiresOn, r.status])).toEqual([
      [2, '2028-03-31', 'valid'],
      [1, '2027-03-31', 'replaced'],
    ]);
    expect(history.items[0]?.actorId).toBe(`user-${admin.identityId}`);
    const archived = ok(await platform.documents.archive(admin.token, corr(), created.id, 3));
    expect(archived.archivedAt).not.toBeNull();
    expect(ok(await platform.documents.list(admin.token, corr(), {})).items).toEqual([]);
    expect(
      ok(await platform.documents.list(admin.token, corr(), { includeArchived: true })).items,
    ).toHaveLength(1);

    const events = auditOf(world, f.a.tenantId);
    expect(events.map((e) => e.action)).toEqual([
      'document.created',
      'document.updated',
      'document.renewed',
      'document.archived',
    ]);
    const text = JSON.stringify(events);
    for (const fragment of ['TC-001', 'Original', 'Tarjeta de circulación', '2028-03-31'])
      expect(text).not.toContain(fragment);
  });

  it('derives the status from the service clock as the calendar moves', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    // the clock starts on 2026-10-06; the last valid day (2026-11-06) is inclusive
    const doc = await seed(world, f, f.roles.admin, { expiresOn: '2026-11-06' });
    let session = f.roles.admin;
    const status = async () => {
      const view = ok(await platform.documents.get(session.token, corr(), doc.id));
      return [view.status, view.daysToExpiry];
    };
    const DAY = 86_400_000;
    // sessions are short-lived: after each jump of the calendar the administrator signs in again
    const jump = async (days: number) => {
      world.advance(days * DAY);
      session = await world.signIn('subject-admin-a', f.a.tenantId);
    };
    expect(await status()).toEqual(['valid', 31]);
    await jump(1);
    expect(await status()).toEqual(['expiring', 30]);
    await jump(30);
    expect(await status()).toEqual(['expiring', 0]);
    await jump(1);
    expect(await status()).toEqual(['expired', -1]);
    const expired = ok(await platform.documents.list(session.token, corr(), { status: 'expired' }));
    expect(expired.items.map((d) => d.id)).toEqual([doc.id]);
    ok(
      await platform.documents.renew(session.token, corr(), doc.id, 1, { expiresOn: '2027-12-31' }),
    );
    expect(await status()).toEqual(['valid', 419]);
    expect(
      ok(await platform.documents.list(session.token, corr(), { status: 'expired' })).total,
    ).toBe(0);
  });

  it('lists with filters in expiry order and exposes pagination fields', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const late = await seed(world, f, admin, { title: 'Tardía', expiresOn: '2027-06-01' });
    const soon = await seed(world, f, admin, { title: 'Pronto', expiresOn: '2026-10-10' });
    const none = await seed(world, f, admin, {
      title: 'Sin vencimiento',
      typeCode: 'ownership_title',
      expiresOn: null,
    });
    const emp = await seed(world, f, admin, {
      ownerType: 'employee',
      ownerId: f.employeeA,
      typeCode: 'medical_exam',
      title: 'Examen',
      expiresOn: '2026-12-01',
    });
    const ids = async (query: Record<string, unknown>) =>
      ok(await platform.documents.list(admin.token, corr(), query)).items.map((d) => d.id);
    expect(await ids({})).toEqual([soon.id, emp.id, late.id, none.id]);
    expect(await ids({ ownerType: 'employee', ownerId: f.employeeA })).toEqual([emp.id]);
    expect(await ids({ typeCode: 'ownership_title' })).toEqual([none.id]);
    expect(await ids({ status: 'expiring' })).toEqual([soon.id]);
    const page = ok(await platform.documents.list(admin.token, corr(), { limit: 2, offset: 1 }));
    expect(page.items.map((d) => d.id)).toEqual([emp.id, late.id]);
    expect(page.total).toBe(4);
    expect(page.tenantId).toBe(f.a.tenantId);
  });
});

type Run = (w: World, s: Session, doc: DocumentView) => Promise<PlatformResponse<unknown>>;
const OPERATIONS: Readonly<Record<string, { permissions: string[]; run: Run }>> = {
  get: { permissions: ['view'], run: (w, s, d) => w.platform.documents.get(s.token, corr(), d.id) },
  list: { permissions: ['view'], run: (w, s) => w.platform.documents.list(s.token, corr(), {}) },
  history: {
    permissions: ['view'],
    run: (w, s, d) => w.platform.documents.history(s.token, corr(), d.id, {}),
  },
  create: {
    permissions: ['create'],
    run: (w, s, d) =>
      w.platform.documents.create(s.token, corr(), {
        ownerType: d.ownerType,
        ownerId: d.ownerId,
        typeCode: d.typeCode,
        title: 'Otra',
        expiresOn: '2030-01-01',
      }),
  },
  update: {
    permissions: ['edit'],
    run: (w, s, d) => w.platform.documents.update(s.token, corr(), d.id, 1, { title: 'Cambio' }),
  },
  renew: {
    permissions: ['edit'],
    run: (w, s, d) =>
      w.platform.documents.renew(s.token, corr(), d.id, 1, { expiresOn: '2030-01-01' }),
  },
  archive: {
    permissions: ['delete'],
    run: (w, s, d) => w.platform.documents.archive(s.token, corr(), d.id, 1),
  },
};

const ROLE_GRANTS: Readonly<Record<RoleName, readonly string[]>> = {
  admin: ['view', 'create', 'edit', 'delete', 'view_pii'],
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
        // A fresh document per operation, so one allowed change never makes another one stale.
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
            ok(await world.platform.documents.get(f.roles.admin.token, corr(), target.id)),
          ).toEqual(target);
        }
      }
    });

  it('asks the authorizer for the documented permissions on every operation', async () => {
    const asked: string[][] = [];
    const api = new DocumentsApi({
      service: new DocumentService(new InMemoryDocumentStore()),
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
    await api.renew('t', 'c', 'x', 1, {});
    await api.archive('t', 'c', 'x', 1);
    expect(asked).toEqual([
      ['view'],
      ['view'],
      ['view'],
      ['create'],
      ['edit'],
      ['edit'],
      ['delete'],
    ]);
    expect(DOCUMENT_PERMISSIONS).toEqual({
      read: ['view'],
      create: ['create'],
      change: ['edit'],
      archive: ['delete'],
    });
  });
});

describe('tenant isolation', () => {
  it('answers not_found to another tenant for every id-based operation, exactly as for an unknown id, and changes nothing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const doc = await seed(world, f, f.roles.admin);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const run = (id: string) => ({
      get: platform.documents.get(f.adminB.token, corr(), id),
      history: platform.documents.history(f.adminB.token, corr(), id, {}),
      update: platform.documents.update(f.adminB.token, corr(), id, 1, { title: 'Robado' }),
      renew: platform.documents.renew(f.adminB.token, corr(), id, 1, { expiresOn: '2030-01-01' }),
      archive: platform.documents.archive(f.adminB.token, corr(), id, 1),
    });
    const foreign = run(doc.id);
    const missing = run(unknown);
    for (const name of Object.keys(foreign) as (keyof typeof foreign)[]) {
      const [a, b] = await Promise.all([foreign[name], missing[name]]);
      expect(a.error, name).toMatchObject({ code: 'not_found', status: 404 });
      expect(a, name).toEqual(b);
    }
    expect(ok(await platform.documents.get(f.roles.admin.token, corr(), doc.id))).toEqual(doc);
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
  });

  it('keeps listings and audit trails per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const mine = await seed(world, f, f.roles.admin);
    const theirs = ok(
      await platform.documents.create(f.adminB.token, corr(), input(f, { ownerId: f.vehicleB })),
    );
    expect(theirs.id).not.toBe(mine.id);
    expect(ok(await platform.documents.list(f.adminB.token, corr(), {})).items).toEqual([theirs]);
    expect(ok(await platform.documents.list(f.roles.admin.token, corr(), {})).items).toEqual([
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
        (await platform.documents.create(admin.token, corr(), input(f, extra))).error,
      ).toMatchObject({ code: 'invalid_input' });
    const doc = await seed(world, f, admin);
    for (const patch of [
      { tenantId: f.b.tenantId },
      { ownerId: f.vehicleB },
      { ownerType: 'employee' },
      { typeCode: 'other' },
      { expiresOn: '2030-01-01' },
      { version: 3 },
    ])
      expect(
        (await platform.documents.update(admin.token, corr(), doc.id, 1, patch)).error,
      ).toMatchObject({ code: 'invalid_input' });
    for (const renewal of [{ title: 'x' }, { ownerId: f.vehicleB }, { revision: 9 }])
      expect(
        (await platform.documents.renew(admin.token, corr(), doc.id, 1, renewal)).error,
      ).toMatchObject({ code: 'invalid_input' });
    expect(ok(await platform.documents.list(f.adminB.token, corr(), {})).total).toBe(0);
  });

  it('denies an owner of another tenant, an unknown owner and an archived one with the same 422', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const archivedVehicle = ok(await platform.vehicles.archive(admin.token, corr(), f.vehicleA, 1));
    expect(archivedVehicle.archivedAt).not.toBeNull();
    const archivedEmployee = ok(
      await platform.employees.archive(admin.token, corr(), f.employeeA, 1),
    );
    expect(archivedEmployee.archivedAt).not.toBeNull();
    const attempts = await Promise.all([
      platform.documents.create(admin.token, corr(), input(f, { ownerId: f.vehicleB })),
      platform.documents.create(
        admin.token,
        corr(),
        input(f, { ownerId: '00000000-0000-4000-8000-000000000000' }),
      ),
      platform.documents.create(admin.token, corr(), input(f)),
      platform.documents.create(
        admin.token,
        corr(),
        input(f, { ownerType: 'employee', ownerId: f.employeeA, typeCode: 'medical_exam' }),
      ),
      // a vehicle id used as an employee owner
      platform.documents.create(
        admin.token,
        corr(),
        input(f, { ownerType: 'employee', ownerId: f.vehicleB, typeCode: 'medical_exam' }),
      ),
    ]);
    for (const result of attempts)
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'invalid_owner',
          status: 422,
          message: 'Document request rejected: invalid_owner',
          field: 'owner_id',
        },
      });
    expect(auditOf(world, f.a.tenantId)).toEqual([]);
  });

  it('keeps documents readable after their owner is archived, but refuses a renewal', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const doc = await seed(world, f, admin);
    ok(await platform.vehicles.archive(admin.token, corr(), f.vehicleA, 1));
    expect(ok(await platform.documents.get(admin.token, corr(), doc.id)).version).toBe(1);
    expect(
      ok(
        await platform.documents.update(admin.token, corr(), doc.id, 1, {
          title: 'Sigue editable',
        }),
      ).version,
    ).toBe(2);
    expect(
      (await platform.documents.renew(admin.token, corr(), doc.id, 2, { expiresOn: '2030-01-01' }))
        .error,
    ).toMatchObject({ code: 'invalid_owner', status: 422, field: 'owner_id' });
    expect(ok(await platform.documents.history(admin.token, corr(), doc.id, {})).total).toBe(1);
  });
});

describe('sessions and tenants gate every call', () => {
  it('refuses a revoked session, a removed member and a suspended tenant, without writing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const doc = await seed(world, f, f.roles.admin);
    const calls = (s: Session) => [
      platform.documents.list(s.token, corr(), {}),
      platform.documents.get(s.token, corr(), doc.id),
      platform.documents.create(s.token, corr(), input(f)),
      platform.documents.update(s.token, corr(), doc.id, 1, { title: 'x' }),
      platform.documents.renew(s.token, corr(), doc.id, 1, { expiresOn: '2030-01-01' }),
      platform.documents.archive(s.token, corr(), doc.id, 1),
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
    expect(ok(await platform.documents.get(f.roles.admin.token, corr(), doc.id))).toEqual(doc);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('rejects a token that is not a session', async () => {
    world = createWorld();
    await fixture(world);
    for (const token of ['', 'not-a-session', 'x'.repeat(2000)])
      expect((await world.platform.documents.list(token, corr(), {})).error?.code).toBe(
        'unauthorized',
      );
  });

  it('applies a role change immediately', async () => {
    world = createWorld();
    const f = await fixture(world);
    const doc = await seed(world, f, f.roles.admin);
    expect((await world.platform.documents.get(f.roles.editor.token, corr(), doc.id)).ok).toBe(
      true,
    );
    await world.platform.removeMember(f.roles.admin.token, corr(), f.roles.editor.identityId);
    expect(
      (await world.platform.documents.get(f.roles.editor.token, corr(), doc.id)).error,
    ).toMatchObject({ code: 'unauthorized' });
  });
});

describe('business rules through the platform', () => {
  it('requires an expiry for the types that need one and accepts none for the others', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    for (const code of ['registration_card', 'technical_inspection', 'transport_permit'])
      expect(
        (
          await platform.documents.create(
            admin.token,
            corr(),
            input(f, { typeCode: code, expiresOn: null }),
          )
        ).error,
      ).toMatchObject({ code: 'invalid_input' });
    const title = ok(
      await platform.documents.create(
        admin.token,
        corr(),
        input(f, { typeCode: 'ownership_title', expiresOn: null }),
      ),
    );
    expect(title).toMatchObject({ expiresOn: null, status: 'valid', daysToExpiry: null });
    // an employee type is not valid for a vehicle, and the other way round
    for (const over of [
      { typeCode: 'medical_exam' },
      { ownerType: 'employee', ownerId: f.employeeA, typeCode: 'registration_card' },
    ])
      expect(
        (await platform.documents.create(admin.token, corr(), input(f, over))).error,
      ).toMatchObject({ code: 'invalid_input' });
    // a renewal of a type that must expire still needs an expiry
    const card = await seed(world, f, admin);
    expect(
      (await platform.documents.renew(admin.token, corr(), card.id, 1, { documentNumber: 'X1' }))
        .error,
    ).toMatchObject({ code: 'invalid_input' });
  });

  it('keeps archived documents read-only and every revision available', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const doc = await seed(world, f, admin);
    ok(await platform.documents.renew(admin.token, corr(), doc.id, 1, { expiresOn: '2028-01-01' }));
    ok(await platform.documents.archive(admin.token, corr(), doc.id, 2));
    for (const result of [
      await platform.documents.update(admin.token, corr(), doc.id, 3, { title: 'x' }),
      await platform.documents.renew(admin.token, corr(), doc.id, 3, { expiresOn: '2030-01-01' }),
      await platform.documents.archive(admin.token, corr(), doc.id, 3),
    ])
      expect(result.error).toMatchObject({ code: 'immutable', status: 409 });
    expect(ok(await platform.documents.history(admin.token, corr(), doc.id, {})).total).toBe(2);
  });

  it('validates every input with a uniform 400 and no echo of the value', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const secret = 'SECRET-<script>-VALUE';
    const doc = await seed(world, f, admin);
    const results = [
      await platform.documents.create(admin.token, corr(), input(f, { title: `${secret}\u0007` })),
      await platform.documents.create(admin.token, corr(), input(f, { documentNumber: secret })),
      await platform.documents.create(admin.token, corr(), input(f, { ownerType: secret })),
      await platform.documents.create(admin.token, corr(), { title: 'x' }),
      await platform.documents.update(admin.token, corr(), doc.id, 'one', { title: 'x' }),
      await platform.documents.update(admin.token, corr(), doc.id, 1, {}),
      await platform.documents.renew(admin.token, corr(), doc.id, 1, { expiresOn: '2027-02-30' }),
      await platform.documents.list(admin.token, corr(), { status: secret }),
      await platform.documents.list(admin.token, corr(), { limit: 1000 }),
      await platform.documents.history(admin.token, corr(), doc.id, { offset: -1 }),
      await platform.documents.get(admin.token, corr(), 'has space'),
    ];
    for (const result of results) {
      expect(result.error).toMatchObject({ code: 'invalid_input', status: 400 });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});

describe('concurrency', () => {
  it('lets exactly one of many concurrent renewals with the same version win', async () => {
    world = createWorld();
    const f = await fixture(world);
    const doc = await seed(world, f, f.roles.admin);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        world.platform.documents.renew(f.roles.admin.token, corr(), doc.id, 1, {
          expiresOn: `${2028 + i}-01-01`,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'stale_version')).toHaveLength(11);
    expect(
      ok(await world.platform.documents.history(f.roles.admin.token, corr(), doc.id, {})).total,
    ).toBe(2);
  });

  it('serializes a renewal, an edit and an archive on the same version: one wins', async () => {
    world = createWorld();
    const f = await fixture(world);
    const doc = await seed(world, f, f.roles.admin);
    const admin = f.roles.admin.token;
    const results = await Promise.all([
      world.platform.documents.renew(admin, corr(), doc.id, 1, { expiresOn: '2030-01-01' }),
      world.platform.documents.update(admin, corr(), doc.id, 1, { title: 'Otro' }),
      world.platform.documents.archive(admin, corr(), doc.id, 1),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === 'stale_version')).toHaveLength(2);
  });
});

describe('adapters and failures', () => {
  it('uses the injected document store', async () => {
    const store = new InMemoryDocumentStore();
    world = createWorld({ adapters: { documents: store } });
    const f = await fixture(world);
    const doc = await seed(world, f, f.roles.admin);
    expect(await store.find(f.a.tenantId, doc.id)).toMatchObject({
      title: 'Tarjeta de circulación',
      tenantId: f.a.tenantId,
    });
  });

  it('turns an infrastructure failure into a generic 500 without leaking its message', async () => {
    const inner = new InMemoryDocumentStore();
    const broken: DocumentStore = {
      insert: async () => {
        throw new Error('connection to db-prod.internal refused for TC-SECRETO-1');
      },
      find: (t, id) => inner.find(t, id),
      list: (t, f, w) => inner.list(t, f, w),
      replace: (n, e, r) => inner.replace(n, e, r),
      revisions: (t, d, w) => inner.revisions(t, d, w),
    };
    world = createWorld({ adapters: { documents: broken } });
    const f = await fixture(world);
    const result = await world.platform.documents.create(f.roles.admin.token, corr(), input(f));
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
    const result = await platform.documents.list('t', corr(), {});
    expect(result.error).toMatchObject({ code: 'internal_error', status: 500 });
    platform.identity.authenticate = original;
  });
});

describe('typed views', () => {
  it('exposes exactly the declared fields', async () => {
    world = createWorld();
    const f = await fixture(world);
    const v: DocumentView = await seed(world, f, f.roles.admin);
    expect(Object.keys(v).sort()).toEqual(
      [
        'id',
        'ownerType',
        'ownerId',
        'typeCode',
        'title',
        'notes',
        'revision',
        'issuedOn',
        'expiresOn',
        'documentNumber',
        'status',
        'daysToExpiry',
        'version',
        'createdAt',
        'updatedAt',
        'archivedAt',
      ].sort(),
    );
    const history = ok(
      await world.platform.documents.history(f.roles.admin.token, corr(), v.id, {}),
    );
    expect(Object.keys(history.items[0] ?? {}).sort()).toEqual(
      ['revision', 'issuedOn', 'expiresOn', 'documentNumber', 'status', 'actorId', 'at'].sort(),
    );
  });
});
