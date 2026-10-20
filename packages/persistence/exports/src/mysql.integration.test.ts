import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { InMemoryExportJobStore, type ExportJob } from '../../../domain/exports/src/index.js';
import { AUDIT_TABLES } from '../../audit/src/index.js';
import { TypeOrmExportJobStore } from './store.js';
import { adminUrl, startExportDatabase, type ExportDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const A = 'tenant-a';
const B = 'tenant-b';
const T0 = new Date('2026-10-19T16:00:00.000Z');

const job = (id: string, over: Partial<ExportJob> = {}): ExportJob => ({
  id,
  tenantId: A,
  actorId: 'u1',
  sessionId: 'sess',
  reportId: 'drivers',
  format: 'csv',
  filters: { areaId: 'a1' },
  columns: ['name', 'status'],
  sort: 'name',
  direction: 'asc',
  mode: 'job',
  status: 'queued',
  rowCount: null,
  byteSize: null,
  sha256: null,
  fileName: null,
  failure: null,
  idempotencyKey: null,
  requestHash: 'h'.repeat(64),
  attempts: 0,
  createdAt: new Date(T0.getTime() + Number(id.replace(/\D/g, '') || 0) * 1000).toISOString(),
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  leaseUntil: null,
  ...over,
});

suite('persistent export jobs on MySQL', () => {
  let db: ExportDatabase;
  let source: DataSource;
  let store: TypeOrmExportJobStore;

  beforeAll(async () => {
    db = await startExportDatabase('exports');
    source = await db.openRuntime();
    store = new TypeOrmExportJobStore(source, undefined, () => T0);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('inserts, finds and isolates jobs by company', async () => {
    const stored = await store.insert(job('j1'));
    expect(stored.created).toBe(true);
    expect(await store.find(A, 'j1')).toEqual(job('j1'));
    expect(await store.find(B, 'j1')).toBeNull();
    await store.insert(job('j1', { tenantId: B, actorId: 'u9' }));
    expect((await store.find(B, 'j1'))?.actorId).toBe('u9');
    expect((await store.find(A, 'j1'))?.actorId).toBe('u1');
  });

  it('is idempotent by company, person and key', async () => {
    const first = await store.insert(job('k1', { idempotencyKey: 'key-aaaaaaaa' }));
    const second = await store.insert(job('k2', { idempotencyKey: 'key-aaaaaaaa' }));
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, job: { id: 'k1' } });
    expect(
      (await store.insert(job('k3', { actorId: 'u2', idempotencyKey: 'key-aaaaaaaa' }))).created,
    ).toBe(true);
    expect(
      (await store.insert(job('k4', { tenantId: B, idempotencyKey: 'key-aaaaaaaa' }))).created,
    ).toBe(true);
    expect((await store.findByKey(A, 'u1', 'key-aaaaaaaa'))?.id).toBe('k1');
    expect(await store.findByKey(A, 'u1', 'key-bbbbbbbb')).toBeNull();
  });

  it('lists only the person own jobs, newest first, and counts the open ones', async () => {
    await store.insert(job('l1', { actorId: 'lister' }));
    await store.insert(job('l2', { actorId: 'lister', status: 'running' }));
    await store.insert(job('l3', { actorId: 'lister', status: 'completed' }));
    await store.insert(job('l4', { actorId: 'other' }));
    const page = await store.listByActor(A, 'lister', { limit: 2, offset: 0 });
    expect(page.items.map((j) => j.id)).toEqual(['l3', 'l2']);
    expect(page.total).toBe(3);
    expect(
      (await store.listByActor(A, 'lister', { limit: 2, offset: 2 })).items.map((j) => j.id),
    ).toEqual(['l1']);
    expect((await store.listByActor(B, 'lister', { limit: 5, offset: 0 })).total).toBe(0);
    const open = await store.countOpen(A, 'lister');
    expect(open.actor).toBe(2);
    expect(open.tenant).toBeGreaterThanOrEqual(open.actor + 1);
    expect(await store.countOpen('nobody', 'lister')).toEqual({ tenant: 0, actor: 0 });
  });

  it('hands each queued job to exactly one of two concurrent workers and reclaims a lost lease', async () => {
    // A company of its own, so no job of another test can overlap in time or in the queue.
    const C = 'tenant-claim';
    for (let i = 1; i <= 6; i += 1)
      await store.insert(job(`c${i}`, { tenantId: C, actorId: 'claimer' }));
    const [one, two] = await Promise.all([
      store.claim(C, T0, 60_000, 4),
      store.claim(C, T0, 60_000, 4),
    ]);
    const ids = [...one, ...two].map((j) => j.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...one, ...two].every((j) => j.status === 'running' && j.attempts === 1)).toBe(true);
    const claimed = one.concat(two)[0] as ExportJob;
    expect(claimed.leaseUntil).toBe(new Date(T0.getTime() + 60_000).toISOString());
    // The rest is still queued for the next turn; nothing is taken twice.
    const rest = await store.claim(C, T0, 60_000, 10);
    expect(new Set([...ids, ...rest.map((j) => j.id)]).size).toBe(6);
    const other = await store.claim(B, T0, 60_000, 10);
    expect(other.map((j) => j.id).sort()).toEqual(['j1', 'k4']);
    expect(other.every((j) => j.tenantId === B)).toBe(true);
    // After the lease the same job is taken again with one more attempt.
    const later = new Date(T0.getTime() + 120_000);
    const again = await store.claim(C, later, 60_000, 50);
    expect(again.find((j) => j.id === claimed.id)).toMatchObject({
      attempts: 2,
      status: 'running',
    });
  });

  it('compares and sets the status, and writes the event in the same transaction', async () => {
    await store.insert(job('t1', { actorId: 'trans', status: 'running', attempts: 1 }));
    const done: ExportJob = {
      ...job('t1', { actorId: 'trans', attempts: 1 }),
      status: 'completed',
      rowCount: 9,
      byteSize: 100,
      sha256: 'b'.repeat(64),
      fileName: 'drivers-20261019.csv',
      finishedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 7 * 86_400_000).toISOString(),
    };
    const event = {
      type: 'export.completed' as const,
      payload: { jobId: 't1', reportId: 'drivers', format: 'csv', rowCount: 9 },
    };
    expect(await store.transition(done, 'queued', event)).toBe(false);
    expect(
      await db.rows(
        'SELECT * FROM ' + AUDIT_TABLES.outbox + " WHERE event_id = 'export-completed-t1'",
      ),
    ).toHaveLength(0);
    expect(await store.transition(done, 'running', event)).toBe(true);
    expect(await store.transition(done, 'running', event)).toBe(false);
    expect(await store.find(A, 't1')).toEqual(done);
    const rows = await db.rows<{ type: string; payload: unknown; company_id: string }>(
      'SELECT * FROM ' + AUDIT_TABLES.outbox + " WHERE event_id = 'export-completed-t1'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'export.completed' });
  });

  it('does not write the event when the unit of work fails', async () => {
    await store.insert(job('t2', { actorId: 'trans', status: 'running' }));
    const broken = new TypeOrmExportJobStore(
      source,
      {
        transaction: async () => {
          throw new Error('outbox down');
        },
      },
      () => T0,
    );
    const failed = {
      ...job('t2', { actorId: 'trans' }),
      status: 'failed' as const,
      failure: 'session_ended' as const,
      finishedAt: T0.toISOString(),
    };
    await expect(
      broken.transition(failed, 'running', { type: 'export.failed', payload: { jobId: 't2' } }),
    ).rejects.toThrow('outbox down');
    expect((await store.find(A, 't2'))?.status).toBe('running');
  });

  it('finds the completed jobs past their date, never deletes a row and keeps the account DML-only', async () => {
    await store.insert(
      job('e1', {
        actorId: 'expirer',
        status: 'completed',
        expiresAt: new Date(T0.getTime() - 1000).toISOString(),
      }),
    );
    await store.insert(
      job('e2', {
        actorId: 'expirer',
        status: 'completed',
        expiresAt: new Date(T0.getTime() + 1000).toISOString(),
      }),
    );
    await store.insert(job('e3', { actorId: 'expirer', status: 'failed' }));
    expect((await store.expired(A, T0, 10)).map((j) => j.id)).toEqual(['e1']);
    expect(await store.expired(B, T0, 10)).toEqual([]);
    await expect(
      source.query('DELETE FROM opslog_export_jobs WHERE company_id = ?', [A]),
    ).rejects.toThrow(/denied/i);
    await expect(source.query('DROP TABLE opslog_export_jobs')).rejects.toThrow(/denied/i);
  });

  it('answers like the in-memory reference for list, count and expiry', async () => {
    const memory = new InMemoryExportJobStore();
    for (const j of [
      job('m1', { actorId: 'ref' }),
      job('m2', { actorId: 'ref', status: 'running' }),
      job('m3', {
        actorId: 'ref',
        status: 'completed',
        expiresAt: new Date(T0.getTime() - 5).toISOString(),
      }),
    ]) {
      await memory.insert(j);
      await store.insert({ ...j, tenantId: 'tenant-ref' });
      await memory.find('A', j.id);
    }
    const mem = await memory.listByActor(A, 'ref', { limit: 10, offset: 0 });
    const real = await store.listByActor('tenant-ref', 'ref', { limit: 10, offset: 0 });
    expect(real.items.map((j) => j.id)).toEqual(mem.items.map((j) => j.id));
    expect(real.total).toBe(mem.total);
    expect((await store.expired('tenant-ref', T0, 10)).map((j) => j.id)).toEqual(
      (await memory.expired(A, T0, 10)).map((j) => j.id),
    );
  });
});
