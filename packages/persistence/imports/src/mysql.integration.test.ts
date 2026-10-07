import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  ImportService,
  type ImportEvent,
  type ImportJob,
  type ImportRowResult,
  type ImportTarget,
} from '../../../domain/imports/src/index.js';
import { BINARY_COLLATION, IMPORT_TABLES } from './entities.js';
import { ImportStoreError } from './errors.js';
import { TypeOrmImportStore, type StoreErrorEvent } from './store.js';
import { adminUrl, startImportsDatabase, type ImportsDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const T = IMPORT_TABLES;

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
  finishedAt: '2026-10-06T12:01:00.123Z',
  version: 2,
  updatedAt: '2026-10-06T12:01:00.123Z',
});
const ended = (j: ImportJob): ImportEvent => ({
  tenantId: j.tenantId,
  jobId: j.id,
  seq: 2,
  kind: 'imported',
  actorId: ACTOR,
  acceptedRows: 2,
  rejectedRows: 1,
  at: '2026-10-06T12:01:00.123Z',
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

/** The error of a statement, or undefined when it succeeds. */
const outcome = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};
const errnoOf = (error: unknown): number | undefined =>
  (error as { errno?: number; driverError?: { errno?: number } }).driverError?.errno ??
  (error as { errno?: number }).errno;

const window = { limit: 100, offset: 0 };
const insert = (db: ImportsDatabase, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return outcome(
    db.admin.query(
      `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      Object.values(row),
    ),
  );
};

suite('persistent import store on MySQL', () => {
  let db: ImportsDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmImportStore;
  let storeB: TypeOrmImportStore;
  const events: StoreErrorEvent[] = [];

  beforeAll(async () => {
    db = await startImportsDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmImportStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmImportStore(sourceB);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  }, 60_000);

  const jobRow = (patch: Record<string, unknown> = {}) => ({
    company_id: 'tenant-checks',
    id: `chk-${Math.random().toString(36).slice(2, 12)}`,
    entity: 'vehicle',
    mode: 'dry_run',
    status: 'running',
    idempotency_key: null,
    fingerprint: 'a'.repeat(64),
    total_rows: 2,
    valid_rows: 0,
    invalid_rows: 0,
    imported_rows: 0,
    created_by: ACTOR,
    created_at: NOW,
    finished_at: null,
    version: 1,
    updated_at: NOW,
    ...patch,
  });

  describe('schema', () => {
    it('is created in its own migrations table with binary collations and company-keyed keys', async () => {
      const tables = await db.rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [db.databaseName],
      );
      expect(tables.map((r) => r.t).sort()).toEqual(
        [...Object.values(T), 'opslog_imports_migrations'].sort(),
      );
      const columns = await db.rows<{ coll: string }>(
        `SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME <> 'opslog_imports_migrations'`,
        [db.databaseName],
      );
      expect(columns.length).toBeGreaterThan(10);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);
      const keys = await db.rows<{ table: string; name: string; col: string; seq: number }>(
        `SELECT TABLE_NAME AS \`table\`, INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'opslog_imports_migrations'`,
        [db.databaseName],
      );
      // Every index, the primary keys included, starts with company_id.
      for (const key of keys.filter((candidate) => candidate.seq === 1))
        expect([key.table, key.name, key.col]).toEqual([key.table, key.name, 'company_id']);
      const unique = await db.rows<{ name: string }>(
        `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'`,
        [db.databaseName, T.jobs],
      );
      expect(unique.map((u) => u.name)).toEqual(['ux_import_jobs_key']);
    });

    it('rejects malformed job rows by CHECK constraint, whoever writes them', async () => {
      const done = {
        status: 'validated',
        valid_rows: 2,
        finished_at: new Date('2026-10-07T00:00:00Z'),
        version: 2,
      };
      const illegal: Record<string, Record<string, unknown>> = {
        'unknown entity': { entity: 'truck' },
        'unknown mode': { mode: 'sync' },
        'unknown status': { status: 'done' },
        'version zero': { version: 0 },
        'no rows': { total_rows: 0 },
        'too many rows': { total_rows: 501 },
        'short fingerprint': { fingerprint: 'abc' },
        'blank creator': { created_by: '   ' },
        'counts beyond the total': { ...done, valid_rows: 2, invalid_rows: 1 },
        'imported beyond valid': {
          mode: 'commit_all',
          idempotency_key: 'key-checks-aaaa',
          status: 'imported',
          valid_rows: 1,
          invalid_rows: 1,
          imported_rows: 2,
          finished_at: new Date('2026-10-07T00:00:00Z'),
          version: 2,
        },
        'running with counts': { valid_rows: 1 },
        'running with an end': { finished_at: new Date('2026-10-07T00:00:00Z') },
        'running beyond version one': { version: 2 },
        'finished without an end': { ...done, finished_at: null },
        'finished at version one': { ...done, version: 1 },
        'finished before it was created': {
          ...done,
          finished_at: new Date('2020-01-01T00:00:00Z'),
        },
        'finished with rows unaccounted for': { ...done, valid_rows: 1 },
        'dry run that imported': { ...done, imported_rows: 1 },
        'dry run that failed': { ...done, status: 'failed' },
        'commit without a key': {
          ...done,
          mode: 'commit_all',
          status: 'imported',
          imported_rows: 1,
        },
        'commit validated': { ...done, mode: 'commit_all', idempotency_key: 'key-checks-bbbb' },
        'imported with nothing imported': {
          ...done,
          mode: 'commit_all',
          idempotency_key: 'key-checks-cccc',
          status: 'imported',
        },
        'failed with imports': {
          ...done,
          mode: 'commit_all',
          idempotency_key: 'key-checks-dddd',
          status: 'failed',
          imported_rows: 1,
        },
      };
      for (const [label, patch] of Object.entries(illegal)) {
        const error = await insert(db, T.jobs, jobRow(patch));
        expect([label, errnoOf(error)]).toEqual([label, 3819]);
      }
      expect(await insert(db, T.jobs, jobRow(done))).toBeUndefined();
      expect(
        await insert(
          db,
          T.jobs,
          jobRow({
            mode: 'commit_all',
            idempotency_key: 'key-checks-eeee',
            status: 'imported',
            valid_rows: 2,
            imported_rows: 2,
            finished_at: new Date('2026-10-07T00:00:00Z'),
            version: 2,
          }),
        ),
      ).toBeUndefined();
    });

    it('rejects malformed result and event rows, and ones of a job that does not exist', async () => {
      const parent = jobRow({ company_id: 'tenant-rows' });
      await insert(db, T.jobs, parent);
      const base = {
        company_id: 'tenant-rows',
        job_id: parent.id,
        row_number: 1,
        outcome: 'valid',
        code: null,
        column_names: null,
        entity_id: null,
        at: NOW,
      };
      const illegalRows: Record<string, Record<string, unknown>> = {
        'unknown outcome': { outcome: 'maybe' },
        'row zero': { row_number: 0 },
        'row beyond the limit': { row_number: 501 },
        'valid with a code': { code: 'duplicate' },
        'valid with columns': { column_names: 'plate' },
        'valid with an entity': { entity_id: 'veh-1' },
        'invalid without a code': { outcome: 'invalid' },
        'invalid with an unknown code': { outcome: 'invalid', code: 'weird' },
        'invalid with an entity': { outcome: 'invalid', code: 'duplicate', entity_id: 'veh-1' },
        'imported without an entity': { outcome: 'imported' },
        'imported with a code': { outcome: 'imported', entity_id: 'veh-1', code: 'duplicate' },
        'skipped with a code': { outcome: 'skipped', code: 'duplicate' },
        'job of another company': { company_id: 'tenant-other' },
        'job that does not exist': { job_id: 'ghost' },
      };
      for (const [label, patch] of Object.entries(illegalRows)) {
        const error = await insert(db, T.rows, { ...base, ...patch });
        expect([label, [3819, 1452, 1216].includes(errnoOf(error) as number)]).toEqual([
          label,
          true,
        ]);
      }
      expect(await insert(db, T.rows, base)).toBeUndefined();
      expect(await insert(db, T.rows, { ...base, row_number: 1 })).toBeDefined();
      expect(
        await insert(db, T.rows, {
          ...base,
          row_number: 2,
          outcome: 'invalid',
          code: 'duplicate',
          column_names: 'plate,vin',
        }),
      ).toBeUndefined();
      const event = (patch: Record<string, unknown>) => ({
        company_id: 'tenant-rows',
        job_id: parent.id,
        seq: 1,
        kind: 'started',
        actor_id: ACTOR,
        accepted_rows: null,
        rejected_rows: null,
        at: NOW,
        ...patch,
      });
      for (const patch of [
        { kind: 'edited' },
        { seq: 3 },
        { seq: 2 },
        { kind: 'validated' },
        { accepted_rows: 1 },
        { seq: 2, kind: 'imported' },
        { seq: 2, kind: 'started', accepted_rows: 1, rejected_rows: 0 },
        { actor_id: ' ' },
        { company_id: 'tenant-other' },
      ]) {
        const error = await insert(db, T.events, event(patch));
        expect([
          JSON.stringify(patch),
          [3819, 1452, 1216].includes(errnoOf(error) as number),
        ]).toEqual([JSON.stringify(patch), true]);
      }
      expect(await insert(db, T.events, event({}))).toBeUndefined();
      expect(
        await insert(
          db,
          T.events,
          event({ seq: 2, kind: 'validated', accepted_rows: 1, rejected_rows: 1 }),
        ),
      ).toBeUndefined();
    });

    it('applies the migration in both directions', async () => {
      const counted = await db.rows<{ n: number }>(
        'SELECT COUNT(*) AS n FROM opslog_imports_migrations',
      );
      expect(counted[0]?.n).toBe(1);
    });
  });

  describe('least privilege', () => {
    it('lets the runtime account read, insert and update jobs, but never delete', async () => {
      const j = job('tenant-grants', 'g1');
      await storeA.insertJob(j, started(j));
      await storeA.appendRows('tenant-grants', 'g1', [result('tenant-grants', 'g1', 1)]);
      expect(await storeA.finishJob(finished(j), 1, ended(j))).toBe(true);
      for (const sql of [
        `DELETE FROM ${T.jobs} WHERE company_id = 'tenant-grants'`,
        `DELETE FROM ${T.rows} WHERE company_id = 'tenant-grants'`,
        `DELETE FROM ${T.events} WHERE company_id = 'tenant-grants'`,
        `UPDATE ${T.rows} SET outcome = 'invalid' WHERE company_id = 'tenant-grants'`,
        `UPDATE ${T.events} SET actor_id = 'x' WHERE company_id = 'tenant-grants'`,
        `TRUNCATE TABLE ${T.jobs}`,
        `DROP TABLE ${T.events}`,
        `ALTER TABLE ${T.jobs} ADD COLUMN extra INT`,
      ]) {
        const error = await outcome(sourceA.query(sql));
        expect([sql, errnoOf(error)]).toEqual([sql, expect.any(Number)]);
        expect([1142, 1044, 1143]).toContain(errnoOf(error));
      }
      expect((await storeA.events('tenant-grants', 'g1', window)).total).toBe(2);
      expect((await storeA.rows('tenant-grants', 'g1', {}, window)).total).toBe(1);
      expect(await storeA.findJob('tenant-grants', 'g1')).toEqual(finished(j));
    });
  });

  describe('store behaviour on the real database', () => {
    it('round-trips every field, with microsecond timestamps in order', async () => {
      const tenant = 'tenant-roundtrip';
      const first = job(tenant, 'r1', {
        createdAt: '2026-10-06T12:00:00.123Z',
        updatedAt: '2026-10-06T12:00:00.123Z',
        entity: 'employee',
      });
      const second = job(tenant, 'r2', {
        createdAt: '2026-10-06T12:00:00.456Z',
        updatedAt: '2026-10-06T12:00:00.456Z',
        mode: 'dry_run',
        idempotencyKey: null,
      });
      expect(await storeA.insertJob(first, started(first))).toBe(true);
      expect(await storeA.insertJob(second, started(second))).toBe(true);
      expect(await storeB.findJob(tenant, 'r1')).toEqual(first);
      expect(await storeB.findByKey(tenant, first.idempotencyKey as string)).toEqual(first);
      expect((await storeB.listJobs(tenant, {}, window)).items.map((j) => j.id)).toEqual([
        'r2',
        'r1',
      ]);
      expect((await storeB.listJobs(tenant, { entity: 'employee' }, window)).total).toBe(1);
      await storeA.appendRows(tenant, 'r1', [
        result(tenant, 'r1', 2, {
          outcome: 'invalid',
          code: 'duplicate',
          columns: ['plate', 'vin'],
          at: '2026-10-06T12:00:01.250Z',
        }),
        result(tenant, 'r1', 1, { outcome: 'imported', entityId: 'veh-1' }),
      ]);
      const rows = (await storeB.rows(tenant, 'r1', {}, window)).items;
      expect(rows.map((r) => [r.rowNumber, r.outcome, r.code, r.columns, r.entityId])).toEqual([
        [1, 'imported', null, [], 'veh-1'],
        [2, 'invalid', 'duplicate', ['plate', 'vin'], null],
      ]);
      expect(rows[1]?.at).toBe('2026-10-06T12:00:01.250Z');
      expect((await storeB.rows(tenant, 'r1', { outcome: 'invalid' }, window)).total).toBe(1);
    });

    it('keeps tenants apart', async () => {
      const a = job('tenant-iso-a', 'same', { idempotencyKey: 'key-iso-aaaaaaaa' });
      const b = job('tenant-iso-b', 'same', { idempotencyKey: 'key-iso-aaaaaaaa' });
      expect(await storeA.insertJob(a, started(a))).toBe(true);
      expect(await storeA.insertJob(b, started(b))).toBe(true);
      await storeA.appendRows('tenant-iso-a', 'same', [result('tenant-iso-a', 'same', 1)]);
      expect((await storeB.rows('tenant-iso-b', 'same', {}, window)).total).toBe(0);
      expect((await storeB.findByKey('tenant-iso-b', 'key-iso-aaaaaaaa'))?.tenantId).toBe(
        'tenant-iso-b',
      );
      expect((await storeB.events('tenant-iso-a', 'same', window)).total).toBe(1);
      expect(await storeB.findJob('tenant-iso-a', 'nobody')).toBeNull();
    });

    it('lets exactly one of two processes insert a job for the same idempotency key', async () => {
      const racers = Array.from({ length: 8 }, (_, i) =>
        job('tenant-race', `race-${i}`, { idempotencyKey: 'key-race-aaaaaaaa' }),
      );
      const outcomes = await Promise.all(
        racers.map((j, i) => (i % 2 === 0 ? storeA : storeB).insertJob(j, started(j))),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const winner = racers[outcomes.indexOf(true)] as ImportJob;
      expect((await storeA.findByKey('tenant-race', 'key-race-aaaaaaaa'))?.id).toBe(winner.id);
      expect((await storeA.listJobs('tenant-race', {}, window)).total).toBe(1);
      // A losing attempt wrote no event either.
      const orphans = await db.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${T.events} WHERE company_id = 'tenant-race'`,
      );
      expect(orphans[0]?.n).toBe(1);
    });

    it('finishes a job once even when two processes try at the same time', async () => {
      const j = job('tenant-finish', 'f1');
      await storeA.insertJob(j, started(j));
      const outcomes = await Promise.all(
        [storeA, storeB, storeA, storeB].map((store) => store.finishJob(finished(j), 1, ended(j))),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await storeA.events('tenant-finish', 'f1', window)).total).toBe(2);
    });

    it('lets exactly one of many concurrent executors claim a running job', async () => {
      const tenant = 'tenant-claim';
      const j = job(tenant, 'c1', {
        createdAt: '2026-10-06T12:00:00.123456Z',
        updatedAt: '2026-10-06T12:00:00.123Z',
      });
      await storeA.insertJob(j, started(j));
      const next = '2026-10-06T12:02:00.456Z';
      const outcomes = await Promise.all(
        [storeA, storeB, storeA, storeB, storeA, storeB].map((store) =>
          store.claimJob(tenant, 'c1', j.updatedAt, next),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await storeA.findJob(tenant, 'c1'))?.updatedAt).toBe(next);
      // A renewal by the holder works, the stale stamp never does, and another company never matches.
      expect(await storeB.claimJob(tenant, 'c1', next, '2026-10-06T12:03:00.000Z')).toBe(true);
      expect(await storeA.claimJob(tenant, 'c1', next, '2026-10-06T12:04:00.000Z')).toBe(false);
      expect(await storeA.claimJob('tenant-other', 'c1', '2026-10-06T12:03:00.000Z', next)).toBe(
        false,
      );
      // Once finished the job cannot be claimed.
      const done = { ...finished(j), updatedAt: '2026-10-06T12:05:00.000Z' };
      expect(await storeA.finishJob(done, 1, ended(j))).toBe(true);
      expect(await storeA.claimJob(tenant, 'c1', done.updatedAt, '2026-10-06T12:06:00.000Z')).toBe(
        false,
      );
    });

    it('keeps the first result of a row recorded by concurrent attempts', async () => {
      const tenant = 'tenant-append';
      const j = job(tenant, 'p1');
      await storeA.insertJob(j, started(j));
      const rowsOf = (outcomeName: 'valid' | 'skipped') =>
        Array.from({ length: 30 }, (_, i) => result(tenant, 'p1', i + 1, { outcome: outcomeName }));
      await Promise.all([
        storeA.appendRows(tenant, 'p1', rowsOf('valid')),
        storeB.appendRows(tenant, 'p1', rowsOf('skipped')),
        storeA.appendRows(tenant, 'p1', rowsOf('valid')),
      ]);
      const stored = (await storeA.rows(tenant, 'p1', {}, window)).items;
      expect(stored.map((r) => r.rowNumber)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      await storeB.appendRows(tenant, 'p1', [result(tenant, 'p1', 1, { outcome: 'skipped' })]);
      expect((await storeB.rows(tenant, 'p1', {}, window)).items[0]?.outcome).toBe(
        stored[0]?.outcome,
      );
    });

    it('rolls back a job whose first event cannot be written', async () => {
      const j = job('tenant-atomic', 'a1');
      const broken = { ...started(j), seq: 5 };
      const error = await outcome(storeA.insertJob(j, broken));
      expect(error).toBeInstanceOf(ImportStoreError);
      expect(error).toMatchObject({ code: 'integrity' });
      expect(await storeA.findJob('tenant-atomic', 'a1')).toBeNull();
    });

    it('never leaks a value through a sanitized failure', async () => {
      const failing = new TypeOrmImportStore(sourceA, { onError: (event) => events.push(event) });
      const j = job('tenant-leak', 'l1');
      const error = await outcome(
        failing.insertJob(j, { ...started(j), actorId: 'SECRET-ACTOR-VALUE-77', seq: 9 }),
      );
      expect(error).toBeInstanceOf(ImportStoreError);
      expect(JSON.stringify(error) + (error as Error).message).not.toContain('SECRET-ACTOR');
      expect(events.at(-1)).toMatchObject({ operation: 'insertJob', code: 'integrity' });
    });
  });

  describe('with the domain service', () => {
    it('imports once, replays on the same key and keeps values out of every table', async () => {
      const created: string[] = [];
      const target: ImportTarget = {
        invalidColumns: () => [],
        keys: (input) => [['plate', String(input['plate'])]],
        precheck: async (_tenant, inputs) => inputs.map(() => null),
        create: async () => {
          created.push('x');
          return { id: `veh-${created.length}` };
        },
      };
      const service = new ImportService(storeA, {
        targets: { vehicle: target, employee: target },
      });
      const request = {
        entity: 'vehicle',
        mode: 'commit_valid',
        idempotencyKey: 'key-service-aaaaaaaa',
        rows: [
          {
            economicNumber: 'ECO-SENTINEL-1',
            plate: 'PLT-SENTINEL-1',
            make: 'MAKE-SENTINEL',
            model: 'MODEL-SENTINEL',
            year: '2022',
            areaId: 'area-1',
            odometerKm: '10',
          },
          {
            economicNumber: 'ECO-SENTINEL-2',
            plate: 'PLT-SENTINEL-1',
            make: 'MAKE-SENTINEL',
            model: 'MODEL-SENTINEL',
            year: '2022',
            areaId: 'area-1',
            odometerKm: '10',
          },
        ],
      };
      const settled = await Promise.allSettled([
        service.submit('tenant-service', ACTOR, request),
        new ImportService(storeB, { targets: { vehicle: target, employee: target } }).submit(
          'tenant-service',
          ACTOR,
          request,
        ),
      ]);
      // One process ran the job; the other either replayed it or was told it is in progress.
      const winners = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
      expect(winners.length).toBeGreaterThanOrEqual(1);
      for (const s of settled)
        if (s.status === 'rejected') expect(s.reason).toMatchObject({ code: 'conflict' });
      const one = winners[0] as (typeof winners)[number];
      const again = await service.submit('tenant-service', ACTOR, request);
      expect(again.replayed).toBe(true);
      expect(again.job).toMatchObject({ status: 'imported', importedRows: 1, invalidRows: 1 });
      const report = await service.rows('tenant-service', one.job.id);
      expect(report.items.map((r) => [r.rowNumber, r.outcome, r.code, r.columns])).toEqual([
        [1, 'imported', null, []],
        [2, 'invalid', 'duplicate_in_file', ['plate']],
      ]);
      const dump = JSON.stringify(
        await Promise.all(
          Object.values(T).map((table) =>
            db.rows(`SELECT * FROM ${table} WHERE company_id = 'tenant-service'`),
          ),
        ),
      );
      expect(dump).not.toMatch(/SENTINEL/);
    });
  });
});
