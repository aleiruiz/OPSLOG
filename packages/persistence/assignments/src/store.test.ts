import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  AssignmentError,
  AssignmentService,
  applyEnd,
  assignedEvent,
  endedEvent,
  type Assignment,
} from '../../../domain/assignments/src/index.js';
import { AssignmentEntity, AssignmentEventEntity } from './entities.js';
import { AssignmentStoreError } from './errors.js';
import { TypeOrmAssignmentStore, type StoreErrorEvent } from './store.js';
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

const assignment = (tenant: string, id: string, over: Partial<Assignment> = {}): Assignment => ({
  id,
  tenantId: tenant,
  vehicleId: 'veh-1',
  employeeId: 'emp-1',
  type: 'principal',
  reason: 'Alta de unidad',
  assignedBy: ACTOR,
  startedAt: NOW.toISOString(),
  endedAt: null,
  endKind: null,
  endReason: null,
  endedBy: null,
  version: 1,
  updatedAt: NOW.toISOString(),
  ...over,
});
const closed = (a: Assignment, kind: 'ended' | 'replaced' = 'ended') =>
  applyEnd(a, kind, 'Cierre', ACTOR, a.version, new Date('2026-10-07T00:00:00.000Z'));

function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmAssignmentStore(asDataSource(db), {
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
const put = (store: TypeOrmAssignmentStore, a: Assignment) => store.insert(a, assignedEvent(a));

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) =>
    new TypeOrmAssignmentStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted assignments account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_assignments_x' })).toThrow(/MySQL/);
    expect(() =>
      build({ type: 'mysql', username: 'opslog_assignments_x', synchronize: true }),
    ).toThrow(/synchronize/);
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_insurance_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_assignments_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store } = setup({ maxAttempts: 0 });
    db.failNext('insert', DEADLOCK, { entity: AssignmentEntity });
    expect(await rejection(put(store, assignment(A, 'a1')))).toMatchObject({ code: 'contention' });
  });
});

describe('insert, find and events', () => {
  it('stores the assignment and its first event in one transaction and reads them back', async () => {
    const { db, store } = setup();
    const a = assignment(A, 'a1');
    await put(store, a);
    expect(await store.find(A, 'a1')).toEqual(a);
    expect((await store.events(A, 'a1', window)).items).toEqual([assignedEvent(a)]);
    expect(db.isolations).toEqual(['READ COMMITTED']);
    expect(db.committed(AssignmentEntity)[0]).toMatchObject({
      tenantId: A,
      vehicleId: 'veh-1',
      currentFlag: 1,
      principalFlag: 1,
    });
  });

  it('derives the flags: only a current principal carries the principal flag', async () => {
    const { db, store } = setup();
    await put(store, assignment(A, 'p', { type: 'principal' }));
    await put(store, assignment(A, 's', { type: 'secondary', vehicleId: 'veh-2' }));
    const e = assignment(A, 'e', { employeeId: 'emp-3', vehicleId: 'veh-3' });
    await put(store, e);
    const ended = closed(e);
    await store.replace(ended, 1, endedEvent(ended));
    const flags = Object.fromEntries(
      db.committed(AssignmentEntity).map((r) => [r['id'], [r['currentFlag'], r['principalFlag']]]),
    );
    expect(flags).toEqual({ p: [1, 1], s: [1, null], e: [null, null] });
  });

  it('keeps tenants apart', async () => {
    const { store } = setup();
    await put(store, assignment(A, 'a1'));
    await put(store, assignment(B, 'a1'));
    expect(await store.find(B, 'zzz')).toBeNull();
    expect((await store.find(B, 'a1'))?.tenantId).toBe(B);
    expect((await store.list(A, {}, window)).total).toBe(1);
    expect((await store.events(A, 'a1', window)).total).toBe(1);
  });

  it('rejects an event for an assignment that does not exist (composite foreign key)', async () => {
    const { db } = setup();
    const orphan = assignedEvent(assignment(A, 'ghost'));
    expect(
      await rejection(db.getRepository(AssignmentEventEntity).insert({ ...orphan })),
    ).toMatchObject({ driverError: { errno: 1452 } });
  });
});

describe('BR-002 / BR-003 as unique keys', () => {
  it('names the vehicle when it already has a current principal', async () => {
    const { store, events } = setup();
    await put(store, assignment(A, 'a1'));
    expect(await rejection(put(store, assignment(A, 'a2', { employeeId: 'emp-2' })))).toEqual(
      new AssignmentError('principal_taken', 'vehicle_id'),
    );
    expect((await store.list(A, {}, window)).total).toBe(1);
    expect(events).toEqual([]);
  });

  it('names the driver when it is already principal of another vehicle', async () => {
    const { store } = setup();
    await put(store, assignment(A, 'a1'));
    const error = await rejection(put(store, assignment(A, 'a2', { vehicleId: 'veh-2' })));
    expect(error).toMatchObject({ code: 'principal_taken', field: 'employee_id' });
  });

  it('refuses a second current assignment of the same driver on the same vehicle', async () => {
    const { store } = setup();
    await put(store, assignment(A, 'a1', { type: 'secondary' }));
    expect(await rejection(put(store, assignment(A, 'a2', { type: 'temporary' })))).toMatchObject({
      code: 'already_assigned',
      field: 'employee_id',
    });
    expect(await rejection(put(store, assignment(A, 'a3', { type: 'principal' })))).toMatchObject({
      code: 'already_assigned',
    });
  });

  it('allows many secondaries and the same ids in another tenant, and frees a slot once ended', async () => {
    const { store } = setup();
    await put(store, assignment(A, 'a1', { type: 'secondary' }));
    await put(store, assignment(A, 'a2', { type: 'secondary', employeeId: 'emp-2' }));
    await put(store, assignment(B, 'b1'));
    const p = assignment(A, 'p1', { vehicleId: 'veh-2' });
    await put(store, p);
    const ended = closed(p);
    await store.replace(ended, 1, endedEvent(ended));
    await put(store, assignment(A, 'p2', { vehicleId: 'veh-2', employeeId: 'emp-9' }));
    await put(store, assignment(A, 'p3', { vehicleId: 'veh-9' }));
    expect((await store.list(A, { status: 'current' }, window)).total).toBe(4);
  });

  it('reports contention when the holder vanished before the conflict could be named', async () => {
    const { db, store } = setup();
    db.failNext('insert', DUPLICATE, { entity: AssignmentEntity });
    const error = await rejection(put(store, assignment(A, 'a1')));
    expect(error).toMatchObject({ code: 'contention' });
    expect(error).toBeInstanceOf(AssignmentStoreError);
    expect(db.committed(AssignmentEntity)).toEqual([]);
  });

  it('sanitizes a failure while naming the conflict', async () => {
    const { db, store } = setup();
    db.failNext('insert', DUPLICATE, { entity: AssignmentEntity });
    db.failNext('find', CONNECTION_LOST, { entity: AssignmentEntity });
    expect(await rejection(put(store, assignment(A, 'a1')))).toMatchObject({
      code: 'unavailable',
      errno: 2013,
    });
  });
});

describe('replacing the principal', () => {
  it('closes the old assignment and opens the new one in one transaction', async () => {
    const { db, store } = setup();
    const old = assignment(A, 'a1');
    await put(store, old);
    const ended = closed(old, 'replaced');
    const next = assignment(A, 'a2', {
      employeeId: 'emp-2',
      startedAt: '2026-10-07T00:00:00.000Z',
    });
    const before = db.transactions;
    expect(
      await store.insert(next, assignedEvent(next), {
        next: ended,
        expectedVersion: 1,
        event: endedEvent(ended),
      }),
    ).toBe(true);
    expect(db.transactions - before).toBe(1);
    expect(await store.find(A, 'a1')).toEqual(ended);
    expect((await store.events(A, 'a1', window)).items.map((e) => e.kind)).toEqual([
      'replaced',
      'assigned',
    ]);
    expect((await store.list(A, { status: 'current' }, window)).items.map((a) => a.id)).toEqual([
      'a2',
    ]);
  });

  it('writes nothing when the old assignment changed in the meantime', async () => {
    const { db, store } = setup();
    const old = assignment(A, 'a1');
    await put(store, old);
    const quiet = closed(old);
    await store.replace(quiet, 1, endedEvent(quiet));
    const ended = closed(old, 'replaced');
    const next = assignment(A, 'a2', { employeeId: 'emp-2' });
    expect(
      await store.insert(next, assignedEvent(next), {
        next: ended,
        expectedVersion: 1,
        event: endedEvent(ended),
      }),
    ).toBe(false);
    expect(await store.find(A, 'a2')).toBeNull();
    expect(db.committed(AssignmentEventEntity)).toHaveLength(2);
  });

  it('rolls everything back when the new principal clashes', async () => {
    const { store } = setup();
    const old = assignment(A, 'a1');
    await put(store, old);
    await put(store, assignment(A, 'x', { vehicleId: 'veh-2', employeeId: 'emp-2' }));
    const ended = closed(old, 'replaced');
    // emp-2 is already principal of veh-2: the replacement of veh-1's principal by emp-2 must fail whole.
    const next = assignment(A, 'a2', { employeeId: 'emp-2' });
    expect(
      await rejection(
        store.insert(next, assignedEvent(next), {
          next: ended,
          expectedVersion: 1,
          event: endedEvent(ended),
        }),
      ),
    ).toMatchObject({ code: 'principal_taken', field: 'employee_id' });
    expect(await store.find(A, 'a1')).toEqual(old);
    expect((await store.events(A, 'a1', window)).total).toBe(1);
  });
});

describe('list', () => {
  it('orders newest first, filters and pages', async () => {
    const { store } = setup();
    const at = (day: number) => `2026-10-0${day}T00:00:00.000Z`;
    await put(store, assignment(A, 'a', { startedAt: at(1), type: 'secondary' }));
    await put(
      store,
      assignment(A, 'b', { startedAt: at(2), vehicleId: 'veh-2', employeeId: 'emp-2' }),
    );
    await put(
      store,
      assignment(A, 'c', { startedAt: at(2), vehicleId: 'veh-3', employeeId: 'emp-3' }),
    );
    const ended = closed(
      assignment(A, 'd', { startedAt: at(3), vehicleId: 'veh-4', employeeId: 'emp-4' }),
    );
    await put(
      store,
      assignment(A, 'd', { startedAt: at(3), vehicleId: 'veh-4', employeeId: 'emp-4' }),
    );
    await store.replace(ended, 1, endedEvent(ended));
    const ids = async (filter: Parameters<typeof store.list>[1]) =>
      (await store.list(A, filter, window)).items.map((a) => a.id);
    expect(await ids({})).toEqual(['d', 'b', 'c', 'a']);
    expect(await ids({ status: 'current' })).toEqual(['b', 'c', 'a']);
    expect(await ids({ status: 'ended' })).toEqual(['d']);
    expect(await ids({ type: 'secondary' })).toEqual(['a']);
    expect(await ids({ vehicleId: 'veh-2' })).toEqual(['b']);
    expect(await ids({ employeeId: 'emp-3' })).toEqual(['c']);
    expect(await store.list(A, {}, { limit: 2, offset: 1 })).toMatchObject({
      total: 4,
      items: [{ id: 'b' }, { id: 'c' }],
    });
  });
});

describe('replace', () => {
  it('closes with a conditional update and appends the event', async () => {
    const { db, store } = setup();
    const a = assignment(A, 'a1');
    await put(store, a);
    const ended = closed(a);
    expect(await store.replace(ended, 1, endedEvent(ended))).toBe(true);
    expect(await store.find(A, 'a1')).toEqual(ended);
    expect(db.committed(AssignmentEventEntity)).toHaveLength(2);
    expect(await store.replace(ended, 1, endedEvent(ended))).toBe(false);
    expect(db.committed(AssignmentEventEntity)).toHaveLength(2);
  });

  it('lets exactly one of two writers holding the same version win', async () => {
    const { store } = setup();
    const a = assignment(A, 'a1');
    await put(store, a);
    const one = closed(a);
    const two = { ...closed(a), endReason: 'Otro motivo' };
    const results = await Promise.all([
      store.replace(one, 1, endedEvent(one)),
      store.replace(two, 1, endedEvent(two)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rolls back the closing when the event row cannot be written', async () => {
    const { db, store } = setup();
    const a = assignment(A, 'a1');
    await put(store, a);
    const ended = closed(a);
    db.failNext('insert', DUPLICATE, { entity: AssignmentEventEntity });
    expect(await rejection(store.replace(ended, 1, endedEvent(ended)))).toBeInstanceOf(
      AssignmentStoreError,
    );
    expect(await store.find(A, 'a1')).toEqual(a);
  });

  it('never changes the tenant, vehicle, driver, type, reason or start', async () => {
    const { db, store } = setup();
    const a = assignment(A, 'a1');
    await put(store, a);
    const before = db.committed(AssignmentEntity)[0];
    const ended = {
      ...closed(a),
      vehicleId: 'veh-9',
      employeeId: 'emp-9',
      type: 'temporary' as const,
      reason: 'Otro',
      startedAt: '2000-01-01T00:00:00.000Z',
    };
    await store.replace(ended, 1, endedEvent(ended));
    expect(db.committed(AssignmentEntity)[0]).toMatchObject({
      vehicleId: before?.['vehicleId'],
      employeeId: before?.['employeeId'],
      type: before?.['type'],
      reason: before?.['reason'],
      startedAt: before?.['startedAt'],
    });
  });
});

describe('corrupt rows', () => {
  it('refuses a row whose type, end kind or event kind the domain does not know', async () => {
    const { db, store } = setup();
    const a = assignment(A, 'a1');
    await put(store, a);
    const row = db.committed(AssignmentEntity)[0] as Record<string, unknown>;
    db.seed(AssignmentEntity, { ...row, type: 'owner' });
    expect(await rejection(store.find(A, 'a1'))).toMatchObject({ code: 'integrity' });
    db.seed(AssignmentEntity, { ...row, endKind: 'vanished' });
    expect(await rejection(store.find(A, 'a1'))).toMatchObject({ code: 'integrity' });
    const event = db.committed(AssignmentEventEntity)[0] as Record<string, unknown>;
    db.seed(AssignmentEventEntity, { ...event, kind: 'edited' });
    expect(await rejection(store.events(A, 'a1', window))).toMatchObject({ code: 'integrity' });
  });
});

describe('failures', () => {
  it('retries deadlocks and lock timeouts, then succeeds', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: AssignmentEntity });
    db.failNext('insert', LOCK_TIMEOUT, { entity: AssignmentEntity });
    await put(store, assignment(A, 'a1'));
    expect(db.committed(AssignmentEntity)).toHaveLength(1);
    expect(db.transactions).toBe(3);
    expect(events).toEqual([]);
  });

  it('gives up after the attempt budget with a contention error', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: AssignmentEntity, times: 5 });
    expect(await rejection(put(store, assignment(A, 'a1')))).toMatchObject({
      code: 'contention',
      errno: 1213,
    });
    expect(db.transactions).toBe(3);
    expect(events).toEqual([{ operation: 'insert', code: 'contention', errno: 1213 }]);
  });

  it('sanitizes driver errors: no reason, id, tenant or SQL in the message, JSON or event', async () => {
    const { db, store, events } = setup();
    const a = assignment(A, 'a1', { reason: 'Motivo-ficticio-prueba' });
    db.failNext('insert', CONNECTION_LOST, {
      entity: AssignmentEntity,
      leak: 'ficticio-tenant-uno',
    });
    const error = await rejection(put(store, a));
    expect(error).toBeInstanceOf(AssignmentStoreError);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(events)}`;
    for (const fragment of [
      'ficticio-tenant-uno',
      'Motivo-ficticio-prueba',
      'INSERT INTO',
      'opslog_vehicle_assignments',
      'QueryFailedError',
    ])
      expect(text).not.toContain(fragment);
    expect(events).toEqual([{ operation: 'insert', code: 'unavailable', errno: 2013 }]);
  });

  it('classifies a non-driver failure as internal and never throws from the sanitizer', async () => {
    const { db, store, events } = setup();
    db.intercept = (operation) => {
      if (operation === 'find') throw new TypeError('boom with FAKE-VALUE-TEXT');
    };
    const error = await rejection(store.find(A, 'p1'));
    expect(error).toMatchObject({ code: 'internal', errno: null });
    expect((error as Error).message).not.toContain('FAKE-VALUE-TEXT');
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
    expect(await rejection(store.find(A, 'p1'))).toMatchObject({ code: 'internal' });
  });

  it('works without an error callback', async () => {
    const db = new FakeDatabase();
    const store = new TypeOrmAssignmentStore(asDataSource(db));
    db.failNext('find', CONNECTION_LOST);
    expect(await rejection(store.find(A, 'p1'))).toMatchObject({ code: 'unavailable' });
  });
});

describe('through the domain service', () => {
  it('runs the full lifecycle over the store and isolates tenants', async () => {
    const { store } = setup();
    let ids = 0;
    let tick = 0;
    const svc = new AssignmentService(store, {
      now: () => new Date(NOW.getTime() + (tick += 1000)),
      newId: () => `asg-${(ids += 1)}`,
    });
    const body = { vehicleId: 'veh-1', employeeId: 'emp-1', type: 'principal', reason: 'Alta' };
    await svc.create(A, ACTOR, body);
    await expect(svc.create(A, ACTOR, { ...body, employeeId: 'emp-2' })).rejects.toMatchObject({
      code: 'principal_taken',
      field: 'vehicle_id',
    });
    const swapped = await svc.create(A, ACTOR, { ...body, employeeId: 'emp-2', replace: true });
    expect(swapped.replaced).toMatchObject({ id: 'asg-1', endKind: 'replaced' });
    await expect(svc.get(B, 'asg-2')).rejects.toMatchObject({ code: 'not_found' });
    expect((await svc.list(A, { status: 'current' })).items.map((a) => a.id)).toEqual(['asg-2']);
    await svc.end(A, ACTOR, 'asg-2', 1, { reason: 'Baja' });
    await expect(svc.end(A, ACTOR, 'asg-2', 2, { reason: 'Otra vez' })).rejects.toMatchObject({
      code: 'immutable',
    });
    expect((await svc.history(A, 'asg-2')).items.map((e) => e.kind)).toEqual(['ended', 'assigned']);
    expect((await svc.list(A)).total).toBe(2);
  });
});
