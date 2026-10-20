import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import type { ExportJob } from '../../../domain/exports/src/index.js';
import { ExportJobEntity } from './entities.js';
import { TypeOrmExportJobStore } from './store.js';

/** A data source whose repository answers from memory: enough to prove the row mapping both ways. */
function fakeSource() {
  const rows: ExportJobEntity[] = [];
  const repository = {
    insert: async (row: ExportJobEntity) => void rows.push(row),
    findOneBy: async (where: Partial<ExportJobEntity>) =>
      rows.find((row) => Object.entries(where).every(([k, v]) => (row as never)[k] === v)) ?? null,
  };
  const source = {
    options: { username: 'opslog_exports_test' },
    getRepository: () => repository,
  } as unknown as DataSource;
  return { source, rows };
}

const job: ExportJob = {
  id: 'j1',
  tenantId: 'A',
  actorId: 'u1',
  sessionId: 's1',
  reportId: 'drivers',
  format: 'xlsx',
  filters: { areaId: 'a1' },
  columns: ['name', 'status'],
  sort: 'name',
  direction: 'desc',
  mode: 'job',
  status: 'queued',
  rowCount: null,
  byteSize: null,
  sha256: null,
  fileName: null,
  failure: null,
  idempotencyKey: 'key-12345678',
  requestHash: 'h'.repeat(64),
  attempts: 0,
  createdAt: '2026-10-19T16:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  leaseUntil: null,
};

describe('TypeOrmExportJobStore row mapping', () => {
  it('writes and reads a job without losing a field', async () => {
    const { source, rows } = fakeSource();
    const store = new TypeOrmExportJobStore(source);
    expect(await store.insert(job)).toEqual({ job, created: true });
    expect(rows[0]).toMatchObject({
      tenantId: 'A',
      id: 'j1',
      filters: { areaId: 'a1' },
      columns: ['name', 'status'],
    });
    expect(await store.find('A', 'j1')).toEqual(job);
    expect(await store.find('B', 'j1')).toBeNull();
    expect(await store.findByKey('A', 'u1', 'key-12345678')).toEqual(job);
  });

  it('maps every date and number of a finished job', async () => {
    const { source } = fakeSource();
    const store = new TypeOrmExportJobStore(source);
    const done: ExportJob = {
      ...job,
      id: 'j2',
      idempotencyKey: null,
      status: 'completed',
      rowCount: 7,
      byteSize: 1234,
      sha256: 'a'.repeat(64),
      fileName: 'drivers-20261019.xlsx',
      attempts: 1,
      startedAt: '2026-10-19T16:00:01.000Z',
      finishedAt: '2026-10-19T16:00:02.000Z',
      expiresAt: '2026-10-26T16:00:02.000Z',
      leaseUntil: null,
    };
    await store.insert(done);
    expect(await store.find('A', 'j2')).toEqual(done);
  });

  it('re-throws an insert failure that is not the idempotency key', async () => {
    const source = {
      options: { username: 'opslog_exports_test' },
      getRepository: () => ({
        insert: async () => {
          throw Object.assign(new Error('x'), { errno: 1213 });
        },
      }),
    } as unknown as DataSource;
    await expect(new TypeOrmExportJobStore(source).insert(job)).rejects.toThrow('x');
    const dup = {
      options: { username: 'opslog_exports_test' },
      getRepository: () => ({
        insert: async () => {
          throw Object.assign(new Error('dup'), { driverError: { errno: 1062 } });
        },
        findOneBy: async () => null,
      }),
    } as unknown as DataSource;
    await expect(new TypeOrmExportJobStore(dup).insert(job)).rejects.toThrow('dup');
    await expect(
      new TypeOrmExportJobStore(dup).insert({ ...job, idempotencyKey: null }),
    ).rejects.toThrow('dup');
  });
});
