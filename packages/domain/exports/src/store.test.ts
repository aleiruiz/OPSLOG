import { describe, expect, it } from 'vitest';
import { InMemoryExportJobStore, type ExportJob } from './index.js';

const job: ExportJob = {
  id: 'job-1',
  tenantId: 'co-a',
  actorId: 'u1',
  sessionId: 's',
  reportId: 'drivers',
  format: 'csv',
  filters: {},
  columns: ['name'],
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
  requestHash: 'h',
  attempts: 0,
  createdAt: '2026-10-19T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  leaseUntil: null,
};

describe('InMemoryExportJobStore defaults', () => {
  it('moves a job and drops the event when no emitter is given', async () => {
    const store = new InMemoryExportJobStore();
    await store.insert(job);
    const moved = await store.transition({ ...job, status: 'failed' }, 'queued', {
      type: 'export.failed',
      payload: { jobId: 'job-1' },
    });
    expect(moved).toBe(true);
    expect((await store.find('co-a', 'job-1'))?.status).toBe('failed');
  });
});
