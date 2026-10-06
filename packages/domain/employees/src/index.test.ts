import { describe, expect, it } from 'vitest';
import { EnvelopePiiCipher, LocalDevKms } from '../../../platform/pii/src/index.js';
import {
  EmployeeError,
  EmployeeService,
  InMemoryEmployeeStore,
  PII_FIELDS,
  STATUS_TRANSITIONS,
  applyArchive,
  applyPatch,
  applyStatus,
  canTransition,
  employeeNumberKey,
  fitnessOf,
  isEmployeeKind,
  isEmployeeStatus,
  isLiveEmployee,
  licenseNumberKey,
  nameKey,
  nationalIdKey,
  normalizeEmail,
  normalizeEmployeeNumber,
  normalizeLicenseNumber,
  normalizeNationalId,
  normalizePhone,
  normalizeReason,
  parseEmployeePatch,
  parseNewEmployee,
  requireOpaqueId,
  requireVersion,
  writesPii,
  type Employee,
  type EmployeeAreaGate,
  type EmployeeStore,
} from './index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const MASTER = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 1);
const ID_NUMBER = 'ABCD-123456-ZZ';
const PHONE = '+52 55 1234 5678';
const EMAIL = 'Ana.Perez@Example.TEST';
const LICENSE = 'lic 998877';

const cipher = () =>
  new EnvelopePiiCipher(new LocalDevKms({ masterKey: MASTER, environment: 'test' }));

const driver = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'driver',
  firstName: 'Ana',
  lastName: 'Pérez',
  areaId: 'area-1',
  employeeNumber: 'E-001',
  position: 'Conductor',
  hireDate: '2024-03-01',
  idType: 'ine',
  nationalId: ID_NUMBER,
  phone: PHONE,
  email: EMAIL,
  licenseNumber: LICENSE,
  licenseType: 'c',
  licenseExpiresOn: '2027-01-31',
  ...over,
});
const minimal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'other',
  firstName: 'Luis',
  lastName: 'Gómez',
  areaId: 'area-1',
  ...over,
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof EmployeeError ? error.code : 'other';
  }
  return undefined;
};
const rejection = async (promise: Promise<unknown>): Promise<EmployeeError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmployeeError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};

let counter = 0;
const setup = (
  options: { areas?: EmployeeAreaGate; store?: EmployeeStore; now?: () => Date } = {},
) => {
  const store = options.store ?? new InMemoryEmployeeStore();
  const svc = new EmployeeService(store, {
    pii: cipher(),
    now: options.now ?? (() => NOW),
    newId: () => `id-${(counter += 1)}`,
    ...(options.areas ? { areas: options.areas } : {}),
  });
  return { store, svc };
};

describe('vocabulary and helpers', () => {
  it('knows kinds, statuses and the transition matrix', () => {
    expect(isEmployeeKind('driver')).toBe(true);
    expect(isEmployeeKind('mechanic')).toBe(false);
    expect(isEmployeeStatus('terminated')).toBe(true);
    expect(isEmployeeStatus(3)).toBe(false);
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('active', 'active')).toBe(false);
    expect(STATUS_TRANSITIONS.terminated).toEqual([]);
    for (const [from, targets] of Object.entries(STATUS_TRANSITIONS))
      expect(targets).not.toContain(from);
  });

  it('normalizes identity-like values', () => {
    expect(normalizeEmployeeNumber(' e-001 ')).toBe('e-001');
    expect(employeeNumberKey('E-001')).toBe('e-001');
    expect(normalizeNationalId(' abcd-123456  zz ')).toBe('ABCD-123456 ZZ');
    expect(nationalIdKey('ine', 'ABCD-123456 ZZ')).toBe('ine:ABCD123456ZZ');
    expect(normalizeLicenseNumber('lic 998877')).toBe('LIC 998877');
    expect(licenseNumberKey('LIC 998.877')).toBe('LIC998877');
    expect(normalizePhone('+52 (55) 1234-5678')).toBe('+525512345678');
    expect(normalizeEmail(' Ana.Perez@Example.TEST ')).toBe('ana.perez@example.test');
    expect(nameKey('Ana', 'Pérez')).toBe('pérez ana');
    expect(requireOpaqueId('abc-1')).toBe('abc-1');
    expect(requireVersion(3)).toBe(3);
    expect(normalizeReason('  motivo ')).toBe('motivo');
  });

  it('rejects malformed values', () => {
    for (const bad of ['', ' ', '-x', 'a'.repeat(40), 3, null, 'a b'])
      expect(code(() => normalizeEmployeeNumber(bad))).toBe('invalid_input');
    for (const bad of ['', 'abc', '!!!!', 'a'.repeat(40), 7])
      expect(code(() => normalizeNationalId(bad))).toBe('invalid_input');
    for (const bad of ['', 'abc', 'x'.repeat(40), null])
      expect(code(() => normalizeLicenseNumber(bad))).toBe('invalid_input');
    for (const bad of ['5512345678', '+0123456789', '+12345', '+1234567890123456', 'tel', null])
      expect(code(() => normalizePhone(bad))).toBe('invalid_input');
    for (const bad of [
      'a@b',
      'no-at.example.test',
      '@example.test',
      `${'a'.repeat(250)}@example.test`,
      3,
    ])
      expect(code(() => normalizeEmail(bad))).toBe('invalid_input');
    for (const bad of ['', '  ', 'x'.repeat(201), 'two\nlines', 4])
      expect(code(() => normalizeReason(bad))).toBe('invalid_input');
    for (const bad of ['', 'a b', '-a', 5, null])
      expect(code(() => requireOpaqueId(bad))).toBe('invalid_input');
    for (const bad of [0, 1.5, '1', -1, 2_147_483_647])
      expect(code(() => requireVersion(bad))).toBe('invalid_input');
  });

  it('classifies live employees (BR-021 semantics)', () => {
    expect(isLiveEmployee({ status: 'active', archivedAt: null })).toBe(true);
    expect(isLiveEmployee({ status: 'inactive', archivedAt: null })).toBe(true);
    expect(isLiveEmployee({ status: 'suspended', archivedAt: null })).toBe(true);
    expect(isLiveEmployee({ status: 'terminated', archivedAt: null })).toBe(false);
    expect(isLiveEmployee({ status: 'active', archivedAt: NOW.toISOString() })).toBe(false);
  });

  it('detects input that writes personal data', () => {
    for (const key of ['nationalId', 'idType', 'phone', 'email', 'licenseNumber'])
      expect(writesPii({ [key]: null })).toBe(true);
    expect(writesPii({ firstName: 'Ana', licenseType: 'C', licenseExpiresOn: '2027-01-01' })).toBe(
      false,
    );
    expect(writesPii(null)).toBe(false);
    expect(writesPii([])).toBe(false);
    expect(writesPii('phone')).toBe(false);
    expect(PII_FIELDS).toEqual(['nationalId', 'phone', 'email', 'licenseNumber']);
  });
});

describe('parseNewEmployee', () => {
  it('normalizes a full driver', () => {
    const data = parseNewEmployee(
      driver({ firstName: '  María   José ', licenseType: ' c ' }),
      NOW,
    );
    expect(data.kind).toBe('driver');
    expect(data.core).toMatchObject({
      firstName: 'María José',
      lastName: 'Pérez',
      employeeNumber: 'E-001',
      position: 'Conductor',
      hireDate: '2024-03-01',
      areaId: 'area-1',
      licenseType: 'C',
      licenseExpiresOn: '2027-01-31',
    });
    expect(data.pii).toEqual({
      nationalId: { idType: 'ine', value: 'ABCD-123456-ZZ' },
      phone: '+525512345678',
      email: 'ana.perez@example.test',
      licenseNumber: 'LIC 998877',
    });
  });

  it('accepts the minimum and treats explicit nulls as absent', () => {
    const data = parseNewEmployee(
      minimal({
        employeeNumber: null,
        position: null,
        hireDate: null,
        phone: null,
        email: null,
        idType: null,
        nationalId: null,
      }),
      NOW,
    );
    expect(data.core).toMatchObject({
      employeeNumber: null,
      position: null,
      hireDate: null,
      licenseType: null,
    });
    expect(data.pii).toEqual({});
  });

  it('rejects unknown, missing and malformed fields', () => {
    for (const bad of [
      null,
      [],
      'x',
      minimal({ tenantId: 'tenant-b' }),
      minimal({ id: 'x' }),
      minimal({ status: 'active' }),
      minimal({ kind: 'mechanic' }),
      minimal({ kind: undefined }),
      minimal({ firstName: '' }),
      minimal({ firstName: 'R2-D2' }),
      minimal({ lastName: 'x'.repeat(61) }),
      minimal({ areaId: '../x' }),
      minimal({ position: 'a\nb' }),
      minimal({ hireDate: '2026-10-07' }),
      minimal({ hireDate: '2026-02-30' }),
      minimal({ hireDate: '1900-01-01' }),
      minimal({ hireDate: '2026-1-1' }),
      minimal({ idType: 'ine' }),
      minimal({ nationalId: ID_NUMBER }),
      minimal({ idType: null, nationalId: ID_NUMBER }),
      minimal({ idType: 'INE!', nationalId: ID_NUMBER }),
      minimal({ phone: '123' }),
      minimal({ email: 'x' }),
      // license data belongs to drivers only
      minimal({ licenseNumber: LICENSE }),
      minimal({ licenseType: 'C' }),
      minimal({ licenseExpiresOn: '2027-01-01' }),
      driver({ licenseExpiresOn: '2101-01-01' }),
      driver({ licenseExpiresOn: 'soon' }),
      driver({ licenseType: '!!' }),
    ])
      expect(
        code(() => parseNewEmployee(bad, NOW)),
        JSON.stringify(bad),
      ).toBe('invalid_input');
  });

  it('allows a driver without license data and an expired license', () => {
    expect(
      parseNewEmployee(
        driver({ licenseNumber: null, licenseType: null, licenseExpiresOn: null }),
        NOW,
      ).pii,
    ).not.toHaveProperty('licenseNumber');
    expect(
      parseNewEmployee(driver({ licenseExpiresOn: '2020-01-01' }), NOW).core.licenseExpiresOn,
    ).toBe('2020-01-01');
  });
});

describe('parseEmployeePatch', () => {
  it('returns only present fields and lets null clear optional ones', () => {
    const patch = parseEmployeePatch(
      {
        firstName: 'Ana María',
        lastName: 'López',
        areaId: 'area-2',
        employeeNumber: null,
        position: null,
        hireDate: null,
        licenseType: null,
        licenseExpiresOn: '2030-01-01',
        phone: null,
        email: 'b@example.test',
        licenseNumber: null,
        idType: 'dni',
        nationalId: 'dni 4455-66',
      },
      NOW,
    );
    expect(patch.core).toEqual({
      firstName: 'Ana María',
      lastName: 'López',
      areaId: 'area-2',
      employeeNumber: null,
      position: null,
      hireDate: null,
      licenseType: null,
      licenseExpiresOn: '2030-01-01',
    });
    expect(patch.pii).toEqual({
      nationalId: { idType: 'dni', value: 'DNI 4455-66' },
      phone: null,
      email: 'b@example.test',
      licenseNumber: null,
    });
    expect(parseEmployeePatch({ idType: null, nationalId: null }, NOW).pii).toEqual({
      nationalId: null,
    });
    expect(parseEmployeePatch({ position: 'Jefe' }, NOW)).toEqual({
      core: { position: 'Jefe' },
      pii: {},
    });
  });

  it('rejects empty, unknown and unpaired input', () => {
    for (const bad of [
      {},
      null,
      [],
      { kind: 'driver' },
      { tenantId: 'x' },
      { version: 1 },
      { firstName: null },
      { areaId: null },
      { idType: 'ine' },
      { nationalId: ID_NUMBER },
      { idType: null, nationalId: ID_NUMBER },
      { idType: 'ine', nationalId: null },
      { phone: 'x' },
      { hireDate: '2027-01-01' },
    ])
      expect(
        code(() => parseEmployeePatch(bad, NOW)),
        JSON.stringify(bad),
      ).toBe('invalid_input');
  });
});

describe('fitness to operate', () => {
  const base = {
    kind: 'driver',
    status: 'active',
    archivedAt: null,
    licenseType: 'C',
    licenseExpiresOn: '2026-10-06',
    pii: { nationalId: null, phone: null, email: null, licenseNumber: { sealed: 's', index: 'i' } },
  } as const;

  it('is fit while the license is valid through its last day (inclusive)', () => {
    expect(fitnessOf(base, '2026-10-06')).toEqual({ fit: true, reasons: [] });
    expect(fitnessOf(base, '2026-10-07')).toEqual({ fit: false, reasons: ['license_expired'] });
  });

  it('collects every reason', () => {
    expect(fitnessOf({ ...base, status: 'suspended' }, '2026-10-06')?.reasons).toEqual([
      'not_active',
    ]);
    expect(
      fitnessOf({ ...base, archivedAt: NOW.toISOString(), status: 'terminated' }, '2026-10-06')
        ?.reasons,
    ).toEqual(['archived', 'not_active']);
    expect(fitnessOf({ ...base, licenseExpiresOn: null }, '2026-10-06')?.reasons).toEqual([
      'license_missing',
    ]);
    expect(fitnessOf({ ...base, licenseType: null }, '2026-10-06')?.reasons).toEqual([
      'license_missing',
    ]);
    expect(
      fitnessOf({ ...base, pii: { ...base.pii, licenseNumber: null } }, '2026-10-06')?.reasons,
    ).toEqual(['license_missing']);
  });

  it('does not apply to dispatchers or other staff', () => {
    expect(fitnessOf({ ...base, kind: 'dispatcher' }, '2026-10-06')).toBeNull();
    expect(fitnessOf({ ...base, kind: 'other' }, '2026-10-06')).toBeNull();
  });
});

describe('pure state changes', () => {
  const employee = async (): Promise<Employee> => await setup().svc.create(A, ACTOR, driver());

  it('applies patches, statuses and archive with versions', async () => {
    const e = await employee();
    const patched = applyPatch(e, { position: 'Jefe' }, {}, undefined, 1, NOW);
    expect(patched).toMatchObject({ position: 'Jefe', version: 2 });
    expect(patched.pii).toEqual(e.pii);
    expect(() => applyPatch(e, {}, {}, undefined, 2, NOW)).toThrow(EmployeeError);
    const cleared = applyPatch(e, {}, { nationalId: null }, null, 1, NOW);
    expect(cleared).toMatchObject({ idType: null });
    expect(cleared.pii.nationalId).toBeNull();
    const suspended = applyStatus(e, 'suspended', 'Investigación', 1, NOW);
    expect(suspended).toMatchObject({
      status: 'suspended',
      statusReason: 'Investigación',
      version: 2,
    });
    expect(code(() => applyStatus(e, 'active', 'x', 1, NOW))).toBe('invalid_transition');
    expect(code(() => applyStatus(e, 'inactive', 'x', 9, NOW))).toBe('stale_version');
    const terminated = applyStatus(e, 'terminated', 'Renuncia', 1, NOW);
    expect(code(() => applyPatch(terminated, {}, {}, undefined, 2, NOW))).toBe('immutable');
    expect(code(() => applyStatus(terminated, 'active', 'x', 2, NOW))).toBe('invalid_transition');
    const archived = applyArchive(terminated, 2, NOW);
    expect(archived.archivedAt).toBe(NOW.toISOString());
    expect(code(() => applyArchive(archived, 3, NOW))).toBe('immutable');
    expect(code(() => applyStatus(archived, 'active', 'x', 3, NOW))).toBe('immutable');
    expect(code(() => applyArchive(e, 5, NOW))).toBe('stale_version');
  });
});

describe('EmployeeService', () => {
  it('creates an active employee with sealed PII and an initial history entry', async () => {
    const { svc } = setup();
    const e = await svc.create(A, ACTOR, driver());
    expect(e).toMatchObject({
      tenantId: A,
      kind: 'driver',
      status: 'active',
      statusReason: 'Alta',
      version: 1,
      archivedAt: null,
      idType: 'ine',
      licenseType: 'C',
    });
    const serialized = JSON.stringify(e);
    for (const secret of [ID_NUMBER, '5512345678', 'ana.perez', 'LIC 998877', 'LIC998877'])
      expect(serialized.toLowerCase()).not.toContain(secret.toLowerCase());
    for (const field of ['nationalId', 'email', 'licenseNumber'] as const) {
      expect(e.pii[field]?.sealed).toMatch(/^pii1\./);
      expect(e.pii[field]?.index).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(e.pii.phone?.index).toBeNull();
    const history = await svc.history(A, e.id);
    expect(history.items).toEqual([
      expect.objectContaining({
        kind: 'status',
        from: null,
        to: 'active',
        reason: 'Alta',
        version: 1,
        actorId: ACTOR,
      }),
    ]);
  });

  it('reveals the PII it sealed and nothing else', async () => {
    const { svc } = setup();
    const e = await svc.create(A, ACTOR, driver());
    expect(await svc.reveal(e)).toEqual({
      nationalId: 'ABCD-123456-ZZ',
      phone: '+525512345678',
      email: 'ana.perez@example.test',
      licenseNumber: 'LIC 998877',
    });
    const bare = await svc.create(A, ACTOR, minimal());
    expect(await svc.reveal(bare)).toEqual({
      nationalId: null,
      phone: null,
      email: null,
      licenseNumber: null,
    });
  });

  it('ties each ciphertext to its own row: a swapped envelope does not open', async () => {
    const { svc } = setup();
    const one = await svc.create(
      A,
      ACTOR,
      driver({
        employeeNumber: 'E-1',
        nationalId: 'AAAA-1111',
        email: 'a@example.test',
        licenseNumber: 'LLL-111',
      }),
    );
    const two = await svc.create(
      A,
      ACTOR,
      driver({
        employeeNumber: 'E-2',
        nationalId: 'BBBB-2222',
        email: 'b@example.test',
        licenseNumber: 'LLL-222',
      }),
    );
    const swapped: Employee = { ...two, pii: one.pii };
    await expect(svc.reveal(swapped)).rejects.toMatchObject({ name: 'PiiError' });
    const crossField: Employee = { ...one, pii: { ...one.pii, phone: one.pii.email } };
    await expect(svc.reveal(crossField)).rejects.toMatchObject({ name: 'PiiError' });
  });

  it('gives equal identifications the same blind index within a tenant and different ones across tenants', async () => {
    const { svc } = setup();
    const a1 = await svc.create(
      A,
      ACTOR,
      driver({ employeeNumber: 'E-1', email: 'a@example.test' }),
    );
    const b1 = await svc.create(
      B,
      ACTOR,
      driver({ employeeNumber: 'E-1', email: 'a@example.test' }),
    );
    expect(b1.pii.nationalId?.index).not.toBe(a1.pii.nationalId?.index);
    expect(b1.pii.email?.index).not.toBe(a1.pii.email?.index);
  });

  it('enforces uniqueness per tenant of employee number, identification and e-mail', async () => {
    const { svc } = setup();
    await svc.create(A, ACTOR, driver());
    const dup = (over: Record<string, unknown>) => rejection(svc.create(A, ACTOR, driver(over)));
    expect(await dup({})).toMatchObject({ code: 'duplicate', field: 'employee_number' });
    expect(await dup({ employeeNumber: 'e-001' })).toMatchObject({ field: 'employee_number' });
    const base = { employeeNumber: 'E-9', email: 'other@example.test', licenseNumber: 'ZZZ-999' };
    expect(await dup({ ...base, nationalId: 'abcd 123456 zz' })).toMatchObject({
      field: 'national_id',
    });
    expect(
      await dup({ ...base, email: 'ANA.PEREZ@example.test', nationalId: 'NEW-ID-1' }),
    ).toMatchObject({ field: 'email' });
    // the same number under another identification type is another identification
    const other = await svc.create(A, ACTOR, driver({ ...base, idType: 'dni' }));
    expect(other.id).toBeTruthy();
    // a license number may repeat: it is indexed, not unique
    const sameLicense = await svc.create(
      A,
      ACTOR,
      driver({
        employeeNumber: 'E-10',
        email: 'c@example.test',
        nationalId: 'NEW-ID-2',
        licenseNumber: LICENSE,
      }),
    );
    expect(sameLicense.pii.licenseNumber?.index).toBeTruthy();
    // and none of it collides across tenants
    expect((await svc.create(B, ACTOR, driver())).tenantId).toBe(B);
  });

  it('reads only inside the tenant (404 for other tenants and unknown ids alike)', async () => {
    const { svc } = setup();
    const e = await svc.create(A, ACTOR, driver());
    expect((await svc.get(A, e.id)).id).toBe(e.id);
    expect(await rejection(svc.get(B, e.id))).toMatchObject({ code: 'not_found' });
    expect(await rejection(svc.get(A, 'nope'))).toMatchObject({ code: 'not_found' });
    expect(await rejection(svc.get(A, '../x'))).toMatchObject({ code: 'invalid_input' });
    expect(await rejection(svc.history(B, e.id))).toMatchObject({ code: 'not_found' });
    expect(await rejection(svc.update(B, ACTOR, e.id, 1, { position: 'x' }))).toMatchObject({
      code: 'not_found',
    });
    expect(await rejection(svc.changeStatus(B, ACTOR, e.id, 1, 'inactive', 'x'))).toMatchObject({
      code: 'not_found',
    });
    expect(await rejection(svc.archive(B, e.id, 1))).toMatchObject({ code: 'not_found' });
    expect(await svc.list(B)).toEqual({ items: [], total: 0 });
    expect(await rejection(svc.create('bad tenant', ACTOR, driver()))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.create(A, 'bad actor', driver()))).toMatchObject({
      code: 'invalid_input',
    });
  });

  it('lists in name order with filters, windows and archived hidden by default', async () => {
    const { svc } = setup();
    const ana = await svc.create(
      A,
      ACTOR,
      minimal({ firstName: 'Ana', lastName: 'Zamora', areaId: 'a-1', kind: 'driver' }),
    );
    await svc.create(A, ACTOR, minimal({ firstName: 'Beto', lastName: 'Alvarez', areaId: 'a-2' }));
    const carla = await svc.create(
      A,
      ACTOR,
      minimal({ firstName: 'Carla', lastName: 'Zamora', areaId: 'a-1', kind: 'dispatcher' }),
    );
    const inactive = await svc.changeStatus(A, ACTOR, carla.id, 1, 'inactive', 'Licencia médica');
    await svc.archive(
      A,
      (await svc.create(A, ACTOR, minimal({ firstName: 'Dora', lastName: 'Archivada' }))).id,
      1,
    );
    const names = async (query = {}) =>
      (await svc.list(A, query)).items.map((item) => item.firstName);
    expect(await names()).toEqual(['Beto', 'Ana', 'Carla']);
    expect(await names({ includeArchived: true })).toEqual(['Beto', 'Dora', 'Ana', 'Carla']);
    expect(await names({ kind: 'driver' })).toEqual(['Ana']);
    expect(await names({ status: 'inactive' })).toEqual(['Carla']);
    expect(await names({ areaId: 'a-1' })).toEqual(['Ana', 'Carla']);
    expect(await names({ limit: 1, offset: 1 })).toEqual(['Ana']);
    expect((await svc.list(A, { limit: 1 })).total).toBe(3);
    expect(ana.version).toBe(1);
    expect(inactive.version).toBe(2);
    for (const bad of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { offset: -1 },
      { kind: 'mechanic' },
      { status: 'gone' },
      { includeArchived: 'yes' },
      { areaId: '../x' },
    ])
      expect(await rejection(svc.list(A, bad)), JSON.stringify(bad)).toMatchObject({
        code: 'invalid_input',
      });
  });

  it('updates fields, bumps the version and re-seals changed PII only', async () => {
    const { svc } = setup();
    const e = await svc.create(A, ACTOR, driver());
    const next = await svc.update(A, ACTOR, e.id, 1, {
      position: 'Jefe de flota',
      phone: '+52 55 0000 1111',
      licenseNumber: null,
    });
    expect(next).toMatchObject({ version: 2, position: 'Jefe de flota' });
    expect(next.pii.licenseNumber).toBeNull();
    expect(next.pii.nationalId).toEqual(e.pii.nationalId);
    expect((await svc.reveal(next)).phone).toBe('+525500001111');
    expect(next.pii.phone?.sealed).not.toBe(e.pii.phone?.sealed);
    const retyped = await svc.update(A, ACTOR, e.id, 2, { idType: 'dni', nationalId: 'xx-12345' });
    expect(retyped.idType).toBe('dni');
    expect((await svc.reveal(retyped)).nationalId).toBe('XX-12345');
    const cleared = await svc.update(A, ACTOR, e.id, 3, { idType: null, nationalId: null });
    expect(cleared).toMatchObject({ idType: null });
    expect(cleared.pii.nationalId).toBeNull();
  });

  it('rejects updates with a stale version, without calling the KMS', async () => {
    const calls: string[] = [];
    const real = cipher();
    const spying = new EmployeeService(new InMemoryEmployeeStore(), {
      pii: {
        seal: (...args) => (calls.push('seal'), real.seal(...args)),
        open: (...args) => real.open(...args),
        blindIndex: (...args) => (calls.push('index'), real.blindIndex(...args)),
      },
      now: () => NOW,
      newId: () => `id-${(counter += 1)}`,
    });
    const e = await spying.create(A, ACTOR, driver());
    calls.length = 0;
    expect(
      await rejection(spying.update(A, ACTOR, e.id, 7, { phone: '+52 55 0000 1111' })),
    ).toMatchObject({ code: 'stale_version' });
    expect(calls).toEqual([]);
  });

  it('reports a lost race at commit time as stale_version', async () => {
    const store = new InMemoryEmployeeStore();
    const { svc } = setup({ store });
    const e = await svc.create(A, ACTOR, driver());
    const original = store.replace.bind(store);
    store.replace = async (...args) => {
      await original({ ...e, version: 2 }, 1); // a competing writer commits first
      return original(...args);
    };
    expect(await rejection(svc.update(A, ACTOR, e.id, 1, { position: 'x' }))).toMatchObject({
      code: 'stale_version',
    });
  });

  it('reports a vanished row as not_found', async () => {
    const real = new InMemoryEmployeeStore();
    const { svc } = setup({ store: real });
    const e = await svc.create(A, ACTOR, driver());
    const loaded = await real.find(A, e.id);
    let reads = 0;
    const vanishing: EmployeeStore = {
      insert: (...a) => real.insert(...a),
      // the first read finds the row; by the time the write fails it is gone
      find: async () => ((reads += 1) === 1 ? loaded : null),
      list: (...a) => real.list(...a),
      replace: async () => false,
      history: (...a) => real.history(...a),
      countLiveInArea: (...a) => real.countLiveInArea(...a),
    };
    const other = new EmployeeService(vanishing, { pii: cipher() });
    expect(await rejection(other.archive(A, e.id, 1))).toMatchObject({ code: 'not_found' });
  });

  it('refuses license data for non-drivers and unknown fields', async () => {
    const { svc } = setup();
    const e = await svc.create(A, ACTOR, minimal());
    for (const bad of [
      { licenseType: 'C' },
      { licenseExpiresOn: null },
      { licenseNumber: 'LIC-1111' },
    ])
      expect(await rejection(svc.update(A, ACTOR, e.id, 1, bad))).toMatchObject({
        code: 'invalid_input',
      });
    expect(await rejection(svc.update(A, ACTOR, e.id, 1, { kind: 'driver' }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.update(A, ACTOR, e.id, 1, { tenantId: B }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.update(A, ACTOR, e.id, 0, { position: 'x' }))).toMatchObject({
      code: 'invalid_input',
    });
  });

  it('changes status with a reason and keeps the history newest first', async () => {
    const { svc } = setup();
    const e = await svc.create(A, ACTOR, minimal());
    const suspended = await svc.changeStatus(A, ACTOR, e.id, 1, 'suspended', ' Revisión ');
    expect(suspended).toMatchObject({ status: 'suspended', statusReason: 'Revisión', version: 2 });
    await svc.changeStatus(A, ACTOR, e.id, 2, 'active', 'Cerrada');
    const history = await svc.history(A, e.id);
    expect(history.total).toBe(3);
    expect(history.items.map((entry) => [entry.from, entry.to, entry.version])).toEqual([
      ['suspended', 'active', 3],
      ['active', 'suspended', 2],
      [null, 'active', 1],
    ]);
    expect((await svc.history(A, e.id, { limit: 1, offset: 1 })).items[0]?.version).toBe(2);
    expect(await rejection(svc.history(A, e.id, { limit: 0 }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.history(A, e.id, { offset: -1 }))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, e.id, 3, 'active', 'x'))).toMatchObject({
      code: 'invalid_transition',
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, e.id, 3, 'gone', 'x'))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, e.id, 3, 'inactive', ' '))).toMatchObject({
      code: 'invalid_input',
    });
    expect(await rejection(svc.changeStatus(A, ACTOR, e.id, 1, 'inactive', 'x'))).toMatchObject({
      code: 'stale_version',
    });
    expect(
      await rejection(svc.changeStatus(A, 'bad actor', e.id, 3, 'inactive', 'x')),
    ).toMatchObject({ code: 'invalid_input' });
  });

  it('terminated and archived employees are read-only; archive is a soft delete (BR-009)', async () => {
    const { svc } = setup();
    const e = await svc.create(A, ACTOR, driver());
    const terminated = await svc.changeStatus(A, ACTOR, e.id, 1, 'terminated', 'Renuncia');
    expect(await rejection(svc.update(A, ACTOR, e.id, 2, { position: 'x' }))).toMatchObject({
      code: 'immutable',
    });
    const archived = await svc.archive(A, e.id, terminated.version);
    expect(archived.archivedAt).toBe(NOW.toISOString());
    expect(await rejection(svc.archive(A, e.id, 3))).toMatchObject({ code: 'immutable' });
    expect((await svc.get(A, e.id)).id).toBe(e.id); // still readable, never deleted
    expect((await svc.list(A, { includeArchived: true })).total).toBe(1);
    expect((await svc.list(A)).total).toBe(0);
    expect((await svc.history(A, e.id)).total).toBe(2);
  });

  it('derives fitness from the clock of the service', async () => {
    let now = NOW;
    const { svc } = setup({ now: () => now });
    const e = await svc.create(A, ACTOR, driver({ licenseExpiresOn: '2026-10-06' }));
    expect(svc.fitness(e)).toEqual({ fit: true, reasons: [] });
    now = new Date('2026-10-07T00:00:00.000Z');
    expect(svc.fitness(e)).toEqual({ fit: false, reasons: ['license_expired'] });
  });

  it('counts live employees per area and tenant (BR-021 port)', async () => {
    const { svc, store } = setup();
    const a = await svc.create(A, ACTOR, minimal({ areaId: 'a-1' }));
    const b = await svc.create(A, ACTOR, minimal({ firstName: 'B', areaId: 'a-1' }));
    const c = await svc.create(A, ACTOR, minimal({ firstName: 'C', areaId: 'a-1' }));
    const d = await svc.create(A, ACTOR, minimal({ firstName: 'D', areaId: 'a-1' }));
    await svc.create(A, ACTOR, minimal({ firstName: 'E', areaId: 'a-2' }));
    await svc.create(B, ACTOR, minimal({ firstName: 'F', areaId: 'a-1' }));
    expect(await store.countLiveInArea(A, 'a-1')).toBe(4);
    await svc.changeStatus(A, ACTOR, a.id, 1, 'inactive', 'x'); // still counts
    await svc.changeStatus(A, ACTOR, b.id, 1, 'suspended', 'x'); // still counts
    expect(await store.countLiveInArea(A, 'a-1')).toBe(4);
    await svc.changeStatus(A, ACTOR, c.id, 1, 'terminated', 'x');
    expect(await store.countLiveInArea(A, 'a-1')).toBe(3);
    await svc.archive(A, d.id, 1);
    expect(await store.countLiveInArea(A, 'a-1')).toBe(2);
    expect(await store.countLiveInArea(A, 'a-2')).toBe(1);
    expect(await store.countLiveInArea(B, 'a-1')).toBe(1);
    expect(await store.countLiveInArea('tenant-c', 'a-1')).toBe(0);
  });
});

describe('area membership', () => {
  const gate = (active: Set<string>, log: string[] = []): EmployeeAreaGate => ({
    withActiveArea: async (tenantId, areaId, work) => {
      log.push(`${tenantId}:${areaId}`);
      if (!active.has(`${tenantId}:${areaId}`)) throw new EmployeeError('invalid_area', 'area_id');
      return work();
    },
  });

  it('validates a new employee area under the gate and never writes on failure', async () => {
    const log: string[] = [];
    const { svc, store } = setup({ areas: gate(new Set([`${A}:area-1`]), log) });
    expect((await svc.create(A, ACTOR, minimal({ areaId: 'area-1' }))).areaId).toBe('area-1');
    for (const areaId of ['area-9', 'area-1']) {
      // area-1 exists for A, but not for B: the same answer as an unknown id
      const tenant = areaId === 'area-1' ? B : A;
      expect(await rejection(svc.create(tenant, ACTOR, minimal({ areaId })))).toMatchObject({
        code: 'invalid_area',
        field: 'area_id',
      });
    }
    expect((await store.list(A, { includeArchived: true }, { limit: 10, offset: 0 })).total).toBe(
      1,
    );
    expect((await store.list(B, { includeArchived: true }, { limit: 10, offset: 0 })).total).toBe(
      0,
    );
    expect(log).toEqual([`${A}:area-1`, `${A}:area-9`, `${B}:area-1`]);
  });

  it('checks only a changed area, records the move and keeps an unchanged one even if inactive', async () => {
    const active = new Set([`${A}:area-1`, `${A}:area-2`]);
    const log: string[] = [];
    const { svc } = setup({ areas: gate(active, log) });
    const e = await svc.create(A, ACTOR, minimal({ areaId: 'area-1' }));
    active.delete(`${A}:area-1`); // deactivated since
    log.length = 0;
    const renamed = await svc.update(A, ACTOR, e.id, 1, { firstName: 'Luisa', areaId: 'area-1' });
    expect(renamed.areaId).toBe('area-1');
    expect(log).toEqual([]);
    const moved = await svc.update(A, ACTOR, e.id, 2, { areaId: 'area-2' });
    expect(moved).toMatchObject({ areaId: 'area-2', version: 3 });
    expect(log).toEqual([`${A}:area-2`]);
    const history = await svc.history(A, e.id);
    expect(history.items[0]).toMatchObject({
      kind: 'area',
      from: 'area-1',
      to: 'area-2',
      reason: null,
      actorId: ACTOR,
      version: 3,
    });
    expect(await rejection(svc.update(A, ACTOR, e.id, 3, { areaId: 'area-1' }))).toMatchObject({
      code: 'invalid_area',
    });
    expect((await svc.get(A, e.id)).areaId).toBe('area-2');
  });

  it('does not take the gate for status changes or archiving', async () => {
    const log: string[] = [];
    const { svc } = setup({ areas: gate(new Set([`${A}:area-1`]), log) });
    const e = await svc.create(A, ACTOR, minimal({ areaId: 'area-1' }));
    log.length = 0;
    await svc.changeStatus(A, ACTOR, e.id, 1, 'inactive', 'x');
    await svc.archive(A, e.id, 2);
    expect(log).toEqual([]);
  });

  it('propagates errors of the work unchanged (duplicate under the gate)', async () => {
    const { svc } = setup({ areas: gate(new Set([`${A}:area-1`])) });
    await svc.create(A, ACTOR, minimal({ areaId: 'area-1', employeeNumber: 'N-1' }));
    expect(
      await rejection(svc.create(A, ACTOR, minimal({ areaId: 'area-1', employeeNumber: 'n-1' }))),
    ).toMatchObject({ code: 'duplicate', field: 'employee_number' });
  });
});

describe('InMemoryEmployeeStore', () => {
  it('rejects a duplicate id and returns copies', async () => {
    const { svc, store } = setup();
    const e = await svc.create(A, ACTOR, minimal());
    const entry = (await store.history(A, e.id, { limit: 5, offset: 0 })).items[0];
    if (!entry) throw new Error('no history');
    expect(await rejection(store.insert(e, entry))).toMatchObject({ code: 'duplicate' });
    const copy = await store.find(A, e.id);
    expect(copy).toEqual(e);
    expect(copy).not.toBe(e);
    expect(await store.find(B, e.id)).toBeNull();
    expect(await store.replace({ ...e, version: 2 }, 5)).toBe(false);
    expect(await store.replace({ ...e, tenantId: B, id: 'ghost', version: 2 }, 1)).toBe(false);
  });
});
