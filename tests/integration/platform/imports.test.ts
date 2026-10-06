import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EnvelopePiiCipher,
  IMPORT_PERMISSIONS,
  ImportsApi,
  InMemoryEmployeeStore,
  LocalDevKms,
  type PlatformResponse,
} from '../../../apps/api/composition/src/index.js';
import {
  employeeImportTarget,
  vehicleImportTarget,
} from '../../../apps/api/composition/src/import-targets.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import { EmployeeError } from '../../../packages/domain/employees/src/index.js';
import { ImportError, type ImportService } from '../../../packages/domain/imports/src/index.js';
import { VehicleError } from '../../../packages/domain/vehicles/src/index.js';
import { corr, createWorld, type World } from './world.js';

let world: World;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const NOW = new Date('2026-10-06T12:00:00.000Z');
const PII_FRAGMENTS = [
  'SYNTH-ID-7788',
  'ana.letra',
  'synthetic.example',
  'LIC-445566',
  '9000 1234',
];

describe('imports through the platform', () => {
  it('seals imported personal data, audits ids only and keeps it out of every result and error', async () => {
    const store = new InMemoryEmployeeStore();
    world = createWorld({
      adapters: { employees: store, pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('imports')) },
    });
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const area = ok(await world.platform.areas.create(a.admin.token, corr(), { name: 'Flota' })).id;
    const rows = [
      {
        kind: 'driver',
        firstName: 'Ana',
        lastName: 'Letra',
        areaId: area,
        employeeNumber: 'EMP-1',
        idType: 'ine',
        nationalId: 'SYNTH-ID-7788-QX',
        phone: '+52 55 9000 1234',
        email: 'ana.letra@synthetic.example',
        licenseNumber: 'LIC-445566-ZZ',
        licenseType: 'c',
        licenseExpiresOn: '2099-01-31',
      },
    ];
    const done = ok(
      await world.platform.imports.submit(a.admin.token, corr(), {
        entity: 'employee',
        mode: 'commit_all',
        idempotencyKey: 'platform-import-1',
        rows,
      }),
    );
    expect(done.job).toMatchObject({ status: 'imported', importedRows: 1 });
    const report = ok(await world.platform.imports.rows(a.admin.token, corr(), done.job.id, {}));
    const id = report.items[0]?.entityId as string;
    const stored = await store.find(a.tenantId, id);
    expect(stored).not.toBeNull();
    // Sealed at rest: ciphertext and blind indexes only.
    const raw = JSON.stringify(stored);
    for (const fragment of PII_FRAGMENTS) expect(raw).not.toContain(fragment);
    expect(raw).not.toContain('9000');
    // The job surfaces and the audit trail carry no value.
    const surfaces = JSON.stringify([
      done,
      report,
      ok(await world.platform.imports.history(a.admin.token, corr(), done.job.id, {})),
      ok(await world.platform.imports.list(a.admin.token, corr(), {})),
      world.audit.list(a.tenantId),
    ]);
    for (const fragment of PII_FRAGMENTS) expect(surfaces).not.toContain(fragment);
    const actions = world.audit
      .list(a.tenantId)
      .filter((event) => ['import_job', 'employee'].includes(event.entityType))
      .map((event) => `${event.entityType}:${event.action}`);
    expect(actions).toEqual(['employee:employee.created', 'import_job:import_job.created']);
    // A failure of the underlying services never leaks a value either.
    const broken = ok(
      await world.platform.imports.submit(a.admin.token, corr(), {
        entity: 'employee',
        mode: 'commit_valid',
        idempotencyKey: 'platform-import-2',
        rows: [{ ...rows[0], employeeNumber: 'EMP-2', nationalId: 'SYNTH-ID-7788-QX' }],
      }),
    );
    expect(broken.job).toMatchObject({ importedRows: 0, invalidRows: 1 });
    expect(JSON.stringify(broken)).not.toContain('SYNTH-ID-7788');
  });

  it('requires session, permission and keeps tenants apart on every operation', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const viewer = await world.member(a.admin, 'viewer', 'subject-viewer-a');
    const area = ok(await world.platform.areas.create(a.admin.token, corr(), { name: 'Flota' })).id;
    const row = {
      economicNumber: 'U-1',
      plate: 'ABC1',
      make: 'Toyota',
      model: 'Hilux',
      year: 2022,
      areaId: area,
      odometerKm: 1,
    };
    const input = { entity: 'vehicle', mode: 'dry_run', rows: [row] };
    expect((await world.platform.imports.submit('bad-token', corr(), input)).error?.status).toBe(
      401,
    );
    expect((await world.platform.imports.submit(viewer.token, corr(), input)).error?.status).toBe(
      403,
    );
    expect((await world.platform.imports.list(viewer.token, corr(), {})).ok).toBe(true);
    const job = ok(await world.platform.imports.submit(a.admin.token, corr(), input)).job;
    for (const call of [
      () => world.platform.imports.get(b.admin.token, corr(), job.id),
      () => world.platform.imports.rows(b.admin.token, corr(), job.id, {}),
      () => world.platform.imports.history(b.admin.token, corr(), job.id, {}),
    ])
      expect((await call()).error?.status).toBe(404);
    expect(ok(await world.platform.imports.list(b.admin.token, corr(), {})).total).toBe(0);
    // Tenant B cannot import into tenant A's area.
    const foreign = ok(await world.platform.imports.submit(b.admin.token, corr(), input));
    expect(foreign.job).toMatchObject({ invalidRows: 1, validRows: 0 });
    expect(world.audit.list(b.tenantId).every((event) => event.tenantId === b.tenantId)).toBe(true);
  });
});

describe('ImportsApi', () => {
  const api = (authorize: () => Promise<never>, service: Partial<ImportService> = {}) => {
    const asked: string[][] = [];
    return {
      asked,
      api: new ImportsApi({
        service: service as ImportService,
        authorize: async (_token, _correlation, required) => {
          asked.push([...required]);
          return authorize();
        },
        audit: () => undefined,
      }),
    };
  };

  it('asks for the documented permissions', async () => {
    const { api: denied, asked } = api(async () => {
      throw new AuthError('forbidden');
    });
    await denied.get('t', 'c', 'x');
    await denied.list('t', 'c', {});
    await denied.rows('t', 'c', 'x', {});
    await denied.history('t', 'c', 'x', {});
    await denied.submit('t', 'c', { entity: 'vehicle' });
    await denied.submit('t', 'c', {
      entity: 'employee',
      mode: 'dry_run',
      rows: [
        { kind: 'driver', firstName: 'A', lastName: 'B', areaId: 'x', phone: '+52 55 9000 1234' },
      ],
    });
    expect(asked).toEqual([
      ['view'],
      ['view'],
      ['view'],
      ['view'],
      ['create'],
      ['create', 'view_pii'],
    ]);
    expect(IMPORT_PERMISSIONS).toEqual({ read: ['view'], create: ['create'], pii: ['view_pii'] });
  });

  it('maps every failure to a safe payload', async () => {
    const cases: [unknown, number, string][] = [
      [new AuthError('unauthorized'), 401, 'unauthorized'],
      [new AuthError('expired'), 401, 'unauthorized'],
      [new AuthError('forbidden'), 403, 'forbidden'],
      [new AuthError('invalid_input'), 400, 'invalid_input'],
      [new AuthError('not_found'), 500, 'internal_error'],
      [new ImportError('not_found'), 404, 'not_found'],
      [new ImportError('conflict'), 409, 'conflict'],
      [new ImportError('invalid_input'), 400, 'invalid_input'],
      [new Error('SYNTH-ID-7788 sql: select * from secrets'), 500, 'internal_error'],
      ['SYNTH-ID-7788', 500, 'internal_error'],
    ];
    for (const [error, status, code] of cases) {
      const { api: failing } = api(async () => {
        throw error;
      });
      const result = await failing.get('t', 'c', 'x');
      expect([result.ok, result.error?.status, result.error?.code]).toEqual([false, status, code]);
      expect(JSON.stringify(result)).not.toContain('SYNTH-ID-7788');
      expect(JSON.stringify(result)).not.toContain('select');
    }
  });
});

describe('import targets', () => {
  const boom = new Error('storage down: SYNTH-ID-7788');
  const areas = (active: boolean) =>
    ({ withActiveArea: async () => ({ active, value: true }) }) as never;

  it('vehicle target maps the vehicle service errors to row issues and rethrows the rest', async () => {
    const outcome = async (error: unknown) => {
      const target = vehicleImportTarget({
        vehicles: {
          create: async () => {
            throw error;
          },
        } as never,
        areas: areas(true),
      });
      return target.create('t', 'actor', { plate: 'X', make: 'y' });
    };
    expect(await outcome(new VehicleError('duplicate', 'vin'))).toEqual({
      issue: { code: 'duplicate', columns: ['vin'] },
    });
    expect(await outcome(new VehicleError('duplicate'))).toEqual({
      issue: { code: 'duplicate', columns: [] },
    });
    expect(await outcome(new VehicleError('invalid_area'))).toEqual({
      issue: { code: 'invalid_area', columns: ['areaId'] },
    });
    expect(await outcome(new VehicleError('invalid_input'))).toEqual({
      issue: { code: 'invalid_value', columns: ['plate', 'make'] },
    });
    await expect(outcome(new VehicleError('not_found'))).rejects.toBeInstanceOf(VehicleError);
    await expect(outcome(boom)).rejects.toBe(boom);
  });

  it('employee target maps the employee service errors to row issues and rethrows the rest', async () => {
    const outcome = async (error: unknown) => {
      const target = employeeImportTarget({
        employees: {
          create: async () => {
            throw error;
          },
        } as never,
        areas: areas(true),
      });
      return target.create('t', 'actor', { lastName: 'x' });
    };
    expect(await outcome(new EmployeeError('duplicate', 'email'))).toEqual({
      issue: { code: 'duplicate', columns: ['email'] },
    });
    expect(await outcome(new EmployeeError('duplicate'))).toEqual({
      issue: { code: 'duplicate', columns: [] },
    });
    expect(await outcome(new EmployeeError('invalid_area'))).toEqual({
      issue: { code: 'invalid_area', columns: ['areaId'] },
    });
    expect(await outcome(new EmployeeError('invalid_input'))).toEqual({
      issue: { code: 'invalid_value', columns: ['lastName'] },
    });
    await expect(outcome(new EmployeeError('not_found'))).rejects.toBeInstanceOf(EmployeeError);
    await expect(outcome(boom)).rejects.toBe(boom);
  });

  it('names the columns the entity refuses, or every column when none explains it', () => {
    const vehicles = vehicleImportTarget({ vehicles: {} as never, areas: areas(true) });
    const base = {
      economicNumber: 'E-1',
      plate: 'AB1',
      make: 'Marca',
      model: 'Modelo',
      year: 2020,
      areaId: 'area-1',
      odometerKm: 0,
    };
    expect(vehicles.invalidColumns(base, NOW)).toEqual([]);
    expect(vehicles.invalidColumns({ ...base, year: 1800 }, NOW)).toEqual(['year']);
    // A row with no valid explanation per column (the required ones are missing) names all of them.
    expect(vehicles.invalidColumns({ plate: 'AB1' }, NOW)).toEqual(['plate']);
    const employees = employeeImportTarget({ employees: {} as never, areas: areas(true) });
    const person = { kind: 'driver', firstName: 'Ana', lastName: 'Letra', areaId: 'area-1' };
    expect(employees.invalidColumns(person, NOW)).toEqual([]);
    expect(employees.invalidColumns({ ...person, idType: 'ine' }, NOW)).toEqual(['idType']);
    expect(employees.invalidColumns({ ...person, nationalId: 'ABC-123456' }, NOW)).toEqual([
      'nationalId',
    ]);
    expect(employees.invalidColumns({ ...person, kind: 'other', licenseType: 'c' }, NOW)).toEqual([
      'licenseType',
    ]);
    expect(employees.invalidColumns({ ...person, kind: 'dispatcher', phone: '1' }, NOW)).toEqual([
      'phone',
    ]);
  });

  it('prechecks keys without a value and reports inactive areas', async () => {
    const vehicles = vehicleImportTarget({
      vehicles: {
        list: async () => ({
          total: 1,
          items: [{ economicNumber: 'U-1', plate: 'ABC1', vin: null }],
        }),
      } as never,
      areas: areas(false),
    });
    const row = (over: Record<string, unknown>) => ({
      economicNumber: 'U-9',
      plate: 'ZZZ9',
      areaId: 'a1',
      ...over,
    });
    expect(
      await vehicles.precheck('t', [
        row({ plate: 'abc1' }),
        row({ economicNumber: 'u-1' }),
        row({}),
      ]),
    ).toEqual([
      { code: 'duplicate', columns: ['plate'] },
      { code: 'duplicate', columns: ['economicNumber'] },
      { code: 'invalid_area', columns: ['areaId'] },
    ]);
    expect(vehicles.keys(row({}))).toEqual([
      ['economicNumber', expect.any(String)],
      ['plate', expect.any(String)],
    ]);
    const employees = employeeImportTarget({
      employees: {
        list: async () => ({
          total: 2,
          items: [{ employeeNumber: 'E-1' }, { employeeNumber: null }],
        }),
      } as never,
      areas: areas(true),
    });
    expect(
      await employees.precheck('t', [{ employeeNumber: 'e-1', areaId: 'a1' }, { areaId: 'a1' }]),
    ).toEqual([{ code: 'duplicate', columns: ['employeeNumber'] }, null]);
    expect(
      employees.keys({
        employeeNumber: 'e-1',
        idType: 'INE',
        nationalId: 'ABC-123456',
        email: 'A@B.C',
      }),
    ).toHaveLength(3);
    expect(employees.keys({})).toEqual([]);
  });

  it('stops scanning stored records after the page cap', async () => {
    const list = vi.fn(async () => ({ total: 10_000_000, items: [] }));
    const vehicles = vehicleImportTarget({ vehicles: { list } as never, areas: areas(true) });
    await vehicles.precheck('t', []);
    expect(list).toHaveBeenCalledTimes(100);
    const employees = employeeImportTarget({ employees: { list } as never, areas: areas(true) });
    list.mockClear();
    await employees.precheck('t', []);
    expect(list).toHaveBeenCalledTimes(100);
  });
});
