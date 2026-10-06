import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  DocumentService,
  revisionOf,
  type Document,
  type DocumentFilter,
} from '../../../domain/documents/src/index.js';
import { DocumentEntity, DocumentRevisionEntity } from './entities.js';
import { DocumentStoreError } from './errors.js';
import { TypeOrmDocumentStore, type StoreErrorEvent } from './store.js';
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

const document = (tenant: string, id: string, over: Partial<Document> = {}): Document => ({
  id,
  tenantId: tenant,
  ownerType: 'vehicle',
  ownerId: 'veh-1',
  typeCode: 'registration_card',
  title: 'Tarjeta de circulación',
  notes: 'original en archivo',
  revision: 1,
  issuedOn: '2025-03-31',
  expiresOn: '2027-03-31',
  documentNumber: 'TC-001',
  version: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  archivedAt: null,
  ...over,
});
const bare = (tenant: string, id: string, over: Partial<Document> = {}): Document =>
  document(tenant, id, {
    ownerType: 'employee',
    ownerId: 'emp-1',
    typeCode: 'training_certificate',
    notes: null,
    issuedOn: null,
    expiresOn: null,
    documentNumber: null,
    ...over,
  });
const revision = (d: Document) => revisionOf(d, ACTOR, NOW);

function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmDocumentStore(asDataSource(db), {
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
const all: DocumentFilter = { includeArchived: true };

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) =>
    new TypeOrmDocumentStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted documents account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_documents_x' })).toThrow(/MySQL/);
    expect(() =>
      build({ type: 'mysql', username: 'opslog_documents_x', synchronize: true }),
    ).toThrow(/synchronize/);
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_employees_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_documents_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store } = setup({ maxAttempts: 0 });
    db.failNext('insert', DEADLOCK, { entity: DocumentEntity });
    const d = document(A, 'd1');
    expect(await rejection(store.insert(d, revision(d)))).toMatchObject({ code: 'contention' });
  });
});

describe('insert, find and revisions', () => {
  it('stores the document and its first revision in one transaction and reads them back', async () => {
    const { db, store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    expect(await store.find(A, 'd1')).toEqual(d);
    expect((await store.revisions(A, 'd1', window)).items).toEqual([revision(d)]);
    expect(db.isolations).toEqual(['READ COMMITTED']);
    expect(db.committed(DocumentEntity)[0]).toMatchObject({
      tenantId: A,
      ownerType: 'vehicle',
      vehicleId: 'veh-1',
      employeeId: null,
      expiryKey: '2027-03-31',
    });
  });

  it('keeps the owner in the typed column of its type and the sort key of a document without expiry', async () => {
    const { db, store } = setup();
    const d = bare(A, 'd1');
    await store.insert(d, revision(d));
    expect(await store.find(A, 'd1')).toEqual(d);
    expect(db.committed(DocumentEntity)[0]).toMatchObject({
      vehicleId: null,
      employeeId: 'emp-1',
      expiresOn: null,
      expiryKey: '9999-12-31',
      notes: null,
    });
  });

  it('does not keep a document whose revision cannot be written', async () => {
    const { db, store } = setup();
    const d = document(A, 'd1');
    db.failNext('insert', CONNECTION_LOST, { entity: DocumentRevisionEntity });
    expect(await rejection(store.insert(d, revision(d)))).toMatchObject({ code: 'unavailable' });
    expect(db.committed(DocumentEntity)).toEqual([]);
  });

  it('refuses a revision that points at another tenant document (composite key)', async () => {
    const { db, store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const other = document(B, 'd9');
    const foreign = { ...revision(other), documentId: 'd1' };
    expect(await rejection(store.insert(other, foreign))).toMatchObject({ code: 'integrity' });
    expect(db.committed(DocumentEntity)).toHaveLength(1);
  });

  it('refuses a duplicate primary key', async () => {
    const { store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    expect(await rejection(store.insert(d, revision(d)))).toBeInstanceOf(DocumentStoreError);
  });

  it('never returns another tenant rows and filters every statement by company', async () => {
    const { db, store } = setup();
    const a = document(A, 'd1');
    const b = document(B, 'd1', { title: 'Ajena' });
    await store.insert(a, revision(a));
    await store.insert(b, revision(b));
    expect(await store.find(A, 'd1')).toMatchObject({
      tenantId: A,
      title: 'Tarjeta de circulación',
    });
    expect(await store.find(B, 'd1')).toMatchObject({ tenantId: B, title: 'Ajena' });
    expect(await store.find('tenant-c', 'd1')).toBeNull();
    expect((await store.list(A, all, window)).items).toEqual([a]);
    expect((await store.revisions('tenant-c', 'd1', window)).items).toEqual([]);
    expect((await store.revisions(B, 'd1', window)).items).toEqual([revision(b)]);
    await store.replace({ ...a, version: 2, title: 'Cambiada' }, 1);
    expect((await store.find(B, 'd1'))?.title).toBe('Ajena');
    for (const statement of db.statements.filter((s) => s.where !== null))
      expect(statement.where, statement.operation).toHaveProperty('tenantId');
  });

  it('pages the revisions newest first with a total', async () => {
    const { store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const second = { ...d, revision: 2, version: 2, expiresOn: '2028-03-31' };
    await store.replace(second, 1, revision(second));
    const third = { ...second, revision: 3, version: 3, expiresOn: '2029-03-31' };
    await store.replace(third, 2, revision(third));
    const page = await store.revisions(A, 'd1', { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items.map((r) => [r.revision, r.expiresOn])).toEqual([
      [3, '2029-03-31'],
      [2, '2028-03-31'],
    ]);
    expect(
      (await store.revisions(A, 'd1', { limit: 2, offset: 2 })).items.map((r) => r.revision),
    ).toEqual([1]);
  });

  it('reports corrupt rows as integrity failures without exposing them', async () => {
    const { db, store, events } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const row = db.committed(DocumentEntity)[0] as Record<string, unknown>;
    for (const broken of [
      { ownerType: 'policy' },
      { employeeId: 'emp-1' }, // two owners
      { vehicleId: null }, // no owner
      { ownerType: 'employee', vehicleId: null, employeeId: 'emp-1' }, // type of another owner
      { typeCode: 'nope' },
      { expiryKey: '2000-01-01' },
    ]) {
      db.seed(DocumentEntity, { ...row, ...broken });
      expect(await rejection(store.find(A, 'd1'))).toMatchObject({ code: 'integrity' });
    }
    expect(events.every((event) => event.code === 'integrity')).toBe(true);
    expect(events).toHaveLength(6);
  });
});

describe('list', () => {
  async function seeded() {
    const ctx = setup();
    const docs = [
      document(A, 'd1', { expiresOn: '2026-12-01', ownerId: 'veh-1' }),
      document(A, 'd2', {
        expiresOn: '2026-10-01',
        ownerId: 'veh-2',
        typeCode: 'transport_permit',
      }),
      bare(A, 'd3', { ownerId: 'emp-1' }),
      document(A, 'd4', { expiresOn: '2026-10-20', ownerId: 'veh-1' }),
      bare(A, 'd5', { ownerId: 'emp-2', typeCode: 'medical_exam', expiresOn: '2026-10-06' }),
      document(A, 'd6', { expiresOn: '2026-11-05' }),
      document(A, 'd7', { expiresOn: '2026-11-06', archivedAt: NOW.toISOString() }),
      document(B, 'd8', { expiresOn: '2026-10-01' }),
    ];
    for (const d of docs) await ctx.store.insert(d, revision(d));
    return ctx;
  }
  const ids = async (store: TypeOrmDocumentStore, filter: DocumentFilter, tenant = A) =>
    (await store.list(tenant, filter, window)).items.map((d) => d.id);

  it('orders by expiry (none last) then id, hides archived by default and windows with a total', async () => {
    const { store } = await seeded();
    expect(await ids(store, { includeArchived: false })).toEqual([
      'd2',
      'd5',
      'd4',
      'd6',
      'd1',
      'd3',
    ]);
    expect(await ids(store, all)).toEqual(['d2', 'd5', 'd4', 'd6', 'd7', 'd1', 'd3']);
    const page = await store.list(A, all, { limit: 2, offset: 2 });
    expect(page.items.map((d) => d.id)).toEqual(['d4', 'd6']);
    expect(page.total).toBe(7);
    expect(await ids(store, all, B)).toEqual(['d8']);
    expect(await ids(store, all, 'tenant-c')).toEqual([]);
  });

  it('filters by owner type and id, in the column of the type', async () => {
    const { store } = await seeded();
    expect(await ids(store, { includeArchived: false, ownerType: 'employee' })).toEqual([
      'd5',
      'd3',
    ]);
    expect(
      await ids(store, { includeArchived: false, ownerType: 'vehicle', ownerId: 'veh-1' }),
    ).toEqual(['d4', 'd6', 'd1']);
    expect(
      await ids(store, { includeArchived: false, ownerType: 'employee', ownerId: 'emp-2' }),
    ).toEqual(['d5']);
    expect(
      await ids(store, { includeArchived: false, ownerType: 'employee', ownerId: 'veh-1' }),
    ).toEqual([]);
    expect(
      await rejection(store.list(A, { includeArchived: false, ownerId: 'veh-1' }, window)),
    ).toMatchObject({
      code: 'internal',
    });
  });

  it('filters by type code', async () => {
    const { store } = await seeded();
    expect(await ids(store, { includeArchived: false, typeCode: 'transport_permit' })).toEqual([
      'd2',
    ]);
  });

  it('filters by derived status with the same boundaries as the domain', async () => {
    const { store } = await seeded();
    const filter = (status: 'valid' | 'expiring' | 'expired') => ({
      includeArchived: true,
      expiry: { status, from: '2026-10-06', until: '2026-11-05' },
    });
    expect(await ids(store, filter('expired'))).toEqual(['d2']);
    // last day inclusive on both ends of the window: 2026-10-06 and 2026-11-05
    expect(await ids(store, filter('expiring'))).toEqual(['d5', 'd4', 'd6']);
    expect(await ids(store, filter('valid'))).toEqual(['d7', 'd1', 'd3']);
  });
});

describe('replace (optimistic concurrency)', () => {
  it('writes under the expected version, bumps it and appends the revision together', async () => {
    const { store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const next = {
      ...d,
      revision: 2,
      version: 2,
      expiresOn: '2028-03-31',
      updatedAt: '2026-10-07T00:00:00.000Z',
    };
    expect(await store.replace(next, 1, revision(next))).toBe(true);
    expect(await store.find(A, 'd1')).toEqual(next);
    expect((await store.revisions(A, 'd1', window)).total).toBe(2);
    const edited = { ...next, version: 3, title: 'Otra', notes: null };
    expect(await store.replace(edited, 2)).toBe(true);
    expect((await store.revisions(A, 'd1', window)).total).toBe(2);
    expect(await store.find(A, 'd1')).toMatchObject({ title: 'Otra', notes: null, revision: 2 });
  });

  it('keeps the earlier revision rows untouched when a renewal is written', async () => {
    const { db, store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const before = db.committed(DocumentRevisionEntity);
    const next = { ...d, revision: 2, version: 2, expiresOn: '2028-03-31' };
    await store.replace(next, 1, revision(next));
    expect(db.committed(DocumentRevisionEntity).filter((r) => r['revision'] === 1)).toEqual(before);
    expect(
      db.statements.filter((s) => s.table === 'opslog_document_revisions').map((s) => s.operation),
    ).not.toContain('update');
  });

  it('returns false for a stale version, an unknown id and another tenant, changing nothing', async () => {
    const { db, store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const next = { ...d, revision: 2, version: 2 };
    expect(await store.replace(next, 5, revision(next))).toBe(false);
    expect(await store.replace({ ...next, id: 'nope' }, 1, revision({ ...next, id: 'nope' }))).toBe(
      false,
    );
    expect(
      await store.replace({ ...next, tenantId: B }, 1, revision({ ...next, tenantId: B })),
    ).toBe(false);
    expect(db.committed(DocumentRevisionEntity)).toHaveLength(1);
    expect(await store.find(A, 'd1')).toEqual(d);
  });

  it('lets exactly one of two writers holding the same version win', async () => {
    const { store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const one = { ...d, version: 2, title: 'Uno' };
    const two = { ...d, version: 2, title: 'Dos' };
    const results = await Promise.all([store.replace(one, 1), store.replace(two, 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rolls back the document change when the revision row cannot be written', async () => {
    const { db, store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const next = { ...d, revision: 2, version: 2, title: 'Nuevo' };
    db.failNext('insert', DUPLICATE, { entity: DocumentRevisionEntity });
    expect(await rejection(store.replace(next, 1, revision(next)))).toBeInstanceOf(
      DocumentStoreError,
    );
    expect(await store.find(A, 'd1')).toEqual(d);
  });

  it('archives by writing the timestamp and hides the document from default listings', async () => {
    const { store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const archived = { ...d, version: 2, archivedAt: '2026-10-07T00:00:00.000Z' };
    expect(await store.replace(archived, 1)).toBe(true);
    expect((await store.list(A, { includeArchived: false }, window)).items).toEqual([]);
    expect((await store.list(A, all, window)).items).toEqual([archived]);
  });

  it('never changes the owner, type, tenant, id or creation time', async () => {
    const { db, store } = setup();
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    const before = db.committed(DocumentEntity)[0];
    await store.replace(
      {
        ...d,
        version: 2,
        ownerType: 'employee',
        ownerId: 'emp-9',
        typeCode: 'other',
        createdAt: '2000-01-01T00:00:00.000Z',
      },
      1,
    );
    expect(db.committed(DocumentEntity)[0]).toMatchObject({
      ownerType: before?.['ownerType'],
      vehicleId: before?.['vehicleId'],
      employeeId: before?.['employeeId'],
      typeCode: before?.['typeCode'],
      createdAt: before?.['createdAt'],
    });
  });
});

describe('failures', () => {
  it('retries deadlocks and lock timeouts, then succeeds', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: DocumentEntity });
    db.failNext('insert', LOCK_TIMEOUT, { entity: DocumentEntity });
    const d = document(A, 'd1');
    await store.insert(d, revision(d));
    expect(db.committed(DocumentEntity)).toHaveLength(1);
    expect(db.transactions).toBe(3);
    expect(events).toEqual([]);
  });

  it('gives up after the attempt budget with a contention error', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: DocumentEntity, times: 5 });
    const d = document(A, 'd1');
    expect(await rejection(store.insert(d, revision(d)))).toMatchObject({
      code: 'contention',
      errno: 1213,
    });
    expect(db.transactions).toBe(3);
    expect(events).toEqual([{ operation: 'insert', code: 'contention', errno: 1213 }]);
  });

  it('sanitizes driver errors: no title, number, tenant or SQL in the message, JSON or event', async () => {
    const { db, store, events } = setup();
    const d = document(A, 'd1', { title: 'Titulo-secreto-77', documentNumber: 'NUM-SECRETO-88' });
    db.failNext('insert', CONNECTION_LOST, { entity: DocumentEntity, leak: 'secret-tenant-a' });
    const error = await rejection(store.insert(d, revision(d)));
    expect(error).toBeInstanceOf(DocumentStoreError);
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${JSON.stringify(events)}`;
    for (const secret of [
      'secret-tenant-a',
      'Titulo-secreto-77',
      'NUM-SECRETO-88',
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
    const error = await rejection(store.find(A, 'd1'));
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
    expect(await rejection(store.find(A, 'd1'))).toMatchObject({ code: 'internal' });
  });

  it('works without an error callback', async () => {
    const db = new FakeDatabase();
    const store = new TypeOrmDocumentStore(asDataSource(db));
    db.failNext('find', CONNECTION_LOST);
    expect(await rejection(store.find(A, 'd1'))).toMatchObject({ code: 'unavailable' });
  });
});

describe('through the domain service', () => {
  it('runs the full lifecycle over the store and isolates tenants', async () => {
    const { store } = setup();
    let ids = 0;
    const svc = new DocumentService(store, { now: () => NOW, newId: () => `doc-${(ids += 1)}` });
    const created = await svc.create(A, ACTOR, {
      ownerType: 'vehicle',
      ownerId: 'veh-1',
      typeCode: 'registration_card',
      title: 'Tarjeta',
      expiresOn: '2026-10-20',
    });
    expect(svc.expiry(created).status).toBe('expiring');
    const renewed = await svc.renew(A, ACTOR, created.id, 1, { expiresOn: '2028-01-01' });
    expect(renewed).toMatchObject({ revision: 2, version: 2 });
    expect((await svc.history(A, created.id)).items.map((r) => r.status)).toEqual([
      'valid',
      'replaced',
    ]);
    await expect(svc.get(B, created.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await svc.list(A, { status: 'valid' })).total).toBe(1);
    expect((await svc.list(A, { status: 'expiring' })).total).toBe(0);
    await svc.archive(A, created.id, 2);
    expect((await svc.list(A)).total).toBe(0);
    await expect(svc.update(A, created.id, 3, { title: 'x' })).rejects.toMatchObject({
      code: 'immutable',
    });
  });
});
