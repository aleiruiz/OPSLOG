import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  EmployeeError,
  EmployeeService,
  statusEntry,
  areaEntry,
  type Employee,
  type EmployeeHistoryEntry,
} from '../../../domain/employees/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../platform/pii/src/index.js';
import { EmployeeEntity, EmployeeHistoryEntity } from './entities.js';
import { EmployeeStoreError } from './errors.js';
import { TypeOrmEmployeeStore, type StoreErrorEvent } from './store.js';
import {
  CONNECTION_LOST,
  DEADLOCK,
  DUPLICATE,
  FakeDatabase,
  LOCK_TIMEOUT,
  asDataSource,
} from './test-support/fake-database.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const HEX = (n: number): string => n.toString(16).padStart(64, '0');

let serial = 0;
/** A stored-shape employee with fake (but well-formed) envelopes and indexes. */
const employee = (tenant: string, id: string, over: Partial<Employee> = {}): Employee => {
  const n = (serial += 1);
  return {
    id,
    tenantId: tenant,
    kind: 'driver',
    firstName: 'Ana',
    lastName: 'Pérez',
    employeeNumber: `E-${n}`,
    position: 'Conductor',
    hireDate: '2024-03-01',
    areaId: 'area-1',
    status: 'active',
    statusReason: 'Alta',
    idType: 'ine',
    licenseType: 'C',
    licenseExpiresOn: '2027-01-31',
    pii: {
      nationalId: { sealed: `pii1.id${n}.a.b.c`, index: HEX(n) },
      phone: { sealed: `pii1.ph${n}.a.b.c`, index: null },
      email: { sealed: `pii1.em${n}.a.b.c`, index: HEX(1000 + n) },
      licenseNumber: { sealed: `pii1.li${n}.a.b.c`, index: HEX(2000 + n) },
    },
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    archivedAt: null,
    ...over,
  };
};
const bare = (tenant: string, id: string, over: Partial<Employee> = {}): Employee =>
  employee(tenant, id, {
    kind: 'other',
    employeeNumber: null,
    idType: null,
    licenseType: null,
    licenseExpiresOn: null,
    pii: { nationalId: null, phone: null, email: null, licenseNumber: null },
    ...over,
  });
const entryOf = (e: Employee, from: Employee['status'] | null = null): EmployeeHistoryEntry =>
  statusEntry(e, from, `entry-${e.id}-${e.version}`, ACTOR, NOW);

function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmEmployeeStore(asDataSource(db), {
    onError: (event) => events.push(event),
    ...options,
  });
  return { db, events, store };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};
const window = { limit: 10, offset: 0 };

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) =>
    new TypeOrmEmployeeStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted employees account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_employees_x' })).toThrow(/MySQL/);
    expect(() =>
      build({ type: 'mysql', username: 'opslog_employees_x', synchronize: true }),
    ).toThrow(/synchronize/);
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_vehicles_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_employees_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store } = setup({ maxAttempts: 0 });
    db.failNext('insert', DEADLOCK, { entity: EmployeeEntity });
    const e = employee(A, 'e1');
    expect(await rejection(store.insert(e, entryOf(e)))).toMatchObject({ code: 'contention' });
  });
});

describe('insert, find and history', () => {
  it('stores the employee and its first history entry in one transaction and reads them back', async () => {
    const { db, store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    expect(await store.find(A, 'e1')).toEqual(e);
    expect((await store.history(A, 'e1', window)).items).toEqual([entryOf(e)]);
    expect(db.isolations).toEqual(['READ COMMITTED']);
    const [row] = db.committed(EmployeeEntity);
    expect(row).toMatchObject({
      tenantId: A,
      nameKey: 'pérez ana',
      employeeNumberKey: e.employeeNumber?.toLowerCase(),
      nationalIdEnc: e.pii.nationalId?.sealed,
      nationalIdIdx: e.pii.nationalId?.index,
      phoneEnc: e.pii.phone?.sealed,
      emailIdx: e.pii.email?.index,
    });
    // there is no plaintext column at all
    expect(
      Object.keys(row ?? {}).filter((key) => /^(nationalId|phone|email|licenseNumber)$/.test(key)),
    ).toEqual([]);
  });

  it('round-trips an employee without personal data or employee number', async () => {
    const { db, store } = setup();
    const e = bare(A, 'e1');
    await store.insert(e, entryOf(e));
    expect(await store.find(A, 'e1')).toEqual(e);
    expect(db.committed(EmployeeEntity)[0]).toMatchObject({
      employeeNumber: null,
      employeeNumberKey: null,
      nationalIdEnc: null,
      nationalIdIdx: null,
    });
  });

  it('does not keep an employee whose history row cannot be written', async () => {
    const { db, store } = setup();
    const e = employee(A, 'e1');
    db.failNext('insert', CONNECTION_LOST, { entity: EmployeeHistoryEntity });
    expect(await rejection(store.insert(e, entryOf(e)))).toMatchObject({ code: 'unavailable' });
    expect(db.committed(EmployeeEntity)).toEqual([]);
  });

  it('refuses a history entry that points at another tenant employee (composite key)', async () => {
    const { db, store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const other = employee(B, 'e9');
    const foreign = { ...entryOf(other), employeeId: 'e1' };
    expect(await rejection(store.insert(other, foreign))).toMatchObject({ code: 'integrity' });
    expect(db.committed(EmployeeEntity)).toHaveLength(1);
  });

  it('never returns another tenant rows and filters every statement by company', async () => {
    const { db, store } = setup();
    const a = employee(A, 'e1');
    const b = employee(B, 'e1', { employeeNumber: a.employeeNumber, pii: a.pii });
    await store.insert(a, entryOf(a));
    await store.insert(b, entryOf(b));
    expect(await store.find(A, 'e1')).toMatchObject({ tenantId: A });
    expect(await store.find(B, 'e1')).toMatchObject({ tenantId: B });
    expect(await store.find('tenant-c', 'e1')).toBeNull();
    expect((await store.list(A, { includeArchived: true }, window)).items).toEqual([a]);
    expect((await store.history('tenant-c', 'e1', window)).items).toEqual([]);
    expect((await store.history(B, 'e1', window)).items).toEqual([entryOf(b)]);
    await store.replace({ ...a, version: 2, firstName: 'Zoe' }, 1);
    expect((await store.find(B, 'e1'))?.firstName).toBe('Ana');
    for (const statement of db.statements.filter((s) => s.where !== null))
      expect(statement.where, statement.operation).toHaveProperty('tenantId');
  });

  it('pages the history newest first with a total', async () => {
    const { store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const second = { ...e, version: 2, status: 'inactive' as const, statusReason: 'x' };
    await store.replace(second, 1, entryOf(second, 'active'));
    const third = { ...second, version: 3, areaId: 'area-2' };
    await store.replace(third, 2, areaEntry(third, 'area-1', 'entry-area', ACTOR, NOW));
    const page = await store.history(A, 'e1', { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(
      page.items.map((entry) => [entry.version, entry.kind, entry.from, entry.to, entry.reason]),
    ).toEqual([
      [3, 'area', 'area-1', 'area-2', null],
      [2, 'status', 'active', 'inactive', 'x'],
    ]);
    expect(
      (await store.history(A, 'e1', { limit: 2, offset: 2 })).items.map((x) => x.version),
    ).toEqual([1]);
  });

  it('reports corrupt rows as integrity failures without exposing them', async () => {
    const { db, store, events } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const row = db.committed(EmployeeEntity)[0] as Record<string, unknown>;
    for (const broken of [
      { status: 'Activo' },
      { kind: 'mechanic' },
      { nationalIdIdx: null }, // sealed value without its index
      { nationalIdEnc: null }, // index without its sealed value
      { phoneEnc: 'x', emailIdx: null },
      { emailEnc: null, emailIdx: HEX(5) },
    ]) {
      db.seed(EmployeeEntity, { ...row, ...broken });
      expect(await rejection(store.find(A, 'e1'))).toMatchObject({ code: 'integrity' });
    }
    db.seed(EmployeeEntity, { ...row, phoneEnc: e.pii.phone?.sealed });
    // a phone must never carry an index
    expect(await store.find(A, 'e1')).toBeTruthy();
    const history = db.committed(EmployeeHistoryEntity)[0] as Record<string, unknown>;
    db.seed(EmployeeHistoryEntity, { ...history, kind: 'other' });
    expect(await rejection(store.history(A, 'e1', window))).toMatchObject({ code: 'integrity' });
    expect(events.every((event) => event.code === 'integrity')).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(7);
  });
});

describe('uniqueness', () => {
  it('names the colliding key and keeps nothing of the failed insert', async () => {
    const { db, store } = setup();
    const first = employee(A, 'e1');
    await store.insert(first, entryOf(first));
    const clash = (over: Partial<Employee>) =>
      employee(A, 'e2', {
        employeeNumber: null,
        pii: { nationalId: null, phone: null, email: null, licenseNumber: null },
        idType: null,
        ...over,
      });
    const cases: [Employee, string][] = [
      [clash({ employeeNumber: first.employeeNumber?.toUpperCase() ?? null }), 'employee_number'],
      [
        clash({
          idType: 'ine',
          pii: {
            ...first.pii,
            email: null,
            licenseNumber: null,
            phone: null,
            nationalId: { sealed: 'pii1.z', index: first.pii.nationalId?.index ?? null },
          },
        }),
        'national_id',
      ],
      [
        clash({
          pii: {
            nationalId: null,
            phone: null,
            licenseNumber: null,
            email: { sealed: 'pii1.z', index: first.pii.email?.index ?? null },
          },
        }),
        'email',
      ],
    ];
    for (const [candidate, field] of cases) {
      expect(await rejection(store.insert(candidate, entryOf(candidate)))).toEqual(
        new EmployeeError('duplicate', field as never),
      );
    }
    // Same id: duplicate without a field name.
    const same = bare(A, 'e1');
    const error = await rejection(store.insert(same, entryOf(same)));
    expect(error).toMatchObject({ code: 'duplicate' });
    expect((error as EmployeeError).field).toBeUndefined();
    expect(db.committed(EmployeeEntity)).toHaveLength(1);
    expect(db.committed(EmployeeHistoryEntity)).toHaveLength(1);
  });

  it('names only keys taken in the same company, never one that exists in another', async () => {
    const { store } = setup();
    const other = employee(B, 'o1');
    const mine = employee(A, 'e1');
    await store.insert(other, entryOf(other));
    await store.insert(mine, entryOf(mine));
    // number and identification exist in B; only the e-mail clash is in A
    const candidate = employee(A, 'e2', {
      employeeNumber: other.employeeNumber,
      pii: { ...other.pii, email: mine.pii.email },
    });
    expect(await rejection(store.insert(candidate, entryOf(candidate)))).toEqual(
      new EmployeeError('duplicate', 'email'),
    );
  });

  it('allows the same keys in another company and several employees without any key', async () => {
    const { store } = setup();
    const shared = employee(A, 'e1');
    for (const e of [
      shared,
      employee(B, 'e1', { employeeNumber: shared.employeeNumber, pii: shared.pii }),
      bare(A, 'e2'),
      bare(A, 'e3'),
    ])
      await store.insert(e, entryOf(e));
    expect((await store.list(A, { includeArchived: true }, window)).total).toBe(3);
  });

  it('allows the same license index twice (indexed, not unique)', async () => {
    const { store } = setup();
    const one = employee(A, 'e1');
    const two = employee(A, 'e2', {
      pii: { ...employee(A, 'x').pii, licenseNumber: one.pii.licenseNumber },
    });
    await store.insert(one, entryOf(one));
    await store.insert(two, entryOf(two));
    expect((await store.list(A, { includeArchived: true }, window)).total).toBe(2);
  });

  it('maps a race on an update to a duplicate naming the key', async () => {
    const { db, store } = setup();
    const one = employee(A, 'e1');
    const two = employee(A, 'e2');
    await store.insert(one, entryOf(one));
    await store.insert(two, entryOf(two));
    expect(
      await rejection(store.replace({ ...two, version: 2, employeeNumber: one.employeeNumber }, 1)),
    ).toEqual(new EmployeeError('duplicate', 'employee_number'));
    expect(
      await rejection(
        store.replace(
          { ...two, version: 2, pii: { ...two.pii, nationalId: one.pii.nationalId } },
          1,
        ),
      ),
    ).toEqual(new EmployeeError('duplicate', 'national_id'));
    expect((await store.find(A, 'e2'))?.version).toBe(1);
    // Its own keys never collide with itself.
    expect(await store.replace({ ...two, version: 2, firstName: 'Zoe' }, 1)).toBe(true);
    expect(db.committed(EmployeeEntity)).toHaveLength(2);
  });

  it('still reports a duplicate when the key lookup itself fails, without leaking', async () => {
    const { db, store, events } = setup();
    const one = employee(A, 'e1');
    await store.insert(one, entryOf(one));
    const clash = employee(A, 'e2', { employeeNumber: one.employeeNumber });
    db.failNext('find', CONNECTION_LOST, { leak: 'LEAKED-VALUE' });
    const error = await rejection(store.insert(clash, entryOf(clash)));
    expect(error).toBeInstanceOf(EmployeeStoreError);
    expect(JSON.stringify(error)).not.toContain('LEAKED-VALUE');
    expect(events).toMatchObject([{ operation: 'insert', code: 'unavailable', errno: 2013 }]);
  });

  it('reports a duplicate without a nameable key as a plain duplicate', async () => {
    const { db, store } = setup();
    const e = bare(A, 'e1');
    db.failNext('insert', DUPLICATE, { entity: EmployeeEntity });
    expect(await rejection(store.insert(e, entryOf(e)))).toEqual(new EmployeeError('duplicate'));
  });

  it('reports a driver duplicate on reads as an unavailable store (not an employee conflict)', async () => {
    const { db, store } = setup();
    db.failNext('find', DUPLICATE);
    expect(await rejection(store.find(A, 'e1'))).toMatchObject({
      code: 'unavailable',
      errno: 1062,
    });
  });
});

describe('replace (optimistic concurrency)', () => {
  it('writes under the expected version, bumps it and appends the history entry together', async () => {
    const { store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const next = { ...e, status: 'suspended' as const, statusReason: 'Revisión', version: 2 };
    expect(await store.replace(next, 1, entryOf(next, 'active'))).toBe(true);
    expect(await store.find(A, 'e1')).toEqual(next);
    expect(
      (await store.history(A, 'e1', window)).items.map((x) => [x.version, x.from, x.to]),
    ).toEqual([
      [2, 'active', 'suspended'],
      [1, null, 'active'],
    ]);
  });

  it('clears and replaces sealed values together with their indexes', async () => {
    const { db, store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const cleared = {
      ...e,
      version: 2,
      idType: null,
      pii: { ...e.pii, nationalId: null, email: null },
    };
    expect(await store.replace(cleared, 1)).toBe(true);
    expect(db.committed(EmployeeEntity)[0]).toMatchObject({
      nationalIdEnc: null,
      nationalIdIdx: null,
      emailEnc: null,
      emailIdx: null,
      idType: null,
    });
    expect(await store.find(A, 'e1')).toEqual(cleared);
  });

  it('returns false for a stale version, an unknown id and another tenant, changing nothing', async () => {
    const { db, store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const before = db.committed(EmployeeEntity);
    const next = { ...e, version: 2, firstName: 'Zoe' };
    expect(await store.replace(next, 7)).toBe(false);
    expect(await store.replace({ ...next, id: 'ghost' }, 1)).toBe(false);
    expect(await store.replace({ ...next, tenantId: B }, 1)).toBe(false);
    expect(db.committed(EmployeeEntity)).toEqual(before);
  });

  it('lets exactly one of two writers holding the same version win', async () => {
    const { store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const results = await Promise.all([
      store.replace({ ...e, version: 2, firstName: 'Zoe' }, 1),
      store.replace({ ...e, version: 2, firstName: 'Eva' }, 1),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.find(A, 'e1'))?.version).toBe(2);
  });

  it('rolls back the employee change when the history row cannot be written', async () => {
    const { db, store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const next = { ...e, status: 'inactive' as const, statusReason: 'x', version: 2 };
    db.failNext('insert', CONNECTION_LOST, { entity: EmployeeHistoryEntity });
    expect(await rejection(store.replace(next, 1, entryOf(next, 'active')))).toMatchObject({
      code: 'unavailable',
    });
    expect(await store.find(A, 'e1')).toEqual(e);
  });

  it('archives by writing the timestamp and hides the employee from default listings', async () => {
    const { store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    const archived = { ...e, version: 2, archivedAt: '2026-10-07T00:00:00.000Z' };
    expect(await store.replace(archived, 1)).toBe(true);
    expect((await store.find(A, 'e1'))?.archivedAt).toBe('2026-10-07T00:00:00.000Z');
    expect((await store.list(A, { includeArchived: false }, window)).total).toBe(0);
    expect((await store.list(A, { includeArchived: true }, window)).total).toBe(1);
  });

  it('never changes the kind, tenant, id or creation time', async () => {
    const { db, store } = setup();
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    await store.replace(
      { ...e, version: 2, kind: 'dispatcher', createdAt: '2020-01-01T00:00:00.000Z' },
      1,
    );
    expect(db.committed(EmployeeEntity)[0]).toMatchObject({
      kind: 'driver',
      createdAt: new Date(NOW.toISOString()),
    });
  });
});

describe('count port for the Areas module', () => {
  it('counts employees of the tenant in the area that are not archived or terminated', async () => {
    const { db, store } = setup();
    const rows = [
      employee(A, 'e1'),
      employee(A, 'e2', { status: 'inactive' }),
      employee(A, 'e3', { status: 'suspended' }),
      employee(A, 'e4', { status: 'terminated' }),
      employee(A, 'e5', { archivedAt: NOW.toISOString() }),
      employee(A, 'e6', { areaId: 'area-2' }),
      employee(B, 'e1'),
    ];
    for (const row of rows) await store.insert(row, entryOf(row));
    expect(await store.countLiveInArea(A, 'area-1')).toBe(3);
    expect(await store.countLiveInArea(A, 'area-2')).toBe(1);
    expect(await store.countLiveInArea(B, 'area-1')).toBe(1);
    expect(await store.countLiveInArea('tenant-c', 'area-1')).toBe(0);
    const counts = db.statements.filter((s) => s.operation === 'count');
    expect(counts).toHaveLength(4);
    for (const statement of counts) expect(statement.where).toHaveProperty('tenantId');
  });

  it('reports a failing count without leaking', async () => {
    const { db, store } = setup();
    db.failNext('count', CONNECTION_LOST, { leak: 'area-secret' });
    const error = await rejection(store.countLiveInArea(A, 'area-secret'));
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(JSON.stringify(error)).not.toContain('area-secret');
  });
});

describe('list', () => {
  it('filters, orders by last then first name then id, and windows with a total', async () => {
    const { store } = setup();
    const rows = [
      bare(A, 'e1', { firstName: 'Beto', lastName: 'Zamora', areaId: 'x' }),
      bare(A, 'e2', {
        firstName: 'Ana',
        lastName: 'Alvarez',
        areaId: 'y',
        status: 'inactive',
        kind: 'dispatcher',
      }),
      bare(A, 'e3', {
        firstName: 'Ana',
        lastName: 'Zamora',
        areaId: 'x',
        archivedAt: NOW.toISOString(),
      }),
    ];
    for (const row of rows) await store.insert(row, entryOf(row));
    const ids = async (filter: Parameters<typeof store.list>[1], w = window) =>
      (await store.list(A, filter, w)).items.map((e) => e.id);
    expect(await ids({ includeArchived: false })).toEqual(['e2', 'e1']);
    expect(await ids({ includeArchived: true })).toEqual(['e2', 'e3', 'e1']);
    expect(await ids({ includeArchived: true, areaId: 'x' })).toEqual(['e3', 'e1']);
    expect(await ids({ includeArchived: false, status: 'inactive' })).toEqual(['e2']);
    expect(await ids({ includeArchived: false, kind: 'dispatcher' })).toEqual(['e2']);
    expect(await ids({ includeArchived: true }, { limit: 1, offset: 1 })).toEqual(['e3']);
    expect((await store.list(A, { includeArchived: true }, { limit: 1, offset: 1 })).total).toBe(3);
  });
});

describe('failures', () => {
  it('retries deadlocks and lock timeouts, then succeeds', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: EmployeeEntity });
    db.failNext('insert', LOCK_TIMEOUT, { entity: EmployeeEntity });
    const e = employee(A, 'e1');
    await store.insert(e, entryOf(e));
    expect(db.committed(EmployeeEntity)).toHaveLength(1);
    expect(db.transactions).toBe(3);
    expect(events).toEqual([]);
  });

  it('gives up after the attempt budget with a contention error', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: EmployeeEntity, times: 5 });
    const e = employee(A, 'e1');
    expect(await rejection(store.insert(e, entryOf(e)))).toMatchObject({
      code: 'contention',
      errno: 1213,
    });
    expect(db.transactions).toBe(3);
    expect(events).toEqual([{ operation: 'insert', code: 'contention', errno: 1213 }]);
  });

  it('sanitizes driver errors: no sealed value, index, tenant or SQL in the message, JSON or event', async () => {
    const { db, store, events } = setup();
    const e = employee(A, 'e1');
    db.failNext('insert', CONNECTION_LOST, { entity: EmployeeEntity, leak: 'secret-tenant-a' });
    const error = await rejection(store.insert(e, entryOf(e)));
    expect(error).toBeInstanceOf(EmployeeStoreError);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(events)}`;
    for (const secret of [
      'secret-tenant-a',
      e.pii.nationalId?.sealed ?? '?',
      e.pii.nationalId?.index ?? '?',
      'INSERT INTO',
      'opslog_',
      'QueryFailedError',
    ])
      expect(text).not.toContain(secret);
    expect(events).toEqual([{ operation: 'insert', code: 'unavailable', errno: 2013 }]);
  });

  it('classifies a non-driver failure as internal and never throws from the sanitizer', async () => {
    const { db, store, events } = setup();
    db.intercept = (operation) => {
      if (operation === 'find') throw new TypeError('boom with SECRET-VALUE');
    };
    const error = await rejection(store.find(A, 'e1'));
    expect(error).toMatchObject({ code: 'internal', errno: null });
    expect((error as Error).message).not.toContain('SECRET-VALUE');
    expect(events).toEqual([{ operation: 'find', code: 'internal', errno: null }]);
    db.intercept = () => {
      throw new Proxy(
        {},
        {
          get() {
            throw new Error('hostile');
          },
        },
      );
    };
    expect(await rejection(store.find(A, 'e1'))).toMatchObject({ code: 'internal' });
  });
});

describe('through the domain service', () => {
  it('runs the full lifecycle over the store, sealing PII and isolating tenants', async () => {
    const { db, store } = setup();
    let ids = 0;
    const cipher = new EnvelopePiiCipher(
      new LocalDevKms({
        masterKey: Uint8Array.from({ length: 32 }, (_, i) => i + 9),
        environment: 'test',
      }),
    );
    const svc = new EmployeeService(store, {
      pii: cipher,
      now: () => NOW,
      newId: () => `id-${(ids += 1)}`,
    });
    const input = {
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Pérez',
      areaId: 'area-1',
      employeeNumber: 'E-77',
      idType: 'ine',
      nationalId: 'SYNTH-7788-ZZ',
      phone: '+52 55 7000 1234',
      email: 'ana.synth@example.test',
      licenseNumber: 'LIC-445566',
      licenseType: 'C',
      licenseExpiresOn: '2027-05-01',
    };
    const created = await svc.create(A, ACTOR, input);
    await svc.create(B, ACTOR, input);
    const stored = JSON.stringify(db.committed(EmployeeEntity));
    for (const secret of [
      'SYNTH-7788',
      '7788',
      '5570001234',
      '7000 1234',
      'ana.synth',
      'LIC-445566',
      '445566',
    ])
      expect(stored).not.toContain(secret);
    expect(await svc.reveal(await svc.get(A, created.id))).toMatchObject({
      nationalId: 'SYNTH-7788-ZZ',
      phone: '+525570001234',
      email: 'ana.synth@example.test',
      licenseNumber: 'LIC-445566',
    });
    await expect(svc.create(A, ACTOR, input)).rejects.toMatchObject({
      code: 'duplicate',
      field: 'employee_number',
    });
    await expect(svc.create(A, ACTOR, { ...input, employeeNumber: 'E-78' })).rejects.toMatchObject({
      code: 'duplicate',
      field: 'national_id',
    });
    const moved = await svc.update(A, ACTOR, created.id, 1, { areaId: 'area-2' });
    const suspended = await svc.changeStatus(
      A,
      ACTOR,
      created.id,
      moved.version,
      'suspended',
      'Revisión',
    );
    await expect(svc.get(B, created.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await svc.history(A, created.id)).items.map((x) => `${x.kind}:${x.to}`)).toEqual([
      'status:suspended',
      'area:area-2',
      'status:active',
    ]);
    await svc.archive(A, created.id, suspended.version);
    expect((await svc.list(A)).total).toBe(0);
    expect((await svc.list(B)).total).toBe(1);
  });
});
