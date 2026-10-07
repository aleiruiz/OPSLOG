import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  ImportService,
  type ImportEvent,
  type ImportJob,
  type ImportRowResult,
  type ImportTarget,
} from '../../../domain/imports/src/index.js';
import { ImportEventEntity, ImportJobEntity, ImportRowEntity } from './entities.js';
import { ImportStoreError } from './errors.js';
import { TypeOrmImportStore, type StoreErrorEvent } from './store.js';
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

const job = (tenant: string, id: string, over: Partial<ImportJob> = {}): ImportJob => ({
  id,
  tenantId: tenant,
  entity: 'vehicle',
  mode: 'commit_valid',
  status: 'running',
  idempotencyKey: `key-${id}-aaaaaaaa`,
  fingerprint: 'f'.repeat(64),
  totalRows: 3,
  validRows: 0,
  invalidRows: 0,
  importedRows: 0,
  createdBy: ACTOR,
  createdAt: NOW.toISOString(),
  finishedAt: null,
  version: 1,
  updatedAt: NOW.toISOString(),
  ...over,
});
const started = (j: ImportJob): ImportEvent => ({
  tenantId: j.tenantId,
  jobId: j.id,
  seq: 1,
  kind: 'started',
  actorId: ACTOR,
  acceptedRows: null,
  rejectedRows: null,
  at: j.createdAt,
});
const finished = (j: ImportJob): ImportJob => ({
  ...j,
  status: 'imported',
  validRows: 2,
  invalidRows: 1,
  importedRows: 2,
  finishedAt: '2026-10-06T12:01:00.000Z',
  version: 2,
  updatedAt: '2026-10-06T12:01:00.000Z',
});
const ended = (j: ImportJob): ImportEvent => ({
  tenantId: j.tenantId,
  jobId: j.id,
  seq: 2,
  kind: 'imported',
  actorId: ACTOR,
  acceptedRows: 2,
  rejectedRows: 1,
  at: '2026-10-06T12:01:00.000Z',
});
const result = (
  tenant: string,
  jobId: string,
  rowNumber: number,
  over: Partial<ImportRowResult> = {},
): ImportRowResult => ({
  tenantId: tenant,
  jobId,
  rowNumber,
  outcome: 'valid',
  code: null,
  columns: [],
  entityId: null,
  at: NOW.toISOString(),
  ...over,
});

function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmImportStore(asDataSource(db), {
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
const put = (store: TypeOrmImportStore, j: ImportJob) => store.insertJob(j, started(j));

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) => new TypeOrmImportStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted imports account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_imports_x' })).toThrow(/MySQL/);
    expect(() => build({ type: 'mysql', username: 'opslog_imports_x', synchronize: true })).toThrow(
      /synchronize/,
    );
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_assignments_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_imports_runtime' })).not.toThrow();
  });
  it('treats a non-positive attempt budget as a single attempt', async () => {
    const { db, store } = setup({ maxAttempts: 0 });
    db.failNext('insert', DEADLOCK, { entity: ImportJobEntity });
    expect(await rejection(put(store, job(A, 'j1')))).toMatchObject({ code: 'contention' });
  });
});

describe('jobs', () => {
  it('stores the job and its first event in one READ COMMITTED transaction and reads them back', async () => {
    const { db, store } = setup();
    const j = job(A, 'j1');
    expect(await put(store, j)).toBe(true);
    expect(await store.findJob(A, 'j1')).toEqual(j);
    expect(await store.findByKey(A, j.idempotencyKey as string)).toEqual(j);
    expect((await store.events(A, 'j1', window)).items).toEqual([started(j)]);
    expect(db.isolations).toEqual(['READ COMMITTED']);
  });

  it('answers false for a key that is already taken, and keeps the first job', async () => {
    const { db, store } = setup();
    expect(await put(store, job(A, 'j1', { idempotencyKey: 'key-same-aaaaaaaa' }))).toBe(true);
    const second = job(A, 'j2', { idempotencyKey: 'key-same-aaaaaaaa' });
    expect(await put(store, second)).toBe(false);
    expect(await store.findJob(A, 'j2')).toBeNull();
    // The failed transaction wrote nothing (not even the event).
    expect(db.committed(ImportEventEntity)).toHaveLength(1);
    // The same key in another company is free; a dry run without a key never collides.
    expect(await put(store, job(B, 'j1', { idempotencyKey: 'key-same-aaaaaaaa' }))).toBe(true);
    expect(await put(store, job(A, 'n1', { idempotencyKey: null, mode: 'dry_run' }))).toBe(true);
    expect(await put(store, job(A, 'n2', { idempotencyKey: null, mode: 'dry_run' }))).toBe(true);
  });

  it('claims a running job with one conditional update, once per stamp', async () => {
    const { db, store } = setup();
    const j = job(A, 'j1');
    await put(store, j);
    const t1 = '2026-10-06T12:00:00.001Z';
    const t2 = '2026-10-06T12:00:00.002Z';
    expect(await store.claimJob(A, 'j1', j.updatedAt, t1)).toBe(true);
    expect((await store.findJob(A, 'j1'))?.updatedAt).toBe(t1);
    // The stale stamp, another company and a finished job never match.
    expect(await store.claimJob(A, 'j1', j.updatedAt, t2)).toBe(false);
    expect(await store.claimJob(B, 'j1', t1, t2)).toBe(false);
    expect(await store.finishJob(finished(j), 1, ended(j))).toBe(true);
    expect(await store.claimJob(A, 'j1', finished(j).updatedAt, t2)).toBe(false);
    expect(db.committed(ImportEventEntity)).toHaveLength(2);
  });

  it('refuses rows that are not those of the tenant and job given', async () => {
    const { db, store } = setup();
    await put(store, job(A, 'j1'));
    await put(store, job(B, 'j1'));
    await put(store, job(A, 'j2'));
    for (const [tenant, jobId, row] of [
      [A, 'j1', result(B, 'j1', 1)],
      [A, 'j1', result(A, 'j2', 1)],
      [B, 'j1', result(A, 'j1', 1)],
    ] as const)
      expect(
        await rejection(store.appendRows(tenant, jobId, [result(A, 'j1', 2), row])),
      ).toMatchObject({
        code: 'integrity',
      });
    expect(db.committed(ImportRowEntity)).toHaveLength(0);
  });

  it('keeps tenants apart', async () => {
    const { store } = setup();
    await put(store, job(A, 'j1'));
    await put(store, job(B, 'j1'));
    expect(await store.findJob(B, 'zzz')).toBeNull();
    expect((await store.findJob(B, 'j1'))?.tenantId).toBe(B);
    expect(await store.findByKey(B, 'key-unknown-aaaaaaaa')).toBeNull();
    expect((await store.listJobs(A, {}, window)).total).toBe(1);
    expect((await store.events(A, 'j1', window)).total).toBe(1);
    await store.appendRows(A, 'j1', [result(A, 'j1', 1)]);
    expect((await store.rows(B, 'j1', {}, window)).total).toBe(0);
  });

  it('rejects a row or an event for a job that does not exist (composite foreign key)', async () => {
    const { db } = setup();
    expect(
      await rejection(db.getRepository(ImportRowEntity).insert({ ...result(A, 'ghost', 1) })),
    ).toMatchObject({ driverError: { errno: 1452 } });
    expect(
      await rejection(db.getRepository(ImportEventEntity).insert({ ...started(job(A, 'ghost')) })),
    ).toMatchObject({ driverError: { errno: 1452 } });
  });

  it('lists newest first with filters and a window, counting the whole match', async () => {
    const { store } = setup();
    await put(store, job(A, 'j1', { createdAt: '2026-10-06T10:00:00.000Z' }));
    await put(store, job(A, 'j2', { createdAt: '2026-10-06T11:00:00.000Z', entity: 'employee' }));
    await put(store, job(A, 'j3', { createdAt: '2026-10-06T12:00:00.000Z' }));
    await store.finishJob(finished(job(A, 'j3')), 1, ended(job(A, 'j3')));
    expect((await store.listJobs(A, {}, window)).items.map((j) => j.id)).toEqual([
      'j3',
      'j2',
      'j1',
    ]);
    expect((await store.listJobs(A, { entity: 'vehicle' }, window)).total).toBe(2);
    expect(
      (await store.listJobs(A, { status: 'imported' }, window)).items.map((j) => j.id),
    ).toEqual(['j3']);
    const page = await store.listJobs(A, {}, { limit: 1, offset: 1 });
    expect([page.items.map((j) => j.id), page.total]).toEqual([['j2'], 3]);
  });

  it('finishes a job once: a conditional update plus the closing event, or nothing', async () => {
    const { db, store } = setup();
    const j = job(A, 'j1');
    await put(store, j);
    expect(await store.finishJob(finished(j), 1, ended(j))).toBe(true);
    expect(await store.findJob(A, 'j1')).toEqual(finished(j));
    expect((await store.events(A, 'j1', window)).items.map((e) => [e.seq, e.kind])).toEqual([
      [2, 'imported'],
      [1, 'started'],
    ]);
    // A stale version changes nothing and writes no event.
    expect(await store.finishJob({ ...finished(j), invalidRows: 0 }, 1, ended(j))).toBe(false);
    expect(db.committed(ImportEventEntity)).toHaveLength(2);
    expect((await store.findJob(A, 'j1'))?.invalidRows).toBe(1);
    // Never touches the immutable columns, and never another company's job.
    expect(await store.finishJob(finished(job(B, 'j1')), 1, ended(job(B, 'j1')))).toBe(false);
    expect(
      db.statements.filter((s) => s.operation === 'update').every((s) => s.where?.['tenantId']),
    ).toBe(true);
  });
});

describe('row results', () => {
  it('appends results and reads them back by row number with filters and windows', async () => {
    const { store } = setup();
    await put(store, job(A, 'j1'));
    await store.appendRows(A, 'j1', [
      result(A, 'j1', 2, { outcome: 'invalid', code: 'duplicate', columns: ['plate', 'vin'] }),
      result(A, 'j1', 1, { outcome: 'imported', entityId: 'veh-1' }),
      result(A, 'j1', 3),
    ]);
    const all = await store.rows(A, 'j1', {}, window);
    expect(all.items.map((r) => [r.rowNumber, r.outcome])).toEqual([
      [1, 'imported'],
      [2, 'invalid'],
      [3, 'valid'],
    ]);
    expect(all.items[1]).toMatchObject({ code: 'duplicate', columns: ['plate', 'vin'] });
    expect(all.items[0]).toMatchObject({ entityId: 'veh-1', columns: [], code: null });
    expect((await store.rows(A, 'j1', { outcome: 'invalid' }, window)).total).toBe(1);
    const page = await store.rows(A, 'j1', {}, { limit: 1, offset: 1 });
    expect([page.items[0]?.rowNumber, page.total]).toEqual([2, 3]);
    await store.appendRows(A, 'j1', []);
  });

  it('keeps an existing result and adds the rest when a retry or a race records a row twice', async () => {
    const { db, store } = setup();
    await put(store, job(A, 'j1'));
    await store.appendRows(A, 'j1', [result(A, 'j1', 1)]);
    await store.appendRows(A, 'j1', [
      result(A, 'j1', 1, { outcome: 'invalid', code: 'duplicate', columns: ['plate'] }),
      result(A, 'j1', 2),
    ]);
    const rows = (await store.rows(A, 'j1', {}, window)).items;
    expect(rows.map((r) => [r.rowNumber, r.outcome])).toEqual([
      [1, 'valid'],
      [2, 'valid'],
    ]);
    // Not a duplicate: the failure surfaces, sanitized.
    db.failNext('insert', CONNECTION_LOST, { entity: ImportRowEntity });
    expect(await rejection(store.appendRows(A, 'j1', [result(A, 'j1', 3)]))).toBeInstanceOf(
      ImportStoreError,
    );
    // A duplicate in the batch statement, then a non-duplicate failure on the single retry.
    db.failNext('insert', DUPLICATE, { entity: ImportRowEntity });
    db.failNext('insert', CONNECTION_LOST, { entity: ImportRowEntity });
    expect(await rejection(store.appendRows(A, 'j1', [result(A, 'j1', 3)]))).toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('failures', () => {
  it('retries a deadlock and then succeeds', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', DEADLOCK, { entity: ImportJobEntity });
    expect(await put(store, job(A, 'j1'))).toBe(true);
    expect(events).toEqual([]);
    expect(db.transactions).toBe(2);
  });

  it('gives up after the attempt budget with a sanitized contention error', async () => {
    const { db, store, events } = setup();
    db.failNext('insert', LOCK_TIMEOUT, { entity: ImportJobEntity, times: 3 });
    const error = await rejection(put(store, job(A, 'j1')));
    expect(error).toBeInstanceOf(ImportStoreError);
    expect(error).toMatchObject({ code: 'contention', errno: 1205 });
    expect(events).toEqual([{ operation: 'insertJob', code: 'contention', errno: 1205 }]);
  });

  it('never lets a driver message, SQL or parameter leave the store', async () => {
    const { db, store } = setup();
    await put(store, job(A, 'j1'));
    db.failNext('find', CONNECTION_LOST, { leak: 'SECRET-LEAK-MARKER-9981' });
    const error = (await rejection(store.findJob(A, 'j1'))) as Error;
    expect(error).toBeInstanceOf(ImportStoreError);
    expect(JSON.stringify(error)).not.toContain('SECRET-LEAK-MARKER-9981');
    expect(error.message).not.toContain('SECRET-LEAK-MARKER-9981');
    expect(error.message).toBe('Import store operation failed: unavailable');
    db.failNext('list', CONNECTION_LOST);
    expect(await rejection(store.listJobs(A, {}, window))).toBeInstanceOf(ImportStoreError);
    db.failNext('update', DEADLOCK, { times: 3 });
    expect(
      await rejection(store.finishJob(finished(job(A, 'j1')), 1, ended(job(A, 'j1')))),
    ).toMatchObject({ code: 'contention' });
    db.failNext('update', CONNECTION_LOST);
    expect(
      await rejection(
        store.claimJob(A, 'j1', '2026-10-06T12:00:00.000Z', '2026-10-06T12:00:00.001Z'),
      ),
    ).toBeInstanceOf(ImportStoreError);
  });

  it('reports a stored row that violates the domain as an integrity error', async () => {
    const { db, store } = setup();
    await put(store, job(A, 'j1'));
    const bad = (patch: Record<string, unknown>) =>
      db.seed(ImportJobEntity, { ...db.committed(ImportJobEntity)[0], ...patch });
    bad({ entity: 'truck' });
    expect(await rejection(store.findJob(A, 'j1'))).toMatchObject({ code: 'integrity' });
    bad({ entity: 'vehicle', mode: 'sync' });
    expect(await rejection(store.findJob(A, 'j1'))).toMatchObject({ code: 'integrity' });
    bad({ mode: 'dry_run', status: 'weird' });
    expect(await rejection(store.findJob(A, 'j1'))).toMatchObject({ code: 'integrity' });
    const row = { ...result(A, 'j1', 1), columnNames: null };
    db.seed(ImportRowEntity, { ...row, outcome: 'maybe' });
    expect(await rejection(store.rows(A, 'j1', {}, window))).toMatchObject({ code: 'integrity' });
    db.seed(ImportRowEntity, { ...row, outcome: 'invalid', code: 'weird' });
    expect(await rejection(store.rows(A, 'j1', {}, window))).toMatchObject({ code: 'integrity' });
    db.seed(ImportEventEntity, { ...started(job(A, 'j1')), kind: 'strange' });
    expect(await rejection(store.events(A, 'j1', window))).toMatchObject({ code: 'integrity' });
  });
});

describe('with the domain service', () => {
  it('replays a finished job and never rewrites its results', async () => {
    const { store, db } = setup();
    const created: string[] = [];
    const target: ImportTarget = {
      invalidColumns: () => [],
      keys: () => [],
      precheck: async (_t, inputs) => inputs.map(() => null),
      create: async () => {
        created.push('x');
        return { id: `veh-${created.length}` };
      },
    };
    const service = new ImportService(store, {
      targets: { vehicle: target, employee: target },
      now: () => NOW,
    });
    const input = {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'key-service-aaaaaaaa',
      rows: [
        {
          economicNumber: 'U-1',
          plate: 'ABC1',
          make: 'T',
          model: 'H',
          year: '2022',
          areaId: 'a1',
          odometerKm: '1',
        },
      ],
    };
    const first = await service.submit(A, ACTOR, input);
    const again = await service.submit(A, ACTOR, input);
    expect(again).toMatchObject({ replayed: true, job: { id: first.job.id, status: 'imported' } });
    expect(created).toHaveLength(1);
    expect(db.committed(ImportRowEntity)).toHaveLength(1);
    expect(JSON.stringify(db.committed(ImportRowEntity))).not.toMatch(/ABC1|U-1|Toyota/);
  });
});
