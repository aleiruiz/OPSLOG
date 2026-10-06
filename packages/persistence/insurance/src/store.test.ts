import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  PolicyService,
  revisionOf,
  type Policy,
  type PolicyFilter,
} from '../../../domain/insurance/src/index.js';
import { PolicyEntity, PolicyRevisionEntity } from './entities.js';
import { PolicyStoreError } from './errors.js';
import { TypeOrmPolicyStore, type StoreErrorEvent } from './store.js';
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

const policy = (tenant: string, id: string, over: Partial<Policy> = {}): Policy => ({
  id,
  tenantId: tenant,
  vehicleId: 'veh-1',
  insurer: 'Aseguradora Ficticia',
  coverageNotes: 'copia en archivo',
  revision: 1,
  policyNumber: 'POL-001',
  coverageType: 'comprehensive',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  deductible: { kind: 'amount', amountMinor: 500_000, currency: 'MXN' },
  version: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  archivedAt: null,
  ...over,
});
const bare = (tenant: string, id: string, over: Partial<Policy> = {}): Policy =>
  policy(tenant, id, { coverageNotes: null, deductible: null, ...over });
const revision = (p: Policy) => revisionOf(p, ACTOR, NOW);

function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmPolicyStore(asDataSource(db), {
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
const all: PolicyFilter = { includeArchived: true };

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) => new TypeOrmPolicyStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted insurance account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_insurance_x' })).toThrow(/MySQL/);
    expect(() =>
      build({ type: 'mysql', username: 'opslog_insurance_x', synchronize: true }),
    ).toThrow(/synchronize/);
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_documents_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_insurance_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store } = setup({ maxAttempts: 0 });
    db.failNext('insert', DEADLOCK, { entity: PolicyEntity });
    const p = policy(A, 'p1');
    expect(await rejection(store.insert(p, revision(p)))).toMatchObject({ code: 'contention' });
  });
});

describe('insert, find and revisions', () => {
  it('stores the policy and its first revision in one transaction and reads them back', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    expect(await store.find(A, 'p1')).toEqual(p);
    expect((await store.revisions(A, 'p1', window)).items).toEqual([revision(p)]);
    expect(db.isolations).toEqual(['READ COMMITTED']);
    expect(db.committed(PolicyEntity)[0]).toMatchObject({
      tenantId: A,
      vehicleId: 'veh-1',
      deductibleKind: 'amount',
      deductibleValue: 500_000,
      deductibleCurrency: 'MXN',
    });
  });

  it('stores a percentage and no deductible in the typed columns', async () => {
    const { db, store } = setup();
    const pct = policy(A, 'p1', { deductible: { kind: 'percent', basisPoints: 1500 } });
    const none = bare(A, 'p2');
    await store.insert(pct, revision(pct));
    await store.insert(none, revision(none));
    expect(await store.find(A, 'p1')).toEqual(pct);
    expect(await store.find(A, 'p2')).toEqual(none);
    expect(
      db
        .committed(PolicyEntity)
        .map((r) => [r['deductibleKind'], r['deductibleValue'], r['deductibleCurrency']]),
    ).toEqual([
      ['percent', 1500, null],
      [null, null, null],
    ]);
  });

  it('reads a BIGINT value returned by the driver as a string', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const row = db.committed(PolicyEntity)[0] as Record<string, unknown>;
    db.seed(PolicyEntity, { ...row, deductibleValue: '500000' });
    expect((await store.find(A, 'p1'))?.deductible).toEqual({
      kind: 'amount',
      amountMinor: 500_000,
      currency: 'MXN',
    });
  });

  it('does not keep a policy whose revision cannot be written', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    db.failNext('insert', CONNECTION_LOST, { entity: PolicyRevisionEntity });
    expect(await rejection(store.insert(p, revision(p)))).toMatchObject({ code: 'unavailable' });
    expect(db.committed(PolicyEntity)).toEqual([]);
  });

  it('refuses a revision that points at another tenant policy (composite key)', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const other = policy(B, 'p9');
    const foreign = { ...revision(other), policyId: 'p1' };
    expect(await rejection(store.insert(other, foreign))).toMatchObject({ code: 'integrity' });
    expect(db.committed(PolicyEntity)).toHaveLength(1);
  });

  it('refuses a duplicate primary key', async () => {
    const { store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    expect(await rejection(store.insert(p, revision(p)))).toBeInstanceOf(PolicyStoreError);
  });

  it('never returns another tenant rows and filters every statement by company', async () => {
    const { db, store } = setup();
    const a = policy(A, 'p1');
    const b = policy(B, 'p1', { insurer: 'Ajena Ficticia' });
    await store.insert(a, revision(a));
    await store.insert(b, revision(b));
    expect(await store.find(A, 'p1')).toMatchObject({
      tenantId: A,
      insurer: 'Aseguradora Ficticia',
    });
    expect(await store.find(B, 'p1')).toMatchObject({ tenantId: B, insurer: 'Ajena Ficticia' });
    expect(await store.find('tenant-c', 'p1')).toBeNull();
    expect((await store.list(A, all, window)).items).toEqual([a]);
    expect((await store.revisions('tenant-c', 'p1', window)).items).toEqual([]);
    expect((await store.revisions(B, 'p1', window)).items).toEqual([revision(b)]);
    await store.replace({ ...a, version: 2, insurer: 'Cambiada Ficticia' }, 1);
    expect((await store.find(B, 'p1'))?.insurer).toBe('Ajena Ficticia');
    for (const statement of db.statements.filter((s) => s.where !== null))
      expect(statement.where, statement.operation).toHaveProperty('tenantId');
  });

  it('pages the revisions newest first with a total', async () => {
    const { store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const second = { ...p, revision: 2, version: 2, endsOn: '2027-12-31' };
    await store.replace(second, 1, revision(second));
    const third = { ...second, revision: 3, version: 3, endsOn: '2028-12-31' };
    await store.replace(third, 2, revision(third));
    const page = await store.revisions(A, 'p1', { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items.map((r) => [r.revision, r.endsOn])).toEqual([
      [3, '2028-12-31'],
      [2, '2027-12-31'],
    ]);
    expect(
      (await store.revisions(A, 'p1', { limit: 2, offset: 2 })).items.map((r) => r.revision),
    ).toEqual([1]);
  });

  it('reports corrupt rows as integrity failures without exposing them', async () => {
    const { db, store, events } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const row = db.committed(PolicyEntity)[0] as Record<string, unknown>;
    const revisionRow = db.committed(PolicyRevisionEntity)[0] as Record<string, unknown>;
    for (const broken of [
      { coverageType: 'nope' },
      { deductibleKind: 'other' },
      { deductibleKind: 'amount', deductibleCurrency: null },
      { deductibleKind: 'percent' }, // percentage with a currency
      { deductibleValue: null },
      { deductibleValue: 'abc' },
      { deductibleKind: null }, // value without a kind
      { deductibleKind: null, deductibleValue: null }, // currency without a kind
    ]) {
      db.seed(PolicyEntity, { ...row, ...broken });
      expect(await rejection(store.find(A, 'p1')), JSON.stringify(broken)).toMatchObject({
        code: 'integrity',
      });
    }
    db.seed(PolicyRevisionEntity, { ...revisionRow, coverageType: 'nope' });
    expect(await rejection(store.revisions(A, 'p1', window))).toMatchObject({ code: 'integrity' });
    expect(events.every((event) => event.code === 'integrity')).toBe(true);
    expect(events).toHaveLength(9);
  });
});

describe('list', () => {
  async function seeded() {
    const ctx = setup();
    const rows = [
      policy(A, 'p1', { endsOn: '2026-12-01', vehicleId: 'veh-1' }),
      policy(A, 'p2', { endsOn: '2026-10-01', vehicleId: 'veh-2', coverageType: 'third_party' }),
      bare(A, 'p3', { startsOn: '2027-01-01', endsOn: '2027-12-31' }),
      policy(A, 'p4', { endsOn: '2026-10-20', vehicleId: 'veh-1' }),
      bare(A, 'p5', { vehicleId: 'veh-2', endsOn: '2026-10-06' }),
      policy(A, 'p6', { endsOn: '2026-11-05' }),
      policy(A, 'p7', { endsOn: '2026-11-06', archivedAt: NOW.toISOString() }),
      policy(B, 'p8', { endsOn: '2026-10-01' }),
    ];
    for (const p of rows) await ctx.store.insert(p, revision(p));
    return ctx;
  }
  const ids = async (store: TypeOrmPolicyStore, filter: PolicyFilter, tenant = A) =>
    (await store.list(tenant, filter, window)).items.map((p) => p.id);

  it('orders by end date then id, hides archived by default and windows with a total', async () => {
    const { store } = await seeded();
    expect(await ids(store, { includeArchived: false })).toEqual([
      'p2',
      'p5',
      'p4',
      'p6',
      'p1',
      'p3',
    ]);
    expect(await ids(store, all)).toEqual(['p2', 'p5', 'p4', 'p6', 'p7', 'p1', 'p3']);
    const page = await store.list(A, all, { limit: 2, offset: 2 });
    expect(page.items.map((p) => p.id)).toEqual(['p4', 'p6']);
    expect(page.total).toBe(7);
    expect(await ids(store, all, B)).toEqual(['p8']);
    expect(await ids(store, all, 'tenant-c')).toEqual([]);
  });

  it('filters by vehicle and by coverage type', async () => {
    const { store } = await seeded();
    expect(await ids(store, { includeArchived: false, vehicleId: 'veh-1' })).toEqual([
      'p4',
      'p6',
      'p1',
      'p3',
    ]);
    expect(await ids(store, { includeArchived: false, vehicleId: 'veh-2' })).toEqual(['p2', 'p5']);
    expect(await ids(store, { includeArchived: false, coverageType: 'third_party' })).toEqual([
      'p2',
    ]);
  });

  it('filters by derived status with the same boundaries as the domain', async () => {
    const { store } = await seeded();
    const filter = (status: 'valid' | 'expiring' | 'expired') => ({
      includeArchived: true,
      expiry: { status, from: '2026-10-06', until: '2026-11-05' },
    });
    expect(await ids(store, filter('expired'))).toEqual(['p2']);
    // last day inclusive on both ends of the window: 2026-10-06 and 2026-11-05
    expect(await ids(store, filter('expiring'))).toEqual(['p5', 'p4', 'p6']);
    expect(await ids(store, filter('valid'))).toEqual(['p7', 'p1', 'p3']);
  });

  it('filters by the policies covering a day, both ends inclusive, alone and with a status', async () => {
    const { store } = await seeded();
    expect(await ids(store, { includeArchived: false, coversOn: '2026-10-06' })).toEqual([
      'p5',
      'p4',
      'p6',
      'p1',
    ]);
    expect(await ids(store, { includeArchived: false, coversOn: '2026-10-07' })).toEqual([
      'p4',
      'p6',
      'p1',
    ]);
    expect(await ids(store, { includeArchived: false, coversOn: '2026-12-31' })).toEqual([]);
    expect(await ids(store, { includeArchived: false, coversOn: '2027-01-01' })).toEqual(['p3']);
    expect(await ids(store, { includeArchived: false, coversOn: '2025-12-31' })).toEqual([]);
    expect(
      await ids(store, {
        includeArchived: false,
        coversOn: '2026-10-06',
        expiry: { status: 'expiring', from: '2026-10-06', until: '2026-11-05' },
      }),
    ).toEqual(['p5', 'p4', 'p6']);
    expect(
      await ids(store, {
        includeArchived: false,
        coversOn: '2026-10-21',
        expiry: { status: 'expiring', from: '2026-10-06', until: '2026-11-05' },
      }),
    ).toEqual(['p6']);
  });
});

describe('replace (optimistic concurrency)', () => {
  it('writes under the expected version, bumps it and appends the revision together', async () => {
    const { store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const next = {
      ...p,
      revision: 2,
      version: 2,
      endsOn: '2027-12-31',
      deductible: null,
      updatedAt: '2026-10-07T00:00:00.000Z',
    };
    expect(await store.replace(next, 1, revision(next))).toBe(true);
    expect(await store.find(A, 'p1')).toEqual(next);
    expect((await store.revisions(A, 'p1', window)).total).toBe(2);
    const edited = { ...next, version: 3, insurer: 'Otra Ficticia', coverageNotes: null };
    expect(await store.replace(edited, 2)).toBe(true);
    expect((await store.revisions(A, 'p1', window)).total).toBe(2);
    expect(await store.find(A, 'p1')).toMatchObject({
      insurer: 'Otra Ficticia',
      coverageNotes: null,
      revision: 2,
    });
  });

  it('keeps the earlier revision rows untouched when a renewal is written', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const before = db.committed(PolicyRevisionEntity);
    const next = { ...p, revision: 2, version: 2, endsOn: '2027-12-31', deductible: null };
    await store.replace(next, 1, revision(next));
    expect(db.committed(PolicyRevisionEntity).filter((r) => r['revision'] === 1)).toEqual(before);
    expect(
      db.statements
        .filter((s) => s.table === 'opslog_insurance_policy_revisions')
        .map((s) => s.operation),
    ).not.toContain('update');
  });

  it('returns false for a stale version, an unknown id and another tenant, changing nothing', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const next = { ...p, revision: 2, version: 2 };
    expect(await store.replace(next, 5, revision(next))).toBe(false);
    expect(await store.replace({ ...next, id: 'nope' }, 1, revision({ ...next, id: 'nope' }))).toBe(
      false,
    );
    expect(
      await store.replace({ ...next, tenantId: B }, 1, revision({ ...next, tenantId: B })),
    ).toBe(false);
    expect(db.committed(PolicyRevisionEntity)).toHaveLength(1);
    expect(await store.find(A, 'p1')).toEqual(p);
  });

  it('lets exactly one of two writers holding the same version win', async () => {
    const { store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const one = { ...p, version: 2, insurer: 'Uno Ficticia' };
    const two = { ...p, version: 2, insurer: 'Dos Ficticia' };
    const results = await Promise.all([store.replace(one, 1), store.replace(two, 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rolls back the policy change when the revision row cannot be written', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const next = { ...p, revision: 2, version: 2, insurer: 'Nuevo Ficticio' };
    db.failNext('insert', DUPLICATE, { entity: PolicyRevisionEntity });
    expect(await rejection(store.replace(next, 1, revision(next)))).toBeInstanceOf(
      PolicyStoreError,
    );
    expect(await store.find(A, 'p1')).toEqual(p);
  });

  it('archives by writing the timestamp and hides the policy from default listings', async () => {
    const { store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const archived = { ...p, version: 2, archivedAt: '2026-10-07T00:00:00.000Z' };
    expect(await store.replace(archived, 1)).toBe(true);
    expect((await store.list(A, { includeArchived: false }, window)).items).toEqual([]);
    expect((await store.list(A, all, window)).items).toEqual([archived]);
  });

  it('never changes the vehicle, tenant, id or creation time', async () => {
    const { db, store } = setup();
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    const before = db.committed(PolicyEntity)[0];
    await store.replace(
      { ...p, version: 2, vehicleId: 'veh-9', createdAt: '2000-01-01T00:00:00.000Z' },
      1,
    );
    expect(db.committed(PolicyEntity)[0]).toMatchObject({
      vehicleId: before?.['vehicleId'],
      createdAt: before?.['createdAt'],
    });
  });
});

describe('failures', () => {
  it('retries deadlocks and lock timeouts, then succeeds', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: PolicyEntity });
    db.failNext('insert', LOCK_TIMEOUT, { entity: PolicyEntity });
    const p = policy(A, 'p1');
    await store.insert(p, revision(p));
    expect(db.committed(PolicyEntity)).toHaveLength(1);
    expect(db.transactions).toBe(3);
    expect(events).toEqual([]);
  });

  it('gives up after the attempt budget with a contention error', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: PolicyEntity, times: 5 });
    const p = policy(A, 'p1');
    expect(await rejection(store.insert(p, revision(p)))).toMatchObject({
      code: 'contention',
      errno: 1213,
    });
    expect(db.transactions).toBe(3);
    expect(events).toEqual([{ operation: 'insert', code: 'contention', errno: 1213 }]);
  });

  it('sanitizes driver errors: no insurer, number, tenant or SQL in the message, JSON or event', async () => {
    const { db, store, events } = setup();
    const p = policy(A, 'p1', {
      insurer: 'Aseguradora-ficticia-prueba',
      policyNumber: 'POL-FICTICIA-PRUEBA',
    });
    db.failNext('insert', CONNECTION_LOST, { entity: PolicyEntity, leak: 'ficticio-tenant-uno' });
    const error = await rejection(store.insert(p, revision(p)));
    expect(error).toBeInstanceOf(PolicyStoreError);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(events)}`;
    for (const fragment of [
      'ficticio-tenant-uno',
      'Aseguradora-ficticia-prueba',
      'POL-FICTICIA-PRUEBA',
      'INSERT INTO',
      'opslog_',
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
    const store = new TypeOrmPolicyStore(asDataSource(db));
    db.failNext('find', CONNECTION_LOST);
    expect(await rejection(store.find(A, 'p1'))).toMatchObject({ code: 'unavailable' });
  });
});

describe('through the domain service', () => {
  it('runs the full lifecycle over the store and isolates tenants', async () => {
    const { store } = setup();
    let ids = 0;
    const svc = new PolicyService(store, { now: () => NOW, newId: () => `pol-${(ids += 1)}` });
    const created = await svc.create(A, ACTOR, {
      vehicleId: 'veh-1',
      insurer: 'Aseguradora Ficticia',
      policyNumber: 'pol-1',
      coverageType: 'comprehensive',
      startsOn: '2026-01-01',
      endsOn: '2026-10-20',
      deductible: { kind: 'percent', basisPoints: 1000 },
    });
    expect(svc.expiry(created).status).toBe('expiring');
    const renewed = await svc.renew(A, ACTOR, created.id, 1, {
      startsOn: '2026-10-21',
      endsOn: '2027-10-20',
    });
    expect(renewed).toMatchObject({
      revision: 2,
      version: 2,
      deductible: { kind: 'percent', basisPoints: 1000 },
    });
    expect((await svc.history(A, created.id)).items.map((r) => r.status)).toEqual([
      'valid',
      'replaced',
    ]);
    await expect(svc.get(B, created.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await svc.list(A, { status: 'valid' })).total).toBe(1);
    expect((await svc.list(A, { status: 'expiring' })).total).toBe(0);
    expect((await svc.list(A, { coversOn: '2026-10-06' })).total).toBe(0);
    await svc.archive(A, created.id, 2);
    expect((await svc.list(A)).total).toBe(0);
    await expect(svc.update(A, created.id, 3, { insurer: 'Otra Ficticia' })).rejects.toMatchObject({
      code: 'immutable',
    });
  });
});
