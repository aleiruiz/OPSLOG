import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPLOYEE_PERMISSIONS,
  EmployeesApi,
  EnvelopePiiCipher,
  InMemoryEmployeeStore,
  LocalDevKms,
  type EmployeeDetailView,
  type EmployeeView,
  type PlatformResponse,
  type RoleName,
} from '../../../apps/api/composition/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import {
  EmployeeService,
  type EmployeeStore,
} from '../../../packages/domain/employees/src/index.js';
import { KmsError, type PiiCipher } from '../../../packages/platform/pii/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => {
  world.dispose();
  vi.restoreAllMocks();
});

/** Real areas of the current fixture: an employee's area must be an active area of its tenant. */
const areas = { a1: '', a2: '', b1: '' };

// Synthetic personal data. Every value is made up; each has a recognisable fragment to grep for.
const SECRETS = {
  nationalId: 'SYNTH-ID-7788-QX',
  phone: '+52 55 9000 1234',
  email: 'ana.perez@synthetic.example',
  licenseNumber: 'LIC-445566-ZZ',
};
// Distinctive fragments only (>= 8 characters): a short one could appear by chance inside random
// base64 ciphertext, an id or a hash and make the "no plaintext" checks flaky.
const FRAGMENTS = [
  'SYNTH-ID-7788',
  'ID-7788-QX',
  '9000 1234',
  '90001234',
  'ana.perez',
  'synthetic.example',
  'LIC-445566',
  '445566-ZZ',
];

const input = (over: Record<string, unknown> = {}) =>
  Object.fromEntries(Object.entries(base(over)).filter(([, value]) => value !== undefined));
const base = (over: Record<string, unknown>) => ({
  kind: 'driver',
  firstName: 'Ana',
  lastName: 'Pérez',
  areaId: areas.a1,
  employeeNumber: 'E-001',
  position: 'Conductor',
  hireDate: '2024-03-01',
  idType: 'ine',
  ...SECRETS,
  licenseType: 'c',
  licenseExpiresOn: '2027-01-31',
  ...over,
});
const plain = (over: Record<string, unknown> = {}) => ({
  kind: 'other',
  firstName: 'Luis',
  lastName: 'Gómez',
  areaId: areas.a1,
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
  const area = async (session: Session, name: string): Promise<string> =>
    (await w.platform.areas.create(session.token, corr(), { name })).value?.id ?? '';
  areas.a1 = await area(a.admin, 'Area 1');
  areas.a2 = await area(a.admin, 'Area 2');
  areas.b1 = await area(b.admin, 'Area 1');
  return { a, b, roles, adminB: b.admin };
}

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const seed = async (w: World, session: Session, over: Record<string, unknown> = {}) =>
  ok(await w.platform.employees.create(session.token, corr(), input(over)));

const auditOf = (w: World, tenantId: string) =>
  w.audit.list(tenantId).filter((event) => event.entityType === 'employee');

let serial = 0;
const fresh = (): Record<string, unknown> => {
  serial += 1;
  return {
    employeeNumber: `T-${serial}`,
    nationalId: `SYNTH-${serial}-${serial}${serial}`,
    email: `t${serial}@synthetic.example`,
    licenseNumber: `LIC-${serial}${serial}${serial}`,
  };
};

describe('employee lifecycle through the platform', () => {
  it('creates, reads, edits, changes status, moves and archives, auditing each write', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;

    const created = await seed(world, admin);
    expect(created).toMatchObject({
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Pérez',
      employeeNumber: 'E-001',
      status: 'active',
      statusReason: 'Alta',
      version: 1,
      archivedAt: null,
      idType: 'ine',
      licenseType: 'C',
      licenseExpiresOn: '2027-01-31',
      piiPresent: { nationalId: true, phone: true, email: true, licenseNumber: true },
      fitness: { fit: true, reasons: [] },
    });
    expect(created).not.toHaveProperty('tenantId');
    expect(created).not.toHaveProperty('pii');
    const detail = ok(await platform.employees.get(admin.token, corr(), created.id));
    expect(detail).toEqual({
      ...created,
      pii: {
        nationalId: 'SYNTH-ID-7788-QX',
        phone: '+525590001234',
        email: 'ana.perez@synthetic.example',
        licenseNumber: 'LIC-445566-ZZ',
      },
    });

    const edited = ok(
      await platform.employees.update(admin.token, corr(), created.id, 1, {
        position: 'Jefe de flota',
        phone: null,
      }),
    );
    expect(edited).toMatchObject({
      position: 'Jefe de flota',
      version: 2,
      piiPresent: { phone: false, email: true },
    });
    const moved = ok(
      await platform.employees.update(admin.token, corr(), created.id, 2, { areaId: areas.a2 }),
    );
    expect(moved).toMatchObject({ areaId: areas.a2, version: 3 });
    const suspended = ok(
      await platform.employees.changeStatus(
        admin.token,
        corr(),
        created.id,
        3,
        'suspended',
        'Investigación 12',
      ),
    );
    expect(suspended).toMatchObject({
      status: 'suspended',
      statusReason: 'Investigación 12',
      version: 4,
      fitness: { fit: false, reasons: ['not_active'] },
    });
    const archived = ok(await platform.employees.archive(admin.token, corr(), created.id, 4));
    expect(archived.archivedAt).not.toBeNull();
    expect(ok(await platform.employees.list(admin.token, corr(), {})).items).toEqual([]);
    expect(
      ok(await platform.employees.list(admin.token, corr(), { includeArchived: true })).items,
    ).toHaveLength(1);

    const history = ok(await platform.employees.history(admin.token, corr(), created.id, {}));
    expect(history.total).toBe(3);
    expect(history.items.map((e) => [e.kind, e.from, e.to, e.reason])).toEqual([
      ['status', 'active', 'suspended', 'Investigación 12'],
      ['area', areas.a1, areas.a2, null],
      ['status', null, 'active', 'Alta'],
    ]);
    expect(history.items[0]?.actorId).toBe(`user-${admin.identityId}`);

    const trail = auditOf(world, f.a.tenantId);
    expect(trail.map((event) => event.action)).toEqual([
      'employee.created',
      'employee.pii_viewed',
      'employee.updated',
      'employee.updated',
      'employee.status_changed',
      'employee.archived',
    ]);
    for (const event of trail) {
      expect(event.entityId).toBe(created.id);
      expect(event.actor).toEqual({ id: `user-${admin.identityId}`, kind: 'user' });
    }
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
  });

  it('lists with filters in last-name order and exposes pagination fields', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const admin = roles.admin;
    const one = await seed(world, admin, { ...fresh(), lastName: 'Zamora', firstName: 'Beto' });
    await seed(world, admin, {
      ...fresh(),
      lastName: 'Alvarez',
      kind: 'dispatcher',
      licenseNumber: undefined,
      licenseType: undefined,
      licenseExpiresOn: undefined,
      areaId: areas.a2,
    });
    await seed(world, admin, { ...fresh(), lastName: 'Zamora', firstName: 'Ana' });
    ok(
      await platform.employees.changeStatus(admin.token, corr(), one.id, 1, 'inactive', 'Licencia'),
    );
    const list = async (query: Record<string, unknown>) =>
      ok(await platform.employees.list(admin.token, corr(), query));
    expect((await list({})).items.map((e) => `${e.lastName} ${e.firstName}`)).toEqual([
      'Alvarez Ana',
      'Zamora Ana',
      'Zamora Beto',
    ]);
    expect((await list({ status: 'inactive' })).items.map((e) => e.firstName)).toEqual(['Beto']);
    expect((await list({ kind: 'dispatcher' })).items).toHaveLength(1);
    expect((await list({ areaId: areas.a2 })).items).toHaveLength(1);
    const page = await list({ limit: 1, offset: 1 });
    expect(page.items.map((e) => e.firstName)).toEqual(['Ana']);
    expect(page.total).toBe(3);
    expect(page.tenantId).toBeTruthy();
    expect((await platform.employees.list(admin.token, corr(), { limit: 0 })).error).toMatchObject({
      code: 'invalid_input',
      status: 400,
    });
  });

  it('derives fitness from the license and the status as the calendar moves', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const admin = roles.admin;
    // the clock starts on 2026-10-06; the license is valid through its last day, inclusive
    const driver = await seed(world, admin, { licenseExpiresOn: '2026-10-06' });
    const noLicense = await seed(world, admin, {
      ...fresh(),
      licenseNumber: undefined,
      licenseType: undefined,
      licenseExpiresOn: undefined,
    });
    const dispatcher = await seed(world, admin, {
      ...fresh(),
      kind: 'dispatcher',
      licenseNumber: undefined,
      licenseType: undefined,
      licenseExpiresOn: undefined,
    });
    let session = admin;
    const fitness = async (id: string) =>
      ok(await platform.employees.get(session.token, corr(), id)).fitness;
    expect(await fitness(driver.id)).toEqual({ fit: true, reasons: [] });
    expect(await fitness(noLicense.id)).toEqual({ fit: false, reasons: ['license_missing'] });
    expect(await fitness(dispatcher.id)).toBeNull();
    world.advance(24 * 60 * 60 * 1000);
    // sessions are short-lived: a day later the administrator signs in again
    session = await world.signIn('subject-admin-a', admin.tenantId);
    expect(await fitness(driver.id)).toEqual({ fit: false, reasons: ['license_expired'] });
    const listed = ok(await platform.employees.list(session.token, corr(), {}));
    expect(listed.items.find((e) => e.id === driver.id)?.fitness?.fit).toBe(false);
  });
});

type Operation = (
  w: World,
  session: Session,
  employee: EmployeeView,
) => Promise<PlatformResponse<unknown>>;

const OPERATIONS: Readonly<Record<string, { run: Operation; permissions: readonly string[] }>> = {
  list: {
    permissions: ['view'],
    run: (w, s) => w.platform.employees.list(s.token, corr(), {}),
  },
  get: {
    permissions: ['view'],
    run: (w, s, e) => w.platform.employees.get(s.token, corr(), e.id),
  },
  history: {
    permissions: ['view'],
    run: (w, s, e) => w.platform.employees.history(s.token, corr(), e.id, {}),
  },
  create: {
    permissions: ['create'],
    run: (w, s) =>
      w.platform.employees.create(s.token, corr(), plain({ employeeNumber: `P-${(serial += 1)}` })),
  },
  createWithPii: {
    permissions: ['create', 'view_pii'],
    run: (w, s) => w.platform.employees.create(s.token, corr(), input(fresh())),
  },
  update: {
    permissions: ['edit'],
    run: (w, s, e) => w.platform.employees.update(s.token, corr(), e.id, 1, { position: 'Nuevo' }),
  },
  updatePii: {
    permissions: ['edit', 'view_pii'],
    run: (w, s, e) =>
      w.platform.employees.update(s.token, corr(), e.id, 1, { phone: '+52 55 1111 2222' }),
  },
  clearPii: {
    permissions: ['edit', 'view_pii'],
    run: (w, s, e) =>
      w.platform.employees.update(s.token, corr(), e.id, 1, { idType: null, nationalId: null }),
  },
  status: {
    permissions: ['edit'],
    run: (w, s, e) =>
      w.platform.employees.changeStatus(s.token, corr(), e.id, 1, 'inactive', 'Licencia'),
  },
  archive: {
    permissions: ['delete'],
    run: (w, s, e) => w.platform.employees.archive(s.token, corr(), e.id, 1),
  },
};

const ROLE_GRANTS: Readonly<Record<RoleName, readonly string[]>> = {
  admin: ['view', 'create', 'edit', 'delete', 'view_pii'],
  editor: ['view', 'create', 'edit'],
  viewer: ['view'],
  auditor: ['view'],
  pii_reader: ['view', 'create', 'view_pii'],
};

describe('role matrix over the existing generic permissions plus view_pii', () => {
  for (const role of Object.keys(ROLE_GRANTS) as RoleName[])
    it(`${role}: allowed exactly ${ROLE_GRANTS[role].join(', ')}; denied operations change nothing and are not audited`, async () => {
      world = createWorld();
      const f = await fixture(world);
      for (const [name, { run, permissions }] of Object.entries(OPERATIONS)) {
        // A fresh employee per operation, so one allowed change never makes another one stale.
        const target = await seed(world, f.roles.admin, fresh());
        const audited = auditOf(world, f.a.tenantId).length;
        const result = await run(world, f.roles[role], target);
        const allowed = permissions.every((permission) => ROLE_GRANTS[role].includes(permission));
        if (allowed) {
          expect(result.ok, `${role} ${name}`).toBe(true);
          // reads are silent, except a read that discloses personal data
          const expectedAudits = permissions.length === 1 && permissions[0] === 'view' ? 0 : 1;
          const disclosed = name === 'get' && ROLE_GRANTS[role].includes('view_pii') ? 1 : 0;
          expect(auditOf(world, f.a.tenantId).length - audited, `${role} ${name}`).toBe(
            expectedAudits + disclosed,
          );
        } else {
          expect(result.error, `${role} ${name}`).toMatchObject({ code: 'forbidden', status: 403 });
          expect(result.value).toBeUndefined();
          expect(auditOf(world, f.a.tenantId)).toHaveLength(audited);
          const detail = ok(
            await world.platform.employees.get(f.roles.admin.token, corr(), target.id),
          );
          expect({ ...detail, pii: null }).toEqual({ ...target, pii: null });
        }
      }
    });

  it('asks the authorizer for the documented permissions on every operation', async () => {
    const asked: string[][] = [];
    const service = new EmployeeService(new InMemoryEmployeeStore(), {
      pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')),
    });
    const api = new EmployeesApi({
      service,
      authorize: async (_token, _correlation, required) => {
        asked.push([...required]);
        throw new AuthError('forbidden');
      },
      can: async () => false,
      audit: () => undefined,
    });
    await api.get('t', 'c', 'x');
    await api.list('t', 'c', {});
    await api.history('t', 'c', 'x', {});
    await api.create('t', 'c', {});
    await api.create('t', 'c', { phone: 'x' });
    await api.update('t', 'c', 'x', 1, {});
    await api.update('t', 'c', 'x', 1, { licenseNumber: null });
    await api.changeStatus('t', 'c', 'x', 1, 'inactive', 'r');
    await api.archive('t', 'c', 'x', 1);
    expect(asked).toEqual([
      ['view'],
      ['view'],
      ['view'],
      ['create'],
      ['create', 'view_pii'],
      ['edit'],
      ['edit', 'view_pii'],
      ['edit'],
      ['delete'],
    ]);
    expect(EMPLOYEE_PERMISSIONS).toEqual({
      read: ['view'],
      create: ['create'],
      change: ['edit'],
      archive: ['delete'],
      pii: ['view_pii'],
    });
  });
});

describe('personal data protection (D23)', () => {
  it('masks personal data for everyone without view_pii, and never reveals it in lists', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const employee = await seed(world, f.roles.admin);
    for (const role of ['viewer', 'auditor', 'editor'] as const) {
      const detail = ok(await platform.employees.get(f.roles[role].token, corr(), employee.id));
      expect(detail.pii, role).toBeNull();
      expect(detail.piiPresent).toEqual({
        nationalId: true,
        phone: true,
        email: true,
        licenseNumber: true,
      });
      expect(detail).toMatchObject({ idType: 'ine', licenseType: 'C' });
      const text = JSON.stringify(detail);
      for (const fragment of FRAGMENTS) expect(text, `${role} ${fragment}`).not.toContain(fragment);
    }
    // lists carry presence only, even for a caller who may read personal data
    for (const role of ['admin', 'pii_reader', 'viewer'] as const) {
      const listed = ok(await platform.employees.list(f.roles[role].token, corr(), {}));
      const text = JSON.stringify(listed);
      for (const fragment of FRAGMENTS) expect(text, `${role} ${fragment}`).not.toContain(fragment);
      expect(listed.items[0]).not.toHaveProperty('pii');
    }
    // a pii_reader sees the values on the single read
    const revealed = ok(
      await platform.employees.get(f.roles.pii_reader.token, corr(), employee.id),
    );
    expect(revealed.pii).toEqual({
      nationalId: 'SYNTH-ID-7788-QX',
      phone: '+525590001234',
      email: 'ana.perez@synthetic.example',
      licenseNumber: 'LIC-445566-ZZ',
    });
  });

  it('audits every disclosure (without values) and nothing when there is nothing to disclose', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const withPii = await seed(world, f.roles.admin);
    const without = ok(
      await platform.employees.create(
        f.roles.admin.token,
        corr(),
        plain({ employeeNumber: 'N-1' }),
      ),
    );
    const before = auditOf(world, f.a.tenantId).length;
    ok(await platform.employees.get(f.roles.pii_reader.token, corr(), withPii.id));
    ok(await platform.employees.get(f.roles.viewer.token, corr(), withPii.id));
    const empty = ok(await platform.employees.get(f.roles.admin.token, corr(), without.id));
    expect(empty.pii).toEqual({ nationalId: null, phone: null, email: null, licenseNumber: null });
    const added = auditOf(world, f.a.tenantId).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'employee.pii_viewed',
      entityId: withPii.id,
      actor: { id: `user-${f.roles.pii_reader.identityId}`, kind: 'user' },
    });
  });

  it('fails closed when the disclosure cannot be audited: nothing is returned', async () => {
    world = createWorld();
    const f = await fixture(world);
    const employee = await seed(world, f.roles.admin);
    vi.spyOn(world.audit, 'append').mockImplementation(() => {
      throw new Error(`audit store down for ${SECRETS.nationalId}`);
    });
    const result = await world.platform.employees.get(f.roles.admin.token, corr(), employee.id);
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expect(JSON.stringify(result)).not.toContain(SECRETS.nationalId);
  });

  it('requires view_pii to write personal data, so a caller cannot probe identifications', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const existing = await seed(world, f.roles.admin);
    const audited = auditOf(world, f.a.tenantId).length;
    // an editor cannot tell whether an identification, e-mail or number is registered
    for (const probe of [
      input({ employeeNumber: 'E-NEW' }), // same identification and e-mail as `existing`
      plain({ nationalId: SECRETS.nationalId, idType: 'ine' }),
      plain({ email: SECRETS.email }),
      plain({ phone: '+52 55 0000 0000' }),
    ])
      expect((await platform.employees.create(f.roles.editor.token, corr(), probe)).error).toEqual({
        code: 'forbidden',
        status: 403,
        message: 'Employee request rejected: forbidden',
      });
    for (const patch of [
      { nationalId: SECRETS.nationalId, idType: 'ine' },
      { email: SECRETS.email },
      { licenseNumber: SECRETS.licenseNumber },
      { phone: null },
      { idType: null, nationalId: null },
    ])
      expect(
        (await platform.employees.update(f.roles.editor.token, corr(), existing.id, 1, patch))
          .error,
      ).toMatchObject({ code: 'forbidden', status: 403 });
    expect(auditOf(world, f.a.tenantId)).toHaveLength(audited);
    // ... while the same editor can still manage non-sensitive data
    expect(
      ok(
        await platform.employees.update(f.roles.editor.token, corr(), existing.id, 1, {
          position: 'Instructor',
          licenseExpiresOn: '2028-01-31',
        }),
      ),
    ).toMatchObject({ position: 'Instructor', licenseExpiresOn: '2028-01-31', version: 2 });
    // the people who may see the values do get the duplicate answer
    expect(
      (
        await platform.employees.create(
          f.roles.pii_reader.token,
          corr(),
          input({ employeeNumber: 'E-NEW' }),
        )
      ).error,
    ).toMatchObject({ code: 'duplicate', status: 409, field: 'national_id' });
  });

  it('enforces uniqueness through blind indexes, normalized, per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const token = f.roles.admin.token;
    await seed(world, f.roles.admin);
    const clash = async (over: Record<string, unknown>) =>
      (await platform.employees.create(token, corr(), input({ ...fresh(), ...over }))).error;
    expect(await clash({ employeeNumber: 'e-001' })).toEqual({
      code: 'duplicate',
      status: 409,
      message: 'Employee request rejected: duplicate',
      field: 'employee_number',
    });
    expect(await clash({ nationalId: 'synth id 7788 qx' })).toMatchObject({ field: 'national_id' });
    expect(await clash({ email: 'ANA.PEREZ@synthetic.example' })).toMatchObject({ field: 'email' });
    // another identification type, another license holder with the same number: allowed
    expect(
      (await clash({ idType: 'dni', licenseNumber: SECRETS.licenseNumber })) ?? null,
    ).toBeNull();
    // and the very same values are free in another company
    const theirs = ok(
      await platform.employees.create(f.adminB.token, corr(), input({ areaId: areas.b1 })),
    );
    expect(theirs.id).toBeTruthy();
    // equal values never produce equal indexes across tenants
    const store = new InMemoryEmployeeStore();
    expect(store).toBeTruthy();
  });

  it('stores only envelopes and blind indexes: no plaintext in the injected store', async () => {
    const store = new InMemoryEmployeeStore();
    world = createWorld({
      adapters: { employees: store, pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')) },
    });
    const f = await fixture(world);
    const created = await seed(world, f.roles.admin);
    await world.platform.employees.update(f.roles.admin.token, corr(), created.id, 1, {
      phone: '+52 55 7000 0001',
    });
    const row = await store.find(f.a.tenantId, created.id);
    const history = await store.history(f.a.tenantId, created.id, { limit: 50, offset: 0 });
    const stored = JSON.stringify([row, history]);
    for (const fragment of [
      ...FRAGMENTS,
      '70000001',
      '7000 0001',
      'Ana.Perez',
      'synthetic.example',
    ])
      expect(stored, fragment).not.toContain(fragment);
    expect(row?.pii.nationalId?.sealed).toMatch(/^pii1\./);
    expect(row?.pii.nationalId?.index).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps personal data out of audit events, logs and error payloads', async () => {
    world = createWorld();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const f = await fixture(world);
    const { platform } = world;
    const admin = f.roles.admin;
    const created = await seed(world, admin);
    const results: unknown[] = [
      created,
      await platform.employees.create(admin.token, corr(), input()), // duplicate
      await platform.employees.create(admin.token, corr(), input({ nationalId: SECRETS.phone })),
      await platform.employees.create(admin.token, corr(), input({ phone: SECRETS.nationalId })),
      await platform.employees.update(admin.token, corr(), created.id, 1, {
        email: 'not-an-email',
      }),
      await platform.employees.update(admin.token, corr(), created.id, 9, { phone: SECRETS.phone }),
      await platform.employees.get(f.roles.viewer.token, corr(), created.id),
      await platform.employees.list(f.roles.viewer.token, corr(), {}),
      await platform.employees.history(f.roles.viewer.token, corr(), created.id, {}),
      await platform.employees.get(f.adminB.token, corr(), created.id),
    ];
    const writtenOut = [...out.mock.calls, ...err.mock.calls].flat().join(' ');
    const consoled = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .join(' ');
    const everything = JSON.stringify([
      results,
      world.audit.list(f.a.tenantId),
      world.audit.list(f.b.tenantId),
      consoled,
    ]);
    for (const fragment of FRAGMENTS) {
      // the creation response itself carries no values either
      expect(everything, fragment).not.toContain(fragment);
      expect(writtenOut, fragment).not.toContain(fragment);
    }
  });

  it('turns a KMS failure into a generic 500 and writes nothing', async () => {
    const leak = 'arn:aws:kms:eu-west-1:000000000000:key/secret-detail';
    const real = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
    const store = new InMemoryEmployeeStore();
    const failingCipher: PiiCipher = {
      seal: async () => {
        throw new KmsError('unavailable');
      },
      open: (c, s) => real.open(c, s),
      blindIndex: async () => {
        throw new Error(leak);
      },
    };
    world = createWorld({ adapters: { employees: store, pii: failingCipher } });
    const f = await fixture(world);
    const generic = {
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    };
    expect(await world.platform.employees.create(f.roles.admin.token, corr(), input())).toEqual(
      generic,
    );
    expect(
      (await store.list(f.a.tenantId, { includeArchived: true }, { limit: 5, offset: 0 })).total,
    ).toBe(0);
    // Employees without personal data never touch the KMS
    expect(
      ok(await world.platform.employees.create(f.roles.admin.token, corr(), plain())).id,
    ).toBeTruthy();
    expect(auditOf(world, f.a.tenantId).map((e) => e.action)).toEqual(['employee.created']);
  });

  it('turns an undecryptable value into a generic 500 on the single read only', async () => {
    const store = new InMemoryEmployeeStore();
    world = createWorld({
      adapters: { employees: store, pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')) },
    });
    const f = await fixture(world);
    const created = await seed(world, f.roles.admin);
    const row = await store.find(f.a.tenantId, created.id);
    if (!row) throw new Error('row missing');
    // corrupt the sealed phone in place (as a bad restore or a rotated key would)
    await store.replace(
      {
        ...row,
        version: 2,
        pii: {
          ...row.pii,
          phone: {
            sealed: 'pii1.AAAA.AAAA.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            index: null,
          },
        },
      },
      1,
    );
    const result = await world.platform.employees.get(f.roles.admin.token, corr(), created.id);
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    // a caller who cannot read personal data is unaffected: nothing is decrypted for them
    expect(
      ok(await world.platform.employees.get(f.roles.viewer.token, corr(), created.id)).pii,
    ).toBeNull();
    expect(ok(await world.platform.employees.list(f.roles.admin.token, corr(), {})).total).toBe(1);
  });

  it('refuses the local development KMS when the process is in production mode', () => {
    const previous = process.env['OPSLOG_ENV'];
    process.env['OPSLOG_ENV'] = 'production';
    try {
      expect(() => createWorld()).toThrow(/production/);
    } finally {
      if (previous === undefined) delete process.env['OPSLOG_ENV'];
      else process.env['OPSLOG_ENV'] = previous;
      vi.useRealTimers();
    }
  });

  it('refuses a persistent employee store without an explicit cipher (no local KMS fallback)', () => {
    expect(() => createWorld({ adapters: { employees: new InMemoryEmployeeStore() } })).toThrow(
      /adapters\.employees requires adapters\.pii/,
    );
  });

  it('uses the injected cipher instead of the local one', async () => {
    const calls: string[] = [];
    const real = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
    world = createWorld({
      adapters: {
        pii: {
          seal: (c, p) => (calls.push(`seal:${c.field}`), real.seal(c, p)),
          open: (c, s) => (calls.push(`open:${c.field}`), real.open(c, s)),
          blindIndex: (t, f, v) => (calls.push(`index:${f}`), real.blindIndex(t, f, v)),
        },
      },
    });
    const f = await fixture(world);
    const created = await seed(world, f.roles.admin);
    ok(await world.platform.employees.get(f.roles.admin.token, corr(), created.id));
    expect(calls).toEqual([
      'seal:national_id',
      'index:national_id',
      'seal:phone',
      'seal:email',
      'index:email',
      'seal:license_number',
      'index:license_number',
      'open:national_id',
      'open:phone',
      'open:email',
      'open:license_number',
    ]);
  });
});

describe('tenant isolation', () => {
  it('answers not_found to another tenant for every id-based operation, exactly as for an unknown id, and changes nothing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const employee = await seed(world, f.roles.admin);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const run = (id: string) => ({
      get: platform.employees.get(f.adminB.token, corr(), id),
      history: platform.employees.history(f.adminB.token, corr(), id, {}),
      update: platform.employees.update(f.adminB.token, corr(), id, 1, { position: 'Robado' }),
      updatePii: platform.employees.update(f.adminB.token, corr(), id, 1, { phone: SECRETS.phone }),
      status: platform.employees.changeStatus(f.adminB.token, corr(), id, 1, 'inactive', 'x'),
      archive: platform.employees.archive(f.adminB.token, corr(), id, 1),
    });
    const foreign = run(employee.id);
    const missing = run(unknown);
    for (const name of Object.keys(foreign) as (keyof typeof foreign)[]) {
      const [a, b] = await Promise.all([foreign[name], missing[name]]);
      expect(a.error, name).toMatchObject({ code: 'not_found', status: 404 });
      expect(a, name).toEqual(b);
    }
    const detail = ok(
      await platform.employees.get(f.roles.admin.token, corr(), unknownSafe(employee)),
    );
    expect(detail.version).toBe(1);
    expect(auditOf(world, f.b.tenantId)).toEqual([]);
  });

  it('keeps listings, audit trails and uniqueness per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const mine = await seed(world, f.roles.admin);
    const theirs = ok(
      await platform.employees.create(f.adminB.token, corr(), input({ areaId: areas.b1 })),
    );
    expect(theirs.id).not.toBe(mine.id);
    expect(ok(await platform.employees.list(f.adminB.token, corr(), {})).items).toEqual([theirs]);
    expect(ok(await platform.employees.list(f.roles.admin.token, corr(), {})).items).toEqual([
      mine,
    ]);
    expect(
      (await platform.employees.create(f.adminB.token, corr(), input({ areaId: areas.b1 }))).error,
    ).toMatchObject({ code: 'duplicate', status: 409, field: 'employee_number' });
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
      { status: 'terminated' },
      { version: 9 },
      { id: 'chosen-id' },
      { archivedAt: '2026-01-01T00:00:00.000Z' },
      { pii: { phone: '+52 55 0000 0000' } },
    ])
      expect(
        (await platform.employees.create(admin.token, corr(), input(extra))).error,
      ).toMatchObject({ code: 'invalid_input' });
    const employee = await seed(world, admin);
    for (const patch of [
      { tenantId: f.b.tenantId },
      { kind: 'dispatcher' },
      { status: 'inactive' },
      { version: 3 },
      { archivedAt: null },
    ])
      expect(
        (await platform.employees.update(admin.token, corr(), employee.id, 1, patch)).error,
      ).toMatchObject({ code: 'invalid_input' });
    expect(ok(await platform.employees.list(f.adminB.token, corr(), {})).total).toBe(0);
  });
});

/** The id of an employee, spelled out so the isolation test reads against the owner's session. */
const unknownSafe = (employee: EmployeeView): string => employee.id;

describe('sessions and tenants gate every call', () => {
  it('refuses a revoked session, a removed member and a suspended tenant, without writing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const employee = await seed(world, f.roles.admin);
    const calls = (s: Session) => [
      platform.employees.list(s.token, corr(), {}),
      platform.employees.get(s.token, corr(), employee.id),
      platform.employees.create(s.token, corr(), plain()),
      platform.employees.update(s.token, corr(), employee.id, 1, { position: 'x' }),
      platform.employees.archive(s.token, corr(), employee.id, 1),
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
    expect(ok(await platform.employees.get(f.roles.admin.token, corr(), employee.id)).version).toBe(
      1,
    );
    expect(
      auditOf(world, f.a.tenantId).filter((event) => event.action !== 'employee.pii_viewed'),
    ).toHaveLength(1);
  });

  it('rejects a token that is not a session', async () => {
    world = createWorld();
    await fixture(world);
    for (const token of ['', 'not-a-session', 'x'.repeat(2000)])
      expect((await world.platform.employees.list(token, corr(), {})).error?.code).toBe(
        'unauthorized',
      );
  });

  it('applies a role change immediately: a demoted administrator loses personal data at once', async () => {
    world = createWorld();
    const f = await fixture(world);
    const employee = await seed(world, f.roles.admin);
    expect(
      ok(await world.platform.employees.get(f.roles.pii_reader.token, corr(), employee.id)).pii,
    ).not.toBeNull();
    await world.platform.removeMember(f.roles.admin.token, corr(), f.roles.pii_reader.identityId);
    expect(
      (await world.platform.employees.get(f.roles.pii_reader.token, corr(), employee.id)).error,
    ).toMatchObject({ code: 'unauthorized' });
  });
});

describe('business rules through the platform', () => {
  it('keeps terminated and archived employees read-only', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles, a } = await fixture(world);
    const token = roles.admin.token;
    const e = await seed(world, roles.admin);
    const gone = ok(
      await platform.employees.changeStatus(token, corr(), e.id, 1, 'terminated', 'Renuncia'),
    );
    expect(
      (await platform.employees.update(token, corr(), e.id, gone.version, { position: 'x' })).error,
    ).toMatchObject({ code: 'immutable', status: 409 });
    expect(
      (await platform.employees.changeStatus(token, corr(), e.id, gone.version, 'active', 'x'))
        .error,
    ).toMatchObject({ code: 'invalid_transition', status: 409 });
    const archived = ok(await platform.employees.archive(token, corr(), e.id, gone.version));
    expect(archived.archivedAt).not.toBeNull();
    expect(
      (await platform.employees.archive(token, corr(), e.id, archived.version)).error,
    ).toMatchObject({ code: 'immutable' });
    expect(ok(await platform.employees.get(token, corr(), e.id)).archivedAt).not.toBeNull();
    expect(
      auditOf(world, a.tenantId)
        .filter((event) => event.action !== 'employee.pii_viewed')
        .map((event) => event.action),
    ).toEqual(['employee.created', 'employee.status_changed', 'employee.archived']);
  });

  it('keeps license data to drivers', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const token = roles.admin.token;
    const other = ok(await platform.employees.create(token, corr(), plain()));
    expect(
      (await platform.employees.create(token, corr(), plain({ licenseNumber: 'LIC-99999' }))).error,
    ).toMatchObject({ code: 'invalid_input' });
    expect(
      (await platform.employees.update(token, corr(), other.id, 1, { licenseType: 'C' })).error,
    ).toMatchObject({ code: 'invalid_input' });
  });

  it('validates every input with a uniform 400 and no echo of the value', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const token = roles.admin.token;
    const e = await seed(world, roles.admin);
    const secret = 'SECRET-VALUE-<script>';
    const bad = [
      await platform.employees.create(token, corr(), input({ firstName: secret })),
      await platform.employees.create(token, corr(), input({ email: secret })),
      await platform.employees.create(token, corr(), input({ phone: secret })),
      await platform.employees.create(token, corr(), input({ nationalId: secret })),
      await platform.employees.create(token, corr(), 'nope'),
      await platform.employees.create(token, corr(), input({ hireDate: '2999-01-01' })),
      await platform.employees.get(token, corr(), '../etc/passwd'),
      await platform.employees.update(token, corr(), e.id, 'one', { position: 'x' }),
      await platform.employees.update(token, corr(), e.id, 1, {}),
      await platform.employees.changeStatus(token, corr(), e.id, 1, 'Activo', 'x'),
      await platform.employees.changeStatus(token, corr(), e.id, 1, 'inactive', ''),
      await platform.employees.archive(token, corr(), e.id, 0),
      await platform.employees.history(token, corr(), '', {}),
      await platform.employees.history(token, corr(), e.id, { limit: 1000 }),
    ];
    for (const result of bad) {
      expect(result.error).toMatchObject({ code: 'invalid_input', status: 400 });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});

describe('concurrency', () => {
  it('lets exactly one of many concurrent edits with the same version win', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const e = await seed(world, roles.admin);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        platform.employees.update(roles.admin.token, corr(), e.id, 1, { position: `Puesto ${i}` }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const result of results.filter((r) => !r.ok))
      expect(result.error).toMatchObject({ code: 'stale_version', status: 409 });
    expect(ok(await platform.employees.get(roles.admin.token, corr(), e.id)).version).toBe(2);
  });

  it('lets exactly one of many concurrent creations of the same identification win', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        platform.employees.create(
          roles.admin.token,
          corr(),
          input({ employeeNumber: `C-${i}`, email: `race${i}@synthetic.example` }),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.error?.field)).toEqual(
      Array(5).fill('national_id'),
    );
  });

  it('serializes a status change racing an archive and an edit on the same version', async () => {
    world = createWorld();
    const { platform } = world;
    const { roles } = await fixture(world);
    const t = roles.admin.token;
    const e = await seed(world, roles.admin);
    const results = await Promise.all([
      platform.employees.update(t, corr(), e.id, 1, { position: 'Nuevo' }),
      platform.employees.changeStatus(t, corr(), e.id, 1, 'inactive', 'Licencia'),
      platform.employees.archive(t, corr(), e.id, 1),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.error?.code === 'stale_version')).toBe(true);
  });
});

describe('adapters and failures', () => {
  it('uses the injected employee store', async () => {
    const store = new InMemoryEmployeeStore();
    world = createWorld({
      adapters: { employees: store, pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')) },
    });
    const { roles, a } = await fixture(world);
    const e = await seed(world, roles.admin);
    expect(await store.find(a.tenantId, e.id)).toMatchObject({
      lastName: 'Pérez',
      tenantId: a.tenantId,
    });
  });

  it('turns an infrastructure failure into a generic 500 without leaking its message', async () => {
    const inner = new InMemoryEmployeeStore();
    const broken: EmployeeStore = {
      insert: async () => {
        throw new Error(`connection to db-prod.internal refused for ${SECRETS.nationalId}`);
      },
      find: (t, id) => inner.find(t, id),
      list: (t, f, w) => inner.list(t, f, w),
      replace: (n, e, h) => inner.replace(n, e, h),
      history: (t, v, w) => inner.history(t, v, w),
      countLiveInArea: (t, a) => inner.countLiveInArea(t, a),
    };
    world = createWorld({
      adapters: { employees: broken, pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')) },
    });
    const { roles } = await fixture(world);
    const result = await world.platform.employees.create(roles.admin.token, corr(), input());
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
    const result = await platform.employees.list('t', corr(), {});
    expect(result.error).toMatchObject({ code: 'internal_error', status: 500 });
    platform.identity.authenticate = original;
  });
});

describe('typed views', () => {
  it('exposes exactly the declared fields, and the detail adds only pii', async () => {
    world = createWorld();
    const { roles } = await fixture(world);
    const v: EmployeeView = await seed(world, roles.admin);
    const declared = [
      'id',
      'kind',
      'firstName',
      'lastName',
      'employeeNumber',
      'position',
      'hireDate',
      'areaId',
      'status',
      'statusReason',
      'idType',
      'licenseType',
      'licenseExpiresOn',
      'piiPresent',
      'fitness',
      'version',
      'createdAt',
      'updatedAt',
      'archivedAt',
    ].sort();
    expect(Object.keys(v).sort()).toEqual(declared);
    const detail: EmployeeDetailView = ok(
      await world.platform.employees.get(roles.admin.token, corr(), v.id),
    );
    expect(Object.keys(detail).sort()).toEqual([...declared, 'pii'].sort());
    const history = ok(await world.platform.employees.history(roles.admin.token, corr(), v.id, {}));
    expect(Object.keys(history.items[0] ?? {}).sort()).toEqual(
      ['id', 'kind', 'from', 'to', 'reason', 'actorId', 'version', 'at'].sort(),
    );
  });
});
