import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  AreaError,
  AreaService,
  NO_RESOURCES,
  historyEntry,
  newArea,
  parseNewArea,
  type Area,
  type AreaHistoryEntry,
} from '../../../domain/areas/src/index.js';
import {
  AreaEntity,
  AreaHistoryEntity,
  AreaLockEntity,
  AreaResponsibleEntity,
} from './entities.js';
import { AreaStoreError } from './errors.js';
import { TypeOrmAreaStore, type StoreErrorEvent } from './store.js';
import { AuditDeliveryEntity, AuditLocalEventEntity } from '../../audit/src/entities.js';
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

const area = (tenant: string, id: string, over: Record<string, unknown> = {}): Area => ({
  ...newArea(
    tenant,
    id,
    parseNewArea({ name: `Area ${id}`, code: `c-${id}`.toUpperCase() }),
    1,
    NOW,
  ),
  ...over,
});
const entryOf = (a: Area, action: AreaHistoryEntry['action'] = 'created'): AreaHistoryEntry =>
  historyEntry(a, action, [], { from: null, to: a.parentId }, `h-${a.id}-${a.version}`, ACTOR, NOW);

function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmAreaStore(asDataSource(db), {
    onError: (event) => events.push(event),
    ...options,
  });
  return { db, events, store };
}

const seed = async (store: TypeOrmAreaStore, ...areas: Area[]) => {
  for (const a of areas) await store.transaction(a.tenantId, (tx) => tx.insert(a, entryOf(a)));
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) => new TypeOrmAreaStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted areas account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_areas_x' })).toThrow(/MySQL/);
    expect(() => build({ type: 'mysql', username: 'opslog_areas_x', synchronize: true })).toThrow(
      /synchronize/,
    );
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_vehicles_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_areas_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store } = setup({ maxAttempts: 0 });
    db.failNext('lock', DEADLOCK);
    expect(await rejection(store.transaction(A, async () => 1))).toMatchObject({
      code: 'contention',
    });
  });
});

describe('insert, find, history and the child tables', () => {
  it('stores area, responsibles and history in one READ COMMITTED transaction and reads them back', async () => {
    const { db, store } = setup();
    const a = area(A, 'a1', { responsibleIds: ['u2', 'u1'] });
    await seed(store, a);
    expect(await store.find(A, 'a1')).toEqual({ ...a, responsibleIds: ['u1', 'u2'] });
    expect((await store.history(A, 'a1', { limit: 5, offset: 0 })).items).toEqual([entryOf(a)]);
    expect(db.isolations).toEqual(['READ COMMITTED']);
    expect(db.committed(AreaEntity)).toMatchObject([
      { tenantId: A, nameKey: 'area a1', parentKey: '', code: 'C-A1', depth: 1, active: true },
    ]);
    expect(
      db
        .committed(AreaResponsibleEntity)
        .map((row) => row['userId'])
        .sort(),
    ).toEqual(['u1', 'u2']);
    expect(db.committed(AreaLockEntity)).toEqual([{ tenantId: A }]);
    expect(db.committed(AuditLocalEventEntity)).toMatchObject([
      { tenantId: A, eventId: 'h-a1-1', entityType: 'area', entityId: 'a1' },
    ]);
    expect(db.committed(AuditDeliveryEntity)).toMatchObject([
      { tenantId: A, eventId: 'h-a1-1', status: 'pending' },
    ]);
  });
  it('keeps nothing of an insert whose later rows fail', async () => {
    const { db, store } = setup();
    const a = area(A, 'a1', { responsibleIds: ['u1'] });
    db.failNext('insert', CONNECTION_LOST, { entity: AreaHistoryEntity });
    expect(await rejection(seed(store, a))).toMatchObject({ code: 'unavailable' });
    expect(db.committed(AreaEntity)).toEqual([]);
    expect(db.committed(AreaResponsibleEntity)).toEqual([]);
    expect(db.committed(AuditLocalEventEntity)).toEqual([]);
    expect(db.committed(AuditDeliveryEntity)).toEqual([]);
    // The lock row created by the failed transaction is rolled back with it.
    expect(db.committed(AreaLockEntity)).toEqual([]);
  });
  it('refuses a history row or a parent that points at another tenant area (composite keys)', async () => {
    const { db, store } = setup();
    await seed(store, area(A, 'a1'));
    const foreignChild = area(B, 'b1', { parentId: 'a1', depth: 2 });
    expect(await rejection(seed(store, foreignChild))).toMatchObject({ code: 'integrity' });
    const mine = area(B, 'b2');
    const foreignHistory = { ...entryOf(mine), areaId: 'a1' };
    expect(
      await rejection(store.transaction(B, (tx) => tx.insert(mine, foreignHistory))),
    ).toMatchObject({ code: 'integrity' });
    expect(db.committed(AreaEntity)).toHaveLength(1);
  });
  it('never returns another tenant rows and filters every statement by company', async () => {
    const { db, store } = setup();
    const a = area(A, 'a1');
    const b = area(B, 'a1', { name: a.name, code: a.code });
    await seed(store, a, b);
    expect(await store.find(A, 'a1')).toMatchObject({ tenantId: A });
    expect(await store.find(B, 'a1')).toMatchObject({ tenantId: B });
    expect(await store.find('tenant-c', 'a1')).toBeNull();
    expect(
      (await store.list(A, { includeInactive: true }, { limit: 10, offset: 0 })).items,
    ).toEqual([a]);
    expect((await store.history('tenant-c', 'a1', { limit: 5, offset: 0 })).total).toBe(0);
    const seen = await store.transaction('tenant-c', async (tx) => ({
      find: await tx.find('a1'),
      children: await tx.children(null),
    }));
    expect(seen).toEqual({ find: null, children: [] });
    for (const statement of db.statements.filter((s) => s.where !== null))
      expect(statement.where, statement.operation).toHaveProperty('tenantId');
  });
  it('reports corrupt rows as integrity failures without exposing them', async () => {
    const { db, store, events } = setup();
    const a = area(A, 'a1');
    await seed(store, a);
    const history = db.committed(AreaHistoryEntity)[0] as Record<string, unknown>;
    for (const broken of [{ action: 'moved' }, { changedFields: 'name,colour' }]) {
      db.seed(AreaHistoryEntity, { ...history, ...broken });
      expect(await rejection(store.history(A, 'a1', { limit: 5, offset: 0 }))).toMatchObject({
        code: 'integrity',
      });
    }
    expect(events.map((event) => event.code)).toEqual(['integrity', 'integrity']);
  });
  it('round-trips the field list of a history row', async () => {
    const { store } = setup();
    const a = area(A, 'a1');
    await seed(store, a);
    const next = { ...a, version: 2, name: 'Otro' };
    const entry = {
      ...historyEntry(
        next,
        'updated',
        ['name', 'parent'],
        { from: null, to: 'p1' },
        'h2',
        ACTOR,
        NOW,
      ),
    };
    await store.transaction(A, (tx) => tx.replace(next, 1, entry));
    expect((await store.history(A, 'a1', { limit: 1, offset: 0 })).items).toEqual([entry]);
  });
});

describe('uniqueness', () => {
  it('names the colliding key and keeps nothing of the failed insert', async () => {
    const { db, store } = setup();
    await seed(store, area(A, 'a1', { name: 'Norte', code: 'N1' }));
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ name: 'NORTE', code: 'X' }, 'name'],
      [{ name: 'Sur', code: 'N1' }, 'code'],
    ];
    for (const [over, field] of cases) {
      const candidate = area(A, 'a2', { ...over, responsibleIds: ['u1'] });
      expect(await rejection(seed(store, candidate))).toEqual(
        new AreaError('duplicate', field as never),
      );
    }
    // Same id: duplicate without a field name.
    const same = area(A, 'a1', { name: 'Otro', code: 'Z' });
    const error = await rejection(seed(store, same));
    expect(error).toMatchObject({ code: 'duplicate' });
    expect((error as AreaError).field).toBeUndefined();
    expect(db.committed(AreaEntity)).toHaveLength(1);
    expect(db.committed(AreaHistoryEntity)).toHaveLength(1);
    expect(db.committed(AreaResponsibleEntity)).toHaveLength(0);
  });
  it('allows the same keys in another company, the same name under another parent, and many rows without a code', async () => {
    const { store } = setup();
    await seed(
      store,
      area(A, 'a1', { name: 'Base', code: 'C' }),
      area(B, 'a1', { name: 'Base', code: 'C' }),
      area(A, 'a2', { name: 'Raiz 2', code: null }),
      area(A, 'a3', { name: 'Base', code: null, parentId: 'a2', depth: 2 }),
      area(A, 'a4', { name: 'Otra', code: null }),
    );
    expect((await store.list(A, { includeInactive: true }, { limit: 10, offset: 0 })).total).toBe(
      4,
    );
  });
  it('maps a race on an update to a duplicate naming the key, and never against itself', async () => {
    const { db, store } = setup();
    await seed(
      store,
      area(A, 'a1', { name: 'Norte', code: 'N' }),
      area(A, 'a2', { name: 'Sur', code: 'S' }),
    );
    const two = (await store.find(A, 'a2')) as Area;
    const replace = (over: Record<string, unknown>) =>
      store.transaction(A, (tx) =>
        tx.replace({ ...two, version: 2, ...over }, 1, entryOf({ ...two, version: 2 })),
      );
    expect(await rejection(replace({ name: 'norte' }))).toEqual(new AreaError('duplicate', 'name'));
    expect(await rejection(replace({ code: 'N' }))).toEqual(new AreaError('duplicate', 'code'));
    expect((await store.find(A, 'a2'))?.version).toBe(1);
    expect(await replace({ responsibleIds: ['u1'] })).toBe(true);
    expect(db.committed(AreaEntity)).toHaveLength(2);
  });
  it('maps an unnamed duplicate (neither key is taken) to a plain duplicate', async () => {
    const { db, store } = setup();
    const a = area(A, 'a1');
    db.failNext('insert', DUPLICATE, { entity: AreaEntity });
    expect(await rejection(seed(store, a))).toEqual(new AreaError('duplicate'));
    await seed(store, a);
    db.failNext('update', DUPLICATE, { entity: AreaEntity });
    expect(
      await rejection(
        store.transaction(A, (tx) => tx.replace({ ...a, version: 2 }, 1, entryOf(a))),
      ),
    ).toEqual(new AreaError('duplicate'));
  });
  it('reports a driver duplicate outside writes as an unavailable store', async () => {
    const { db, store } = setup();
    db.failNext('find', DUPLICATE);
    expect(await rejection(store.find(A, 'a1'))).toMatchObject({
      code: 'unavailable',
      errno: 1062,
    });
  });
});

describe('replace (optimistic concurrency) and responsibles', () => {
  it('writes under the expected version, bumps it, diffs responsibles and appends history together', async () => {
    const { db, store } = setup();
    const a = area(A, 'a1', { responsibleIds: ['u1', 'u2'] });
    await seed(store, a);
    const next = { ...a, version: 2, name: 'Nuevo', responsibleIds: ['u2', 'u3'] };
    expect(await store.transaction(A, (tx) => tx.replace(next, 1, entryOf(next, 'updated')))).toBe(
      true,
    );
    expect(await store.find(A, 'a1')).toEqual(next);
    expect(
      db
        .committed(AreaResponsibleEntity)
        .map((row) => row['userId'])
        .sort(),
    ).toEqual(['u2', 'u3']);
    expect(
      (await store.history(A, 'a1', { limit: 5, offset: 0 })).items.map((e) => e.version),
    ).toEqual([2, 1]);
    // The statement set of an update that keeps the responsibles does not touch them.
    const before = db.statements.length;
    const again = { ...next, version: 3 };
    await store.transaction(A, (tx) => tx.replace(again, 2, entryOf(again)));
    expect(
      db.statements
        .slice(before)
        .filter((s) => s.table === 'opslog_area_responsibles' && s.operation !== 'find'),
    ).toEqual([]);
  });
  it('returns false for a stale version, an unknown id and another tenant, changing nothing', async () => {
    const { db, store } = setup();
    const a = area(A, 'a1');
    await seed(store, a);
    const before = db.committed(AreaEntity);
    const next = { ...a, version: 2, name: 'Otro' };
    const tryReplace = (tenant: string, candidate: Area, version: number) =>
      store.transaction(tenant, (tx) => tx.replace(candidate, version, entryOf(candidate)));
    expect(await tryReplace(A, next, 7)).toBe(false);
    expect(await tryReplace(A, { ...next, id: 'ghost' }, 1)).toBe(false);
    expect(await tryReplace(B, { ...next, tenantId: B }, 1)).toBe(false);
    expect(db.committed(AreaEntity)).toEqual(before);
    expect(db.committed(AreaHistoryEntity)).toHaveLength(1);
  });
  it('lets exactly one of two writers holding the same version win', async () => {
    const { store } = setup();
    const a = area(A, 'a1');
    await seed(store, a);
    const results = await Promise.all(
      ['Uno', 'Dos'].map((name) =>
        store.transaction(A, async (tx) => {
          const current = (await tx.find('a1')) as Area;
          const next = { ...current, version: 2, name };
          return tx.replace(next, 1, entryOf(next));
        }),
      ),
    );
    // Under the tenant lock the second one sees version 2, so its conditional write finds none.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.find(A, 'a1'))?.version).toBe(2);
  });
  it('rolls back the area change when the history row cannot be written', async () => {
    const { db, store } = setup();
    const a = area(A, 'a1', { responsibleIds: ['u1'] });
    await seed(store, a);
    const next = {
      ...a,
      version: 2,
      active: false,
      deactivatedAt: NOW.toISOString(),
      responsibleIds: ['u9'],
    };
    db.failNext('insert', CONNECTION_LOST, { entity: AreaHistoryEntity });
    expect(
      await rejection(store.transaction(A, (tx) => tx.replace(next, 1, entryOf(next)))),
    ).toMatchObject({ code: 'unavailable' });
    expect(await store.find(A, 'a1')).toEqual(a);
  });
  it('stores deactivation as an inactive row with its timestamp and hides it from default listings', async () => {
    const { store } = setup();
    const a = area(A, 'a1');
    await seed(store, a);
    const off = { ...a, version: 2, active: false, deactivatedAt: '2026-10-07T00:00:00.000Z' };
    expect(
      await store.transaction(A, (tx) => tx.replace(off, 1, entryOf(off, 'deactivated'))),
    ).toBe(true);
    expect(await store.find(A, 'a1')).toMatchObject({
      active: false,
      deactivatedAt: '2026-10-07T00:00:00.000Z',
    });
    expect((await store.list(A, { includeInactive: false }, { limit: 5, offset: 0 })).total).toBe(
      0,
    );
    expect((await store.list(A, { includeInactive: true }, { limit: 5, offset: 0 })).total).toBe(1);
  });
  it('rewrites the depth of a descendant without touching version or history', async () => {
    const { db, store } = setup();
    await seed(
      store,
      area(A, 'a1'),
      area(A, 'a2', { parentId: 'a1', depth: 2, name: 'Hija', code: null }),
    );
    await store.transaction(A, (tx) => tx.setDepth('a2', 3));
    expect(await store.find(A, 'a2')).toMatchObject({ depth: 3, version: 1 });
    expect(db.committed(AreaHistoryEntity)).toHaveLength(2);
    // Another tenant cannot reach it.
    await store.transaction(B, (tx) => tx.setDepth('a2', 4));
    expect((await store.find(A, 'a2'))?.depth).toBe(3);
  });
});

describe('tree reads and the tenant lock', () => {
  it('lists children of a parent and the roots, with status and depth', async () => {
    const { store } = setup();
    await seed(
      store,
      area(A, 'a1'),
      area(A, 'a2', { parentId: 'a1', depth: 2, name: 'Hija', code: null }),
      area(A, 'a3', {
        parentId: 'a1',
        depth: 2,
        name: 'Hija 2',
        code: null,
        active: false,
        deactivatedAt: NOW.toISOString(),
      }),
    );
    const view = await store.transaction(A, async (tx) => ({
      roots: await tx.children(null),
      children: await tx.children('a1'),
      leaf: await tx.children('a2'),
    }));
    expect(view.roots).toEqual([{ id: 'a1', depth: 1, active: true }]);
    expect(view.children.map((n) => [n.id, n.depth, n.active]).sort()).toEqual([
      ['a2', 2, true],
      ['a3', 2, false],
    ]);
    expect(view.leaf).toEqual([]);
  });
  it('lists by name then id, filters by parent and activity, windows with a total and loads responsibles', async () => {
    const { store } = setup();
    await seed(
      store,
      area(A, 'a1', { name: 'b', code: null, responsibleIds: ['u1'] }),
      area(A, 'a2', { name: 'A', code: null, active: false, deactivatedAt: NOW.toISOString() }),
      area(A, 'a3', {
        name: 'C',
        code: null,
        parentId: 'a1',
        depth: 2,
        responsibleIds: ['u2', 'u3'],
      }),
    );
    const ids = async (
      filter: Parameters<typeof store.list>[1],
      window = { limit: 10, offset: 0 },
    ) => (await store.list(A, filter, window)).items.map((a) => a.id);
    expect(await ids({ includeInactive: false })).toEqual(['a1', 'a3']);
    expect(await ids({ includeInactive: true })).toEqual(['a2', 'a1', 'a3']);
    expect(await ids({ includeInactive: true, parentId: null })).toEqual(['a2', 'a1']);
    expect(await ids({ includeInactive: true, parentId: 'a1' })).toEqual(['a3']);
    expect(await ids({ includeInactive: true }, { limit: 1, offset: 1 })).toEqual(['a1']);
    const all = await store.list(A, { includeInactive: true }, { limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((a) => a.responsibleIds)).toEqual([[], ['u1'], ['u2', 'u3']]);
    expect((await store.list(B, { includeInactive: true }, { limit: 5, offset: 0 })).items).toEqual(
      [],
    );
  });
  it('serializes transactions of one tenant on the lock row and lets other tenants proceed', async () => {
    const { db, store } = setup();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = store.transaction(A, async () => {
      order.push('a:start');
      await gate;
      order.push('a:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.transaction(A, async () => {
      order.push('a2:start');
    });
    const other = store.transaction(B, async () => {
      order.push('b:start');
    });
    await other;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(['a:start', 'b:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'b:start', 'a:end', 'a2:start']);
    expect(db.committed(AreaLockEntity)).toHaveLength(2);
  });
  it('creates the lock row once even when two first writers race', async () => {
    const { db, store } = setup();
    await Promise.all([
      store.transaction(A, async () => 1),
      store.transaction(A, async () => 2),
      store.transaction(A, async () => 3),
    ]);
    expect(db.committed(AreaLockEntity)).toEqual([{ tenantId: A }]);
  });
  it('recovers when another writer inserts the lock row first (duplicate on insert)', async () => {
    const { db, store } = setup();
    // The first lock select misses, the insert reports a duplicate, the second select finds the row.
    let first = true;
    db.intercept = (operation, table) => {
      if (first && operation === 'lock' && table === 'opslog_area_locks') {
        first = false;
        db.seed(AreaLockEntity, { tenantId: A });
        // Hide the row from this first select only by clearing it right after the statement.
        queueMicrotask(() => db.rows(AreaLockEntity).delete(A));
        queueMicrotask(() => db.seed(AreaLockEntity, { tenantId: A }));
      }
    };
    expect(await store.transaction(A, async () => 'ok')).toBe('ok');
  });
  it('fails closed when the lock row can neither be read nor created', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DUPLICATE, { entity: AreaLockEntity });
    expect(await rejection(store.transaction(A, async () => 1))).toMatchObject({
      code: 'internal',
    });
    expect(events).toEqual([{ operation: 'transaction', code: 'internal', errno: null }]);
  });
  it('propagates a non-duplicate failure while creating the lock row', async () => {
    const { db, store } = setup();
    db.failNext('insert', CONNECTION_LOST, { entity: AreaLockEntity });
    expect(await rejection(store.transaction(A, async () => 1))).toMatchObject({
      code: 'unavailable',
      errno: 2013,
    });
  });
  it('pages the history newest first', async () => {
    const { store } = setup();
    const a = area(A, 'a1');
    await seed(store, a);
    for (const version of [2, 3]) {
      const next = { ...a, version };
      await store.transaction(A, (tx) => tx.replace(next, version - 1, entryOf(next, 'updated')));
    }
    const first = await store.history(A, 'a1', { limit: 2, offset: 0 });
    expect(first.total).toBe(3);
    expect(first.items.map((e) => e.version)).toEqual([3, 2]);
    expect(
      (await store.history(A, 'a1', { limit: 2, offset: 2 })).items.map((e) => e.version),
    ).toEqual([1]);
  });
});

describe('failures', () => {
  it('retries deadlocks and lock timeouts, then succeeds', async () => {
    const { db, store, events } = setup();
    db.failNext('lock', DEADLOCK);
    db.failNext('lock', LOCK_TIMEOUT);
    await seed(store, area(A, 'a1'));
    expect(db.committed(AreaEntity)).toHaveLength(1);
    expect(db.transactions).toBe(3);
    expect(events).toEqual([]);
  });
  it('gives up after the attempt budget with a contention error', async () => {
    const { db, store, events } = setup();
    db.failNext('lock', DEADLOCK, { times: 5 });
    expect(await rejection(seed(store, area(A, 'a1')))).toMatchObject({
      code: 'contention',
      errno: 1213,
    });
    expect(db.transactions).toBe(3);
    expect(events).toEqual([{ operation: 'transaction', code: 'contention', errno: 1213 }]);
  });
  it('sanitizes driver errors: no name, code, tenant or SQL in the message, JSON or event', async () => {
    const { db, store, events } = setup();
    const a = area(A, 'a1', { name: 'Direccion Norte', code: 'SECRETO' });
    db.failNext('insert', CONNECTION_LOST, { entity: AreaEntity, leak: 'secret-tenant-a' });
    const error = await rejection(seed(store, a));
    expect(error).toBeInstanceOf(AreaStoreError);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(events)}`;
    for (const secret of [
      'secret-tenant-a',
      'Direccion Norte',
      'SECRETO',
      'INSERT INTO',
      'opslog_',
      'QueryFailedError',
    ])
      expect(text).not.toContain(secret);
    expect(events).toEqual([{ operation: 'transaction', code: 'unavailable', errno: 2013 }]);
  });
  it('classifies a non-driver failure as internal and never throws from the sanitizer', async () => {
    const { db, store, events } = setup();
    db.intercept = (operation) => {
      if (operation === 'find') throw new TypeError('boom with Direccion Norte');
    };
    const error = await rejection(store.find(A, 'a1'));
    expect(error).toMatchObject({ code: 'internal', errno: null });
    expect((error as Error).message).not.toContain('Direccion');
    expect(events).toEqual([{ operation: 'find', code: 'internal', errno: null }]);
  });
  it('lets a domain error thrown inside a transaction through untouched, with no event', async () => {
    const { store, events } = setup();
    expect(
      await rejection(
        store.transaction(A, async () => {
          throw new AreaError('invalid_hierarchy');
        }),
      ),
    ).toEqual(new AreaError('invalid_hierarchy'));
    expect(events).toEqual([]);
  });
  it('reports failed list and history reads without leaking', async () => {
    const { db, store } = setup();
    db.failNext('list', CONNECTION_LOST, { times: 2 });
    expect(
      await rejection(store.list(A, { includeInactive: true }, { limit: 1, offset: 0 })),
    ).toMatchObject({
      code: 'unavailable',
    });
    expect(await rejection(store.history(A, 'a1', { limit: 1, offset: 0 }))).toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('through the domain service', () => {
  it('runs the lifecycle over the store: tree rules, move with subtree, deactivation, isolation', async () => {
    const { store } = setup();
    let ids = 0;
    const svc = new AreaService(store, {
      now: () => NOW,
      newId: () => `id-${(ids += 1)}`,
      resources: { vehicles: NO_RESOURCES, people: NO_RESOURCES },
    });
    const root = await svc.create(A, ACTOR, { name: 'Pais', responsibleIds: ['u1'] });
    const city = await svc.create(A, ACTOR, { name: 'Ciudad', parentId: root.id });
    const base = await svc.create(A, ACTOR, { name: 'Base', parentId: city.id });
    await svc.create(B, ACTOR, { name: 'Pais' });
    const other = await svc.create(A, ACTOR, { name: 'Otra' });
    await svc.update(A, ACTOR, city.id, 1, { parentId: other.id, responsibleIds: ['u2'] });
    expect(await Promise.all([city.id, base.id].map((id) => svc.get(A, id)))).toMatchObject([
      { depth: 2, responsibleIds: ['u2'] },
      { depth: 3 },
    ]);
    await expect(svc.update(A, ACTOR, other.id, 1, { parentId: base.id })).rejects.toMatchObject({
      code: 'invalid_hierarchy',
    });
    await expect(svc.deactivate(A, ACTOR, other.id, 1)).rejects.toMatchObject({
      code: 'area_in_use',
      field: 'sub_areas',
    });
    await expect(svc.get(B, city.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await svc.history(A, city.id)).items.map((e) => e.action)).toEqual([
      'updated',
      'created',
    ]);
    expect((await svc.list(A)).total).toBe(4);
    expect((await svc.list(B)).total).toBe(1);
  });
});
