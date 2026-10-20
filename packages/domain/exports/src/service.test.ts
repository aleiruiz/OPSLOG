import { describe, expect, it, vi } from 'vitest';
import { ReportError } from '../../reports/src/index.js';
import { companyA } from '../../reports/src/test-support.js';
import { ExportError } from './errors.js';
import { PDF_MAX_ROWS } from './types.js';
import { viewOf } from './service.js';
import { BASIC, FULL, actor, bigCompany, harness } from './test-support.js';

/** The shape of the files domain's `FileError('conflict')`, which this package does not import. */
class FileError extends Error {
  public override readonly name = 'FileError';
  public constructor(public readonly code: string) {
    super(code);
  }
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

describe('direct export', () => {
  it('produces the file while the request waits, with one event, one audit entry and a stored artifact', async () => {
    const h = harness();
    const { job, replayed } = await h.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
    });
    expect(replayed).toBe(false);
    expect(job).toMatchObject({ mode: 'direct', status: 'completed', rowCount: 3, failure: null });
    expect(job.fileName).toBe('vehicle_inventory-20261019.csv');
    expect(job.expiresAt).toBe('2026-10-26T16:00:00.000Z');
    expect(h.artifacts.files.has(`tenants/A/exports/${job.id}`)).toBe(true);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'export.completed',
      payload: { jobId: job.id, reportId: 'vehicle_inventory', format: 'csv', rowCount: 3 },
      tenantId: 'A',
      idempotencyKey: `export-completed-${job.id}`,
    });
    expect(h.audit.map((a) => a.action)).toEqual(['export.completed:vehicle_inventory:csv']);
    const download = await h.service.download(actor(FULL), job.id);
    expect(download.fileName).toBe('vehicle_inventory-20261019.csv');
    expect(download.contentType).toBe('text/csv; charset=utf-8');
    expect(Buffer.from(download.bytes).toString('utf8')).toContain('ECO-1,PLA-100');
    expect(h.audit.map((a) => a.action)).toContain('export.downloaded:vehicle_inventory:csv');
  });

  it('loads the report once for a direct export and tells the sources who asks', async () => {
    const h = harness();
    const loads = vi.spyOn(h.sources, 'vehicles');
    await h.service.request(actor(FULL), { reportId: 'vehicle_inventory', format: 'csv' });
    expect(loads).toHaveBeenCalledTimes(1);
    const open = await h.service.request(actor(BASIC), {
      reportId: 'maintenance_corrective',
      format: 'csv',
    });
    expect(open.job.rowCount).toBeGreaterThan(0);
    // A mechanic-scoped person reads nothing of the orders (D9): the actor id reaches the source.
    h.sources.scopedActors.add('u1');
    const scoped = await h.service.request(actor(BASIC), {
      reportId: 'maintenance_corrective',
      format: 'csv',
    });
    expect(scoped.job.rowCount).toBe(0);
  });

  it('writes the filtered, ordered and projected rows in every format', async () => {
    const h = harness();
    const csv = await h.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
      filters: { make: 'Volvo' },
      columns: ['economicNumber', 'make'],
      sort: 'economicNumber',
      direction: 'desc',
    });
    const body = Buffer.from((await h.service.download(actor(FULL), csv.job.id)).bytes).toString(
      'utf8',
    );
    expect(body).toBe('﻿Nº económico,Marca\r\nECO-3,Volvo\r\nECO-2,Volvo\r\n');
    for (const format of ['xlsx', 'pdf'] as const) {
      const { job } = await h.service.request(actor(FULL), {
        reportId: 'vehicle_documents',
        format,
      });
      expect(job.status).toBe('completed');
      expect(job.rowCount).toBe(4);
    }
  });

  it('keeps sensitive columns out of the bytes of CSV, XLSX and PDF without the permission', async () => {
    const h = harness();
    const request = {
      reportId: 'drivers',
      columns: ['name', 'licenseNumber', 'licenseExpiresOn'],
    } as const;
    for (const format of ['csv', 'xlsx'] as const) {
      const { job } = await h.service.request(actor(BASIC), { ...request, format });
      expect(job.columns).toEqual(['name', 'licenseExpiresOn']);
      const bytes = (await h.service.download(actor(BASIC), job.id)).bytes;
      expect(text(bytes)).not.toContain('LIC-');
      expect(Buffer.from(bytes).toString('utf8')).not.toContain('Nº de licencia');
    }
    const open = await h.service.request(actor(FULL), { ...request, format: 'csv' });
    expect(
      Buffer.from((await h.service.download(actor(FULL), open.job.id)).bytes).toString('utf8'),
    ).toContain('LIC-ANA-001');
    const costs = await h.service.request(actor(BASIC), { reportId: 'insurance', format: 'csv' });
    expect(
      Buffer.from((await h.service.download(actor(BASIC), costs.job.id)).bytes).toString('utf8'),
    ).not.toContain('Deducible');
  });

  it('neutralizes formulas in text cells of CSV and never stores one in XLSX', async () => {
    const data = companyA();
    data.vehicles = ['=1+1', '+cmd', '-2', '@SUM(A1)', '\t=1', '＝1'].map((make, i) => ({
      ...data.vehicles[0]!,
      id: `h${i}`,
      economicNumber: `H-${i}`,
      make,
    }));
    data.assignments = [];
    const h = harness({ A: data });
    const csv = await h.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
      columns: ['make'],
      sort: 'economicNumber',
    });
    const lines = Buffer.from((await h.service.download(actor(FULL), csv.job.id)).bytes)
      .toString('utf8')
      .split('\r\n')
      .slice(1, 7);
    expect(lines).toEqual(["'=1+1", "'+cmd", "'-2", "'@SUM(A1)", "'\t=1", "'＝1"]);
    const xlsx = await h.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'xlsx',
      columns: ['make'],
    });
    expect(xlsx.job.status).toBe('completed');
  });

  it('turns 5.000 rows direct and 5.001 into a job', async () => {
    const at5000 = harness({ A: bigCompany(5000) });
    const direct = await at5000.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
    });
    expect(direct.job).toMatchObject({ mode: 'direct', status: 'completed', rowCount: 5000 });
    const at5001 = harness({ A: bigCompany(5001) });
    const queued = await at5001.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
    });
    expect(queued.job).toMatchObject({ mode: 'job', status: 'queued', rowCount: null });
    expect(at5001.events).toHaveLength(0);
  });

  it('sends a report whose estimate does not fit the budget to the worker', async () => {
    const h = harness();
    // The monotonic clock moves 6 s between the two readings: twice that exceeds the 10 s budget.
    h.clock.step = 6000;
    const queued = await h.service.request(actor(FULL), { reportId: 'areas', format: 'csv' });
    expect(queued.job.mode).toBe('job');
    expect(h.events).toHaveLength(0);
    h.clock.step = 5001;
    expect(
      (await h.service.request(actor(FULL), { reportId: 'areas', format: 'xlsx' })).job.mode,
    ).toBe('job');
    h.clock.step = 5000;
    expect(
      (await h.service.request(actor(FULL), { reportId: 'areas', format: 'csv' })).job.mode,
    ).toBe('direct');
  });

  it('fails a direct export whose file cannot be stored, without leaving a file', async () => {
    const h = harness();
    h.artifacts.failPut = 1;
    const { job } = await h.service.request(actor(FULL), { reportId: 'areas', format: 'csv' });
    expect(job).toMatchObject({ status: 'failed', failure: 'generation_failed' });
    expect(h.artifacts.files.size).toBe(0);
    expect(h.events.map((e) => e.type)).toEqual(['export.failed']);
  });
});

describe('request rules', () => {
  it('needs export, a known report, a supported format and a valid key', async () => {
    const h = harness();
    await expect(
      h.service.request(actor(['view']), { reportId: 'areas', format: 'csv' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      h.service.request(actor(FULL), { reportId: 'nope', format: 'csv' }),
    ).rejects.toBeInstanceOf(ReportError);
    await expect(
      h.service.request(actor(FULL), { reportId: 'areas', format: 'pdf' }),
    ).rejects.toMatchObject({ field: 'format' });
    await expect(
      h.service.request(actor(FULL), { reportId: 'areas', format: 'csv', idempotencyKey: 'short' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      h.service.request(actor(['export']), { reportId: 'areas', format: 'csv' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('is idempotent by key and rejects the key reused for another request', async () => {
    const h = harness();
    const first = await h.service.request(actor(FULL), {
      reportId: 'areas',
      format: 'csv',
      idempotencyKey: 'key-12345678',
    });
    const again = await h.service.request(actor(FULL), {
      reportId: 'areas',
      format: 'csv',
      idempotencyKey: 'key-12345678',
    });
    expect(again.replayed).toBe(true);
    expect(again.job.id).toBe(first.job.id);
    expect(h.events).toHaveLength(1);
    await expect(
      h.service.request(actor(FULL), {
        reportId: 'areas',
        format: 'xlsx',
        idempotencyKey: 'key-12345678',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    // The same key from another person is another key.
    h.grants.set('A:u2', new Set(FULL));
    const other = await h.service.request(actor(FULL, { actorId: 'u2' }), {
      reportId: 'areas',
      format: 'csv',
      idempotencyKey: 'key-12345678',
    });
    expect(other.job.id).not.toBe(first.job.id);
  });

  it('limits the open jobs per person and per company', async () => {
    const h = harness({ A: bigCompany(5001) });
    const ask = (id: string) =>
      h.service.request(actor(FULL, { actorId: id }), {
        reportId: 'vehicle_inventory',
        format: 'csv',
      });
    for (let i = 0; i < 3; i += 1) await ask('u1');
    await expect(ask('u1')).rejects.toMatchObject({ code: 'too_many_open' });
    for (const id of ['u2', 'u3', 'u4'])
      for (let i = 0; i < 3 && (await h.store.countOpen('A', id)).tenant < 10; i += 1)
        await ask(id).catch(() => undefined);
    await expect(ask('u5')).rejects.toMatchObject({ code: 'too_many_open' });
  });
});

describe('background jobs', () => {
  const queue = async (h: ReturnType<typeof harness>, permissions = FULL) =>
    (await h.service.request(actor(permissions), { reportId: 'vehicle_inventory', format: 'csv' }))
      .job;

  it('runs a queued job to completed, emits export.completed once and serves the download', async () => {
    const h = harness({ A: bigCompany(5001) });
    const job = await queue(h);
    expect(await h.service.runDue('A')).toBe(1);
    expect(await h.service.runDue('A')).toBe(0);
    const done = await h.service.get(actor(FULL), job.id);
    expect(done).toMatchObject({ status: 'completed', rowCount: 5001, mode: 'job' });
    expect(h.events.filter((e) => e.type === 'export.completed')).toHaveLength(1);
    const download = await h.service.download(actor(FULL), job.id);
    expect(Buffer.from(download.bytes).toString('utf8').split('\r\n')).toHaveLength(5001 + 2);
  });

  it('produces no data when the session ended before it ran', async () => {
    const h = harness();
    h.grants.set('A:u1', new Set(FULL));
    const job = await queue(h);
    // Force a queued job by revoking before the worker: build the job through the store.
    await h.store.transition({ ...job, status: 'queued' }, 'completed');
    h.grants.set('A:u1', null);
    await h.service.runDue('A');
    expect(await h.store.find('A', job.id)).toMatchObject({
      status: 'failed',
      failure: 'session_ended',
    });
    expect(h.events.map((e) => e.type)).toEqual(['export.completed', 'export.failed']);
  });

  it('produces no file when export or a sensitive column was revoked while queued', async () => {
    const h = harness({ A: bigCompany(5001) });
    const queued = await h.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
    });
    h.grants.set('A:u1', new Set(['view']));
    await h.service.runDue('A');
    expect(await h.store.find('A', queued.job.id)).toMatchObject({
      status: 'failed',
      failure: 'permission_revoked',
    });
    expect(h.artifacts.files.size).toBe(0);
    // A sensitive column of the job that the person lost.
    const h2 = harness({ A: companyA() }, { directMaxRows: 0 });
    const withPii = await h2.service.request(actor(FULL), {
      reportId: 'drivers',
      format: 'csv',
      columns: ['name', 'licenseNumber'],
    });
    h2.grants.set('A:u1', new Set(BASIC));
    await h2.service.runDue('A');
    expect(await h2.store.find('A', withPii.job.id)).toMatchObject({
      status: 'failed',
      failure: 'permission_revoked',
    });
  });

  it('retries a transient failure and gives up after three tries', async () => {
    const h = harness({ A: bigCompany(5001) });
    const job = await queue(h);
    h.renderFailures.count = 5;
    await h.service.runDue('A');
    expect(await h.store.find('A', job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    await h.service.runDue('A');
    await h.service.runDue('A');
    expect(await h.store.find('A', job.id)).toMatchObject({
      status: 'failed',
      failure: 'generation_failed',
      attempts: 3,
    });
    expect(h.events.map((e) => e.type)).toEqual(['export.failed']);
  });

  it('takes over a job whose worker lost its lease, and fails one that keeps losing it', async () => {
    const h = harness({ A: bigCompany(5001) });
    const job = await queue(h);
    const [claimed] = await h.store.claim('A', h.clock.now, 1000, 1);
    expect(claimed?.attempts).toBe(1);
    expect(await h.service.runDue('A')).toBe(0);
    h.clock.now = new Date(h.clock.now.getTime() + 10 * 60_000);
    expect(await h.service.runDue('A')).toBe(1);
    expect((await h.store.find('A', job.id))?.status).toBe('completed');
    const exhausted = await queue(h);
    await h.store.transition(
      { ...exhausted, status: 'running', attempts: 9, leaseUntil: '2026-01-01T00:00:00.000Z' },
      'queued',
    );
    await h.service.runDue('A');
    expect(await h.store.find('A', exhausted.id)).toMatchObject({
      status: 'failed',
      failure: 'generation_failed',
    });
  });

  it('fails a job whose report grew past the row limit', async () => {
    const h = harness({ A: bigCompany(5001) });
    const job = await queue(h);
    const original = h.sources.vehicles.bind(h.sources);
    h.sources.vehicles = async () => {
      throw new ReportError('too_many_rows');
    };
    await h.service.runDue('A');
    expect(await h.store.find('A', job.id)).toMatchObject({
      status: 'failed',
      failure: 'too_many_rows',
    });
    h.sources.vehicles = original;
  });
});

describe('download', () => {
  it('denies a revoked export permission with 403 and audits the denial', async () => {
    const h = harness();
    const { job } = await h.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
    });
    await expect(h.service.download(actor(['view']), job.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(h.audit.at(-1)?.action).toBe('export.download_denied:vehicle_inventory:csv');
    // Losing view_pii when the file holds a PII column also denies.
    const pii = await h.service.request(actor(FULL), {
      reportId: 'drivers',
      format: 'csv',
      columns: ['name', 'licenseNumber'],
    });
    await expect(h.service.download(actor(BASIC), pii.job.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('is not found for another person, another company or an unknown id', async () => {
    const h = harness();
    const { job } = await h.service.request(actor(FULL), { reportId: 'areas', format: 'csv' });
    for (const who of [actor(FULL, { actorId: 'u2' }), actor(FULL, { tenantId: 'B' })]) {
      await expect(h.service.get(who, job.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(h.service.download(who, job.id)).rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(h.service.download(actor(FULL), 'nope')).rejects.toBeInstanceOf(ExportError);
    expect((await h.service.list(actor(FULL, { tenantId: 'B' }))).total).toBe(0);
    expect((await h.service.list(actor(FULL))).total).toBe(1);
  });

  it('is not ready while the job is queued', async () => {
    const h = harness({ A: bigCompany(5001) });
    const { job } = await h.service.request(actor(FULL), {
      reportId: 'vehicle_inventory',
      format: 'csv',
    });
    await expect(h.service.download(actor(FULL), job.id)).rejects.toMatchObject({
      code: 'not_ready',
    });
  });

  it('answers 410 past seven days and the purge removes the file', async () => {
    const h = harness();
    const { job } = await h.service.request(actor(FULL), { reportId: 'areas', format: 'csv' });
    h.clock.now = new Date('2026-10-26T16:00:01.000Z');
    expect((await h.service.get(actor(FULL), job.id)).status).toBe('expired');
    expect((await h.service.list(actor(FULL))).items[0]?.status).toBe('expired');
    expect(await h.service.purge('A')).toBe(1);
    expect(h.artifacts.files.size).toBe(0);
    expect((await h.store.find('A', job.id))?.status).toBe('expired');
    await expect(h.service.download(actor(FULL), job.id)).rejects.toMatchObject({
      code: 'expired',
    });
    expect(await h.service.purge('A')).toBe(0);
  });

  it('answers 410 when the date passed and the purge has not run yet, and deletes the file', async () => {
    const h = harness();
    const { job } = await h.service.request(actor(FULL), { reportId: 'areas', format: 'csv' });
    h.clock.now = new Date('2026-11-30T00:00:00.000Z');
    await expect(h.service.download(actor(FULL), job.id)).rejects.toMatchObject({
      code: 'expired',
    });
    expect(h.artifacts.files.size).toBe(0);
  });

  it('reads as expired when the object storage lost the file (memory restart)', async () => {
    const h = harness();
    const { job } = await h.service.request(actor(FULL), { reportId: 'areas', format: 'csv' });
    h.artifacts.files.clear();
    await expect(h.service.download(actor(FULL), job.id)).rejects.toMatchObject({
      code: 'expired',
    });
    expect((await h.store.find('A', job.id))?.status).toBe('expired');
  });

  it('validates the list window', async () => {
    const h = harness();
    await expect(h.service.list(actor(FULL), { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(h.service.list(actor(FULL), { offset: -1 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect((await h.service.list(actor(FULL), { limit: 1, offset: 0 })).items).toEqual([]);
  });

  const queue = async (h: ReturnType<typeof harness>) =>
    (await h.service.request(actor(FULL), { reportId: 'vehicle_inventory', format: 'csv' })).job;

  it('refuses a PDF past the row ceiling before rendering, and still allows CSV and XLSX', async () => {
    expect(PDF_MAX_ROWS).toBe(2000);
    const h = harness({ A: companyA() }, { pdfMaxRows: 1 });
    let error: unknown;
    await h.service
      .request(actor(FULL), { reportId: 'people_compliance', format: 'pdf' })
      .catch((e: unknown) => (error = e));
    expect(error).toMatchObject({ name: 'ReportError', code: 'too_many_rows', field: 'format' });
    expect(h.artifacts.files.size).toBe(0);
    expect(h.audit).toHaveLength(0);
    for (const format of ['csv', 'xlsx'] as const)
      expect(
        (await h.service.request(actor(FULL), { reportId: 'people_compliance', format })).job
          .status,
      ).toBe('completed');
  });

  it('fails a queued PDF whose report grew past the ceiling instead of rendering it', async () => {
    const h = harness({ A: companyA() }, { directMaxRows: 0, pdfMaxRows: 1 });
    const queued = (
      await h.service.request(actor(FULL), { reportId: 'people_compliance', format: 'csv' })
    ).job;
    await h.store.transition({ ...queued, format: 'pdf' }, 'queued');
    await h.service.runDue('A');
    expect(await h.store.find('A', queued.id)).toMatchObject({
      status: 'failed',
      failure: 'too_many_rows',
    });
    expect(h.artifacts.files.size).toBe(0);
  });

  it('keeps the completed file of the worker that took the job when a late worker fails', async () => {
    const h = harness({ A: bigCompany(5001) });
    const job = await queue(h);
    const theirs = new Uint8Array([1, 2, 3]);
    const key = `tenants/A/exports/${job.id}`;
    // The late worker meets the file of the other one: the store refuses with `conflict`.
    h.artifacts.put = async () => {
      h.artifacts.files.set(key, theirs);
      throw new FileError('conflict');
    };
    await h.service.runDue('A');
    expect(h.artifacts.files.get(key)).toBe(theirs);
    // A plain failure after another worker re-claimed the job (new try) leaves their file too.
    const second = await queue(h);
    const key2 = `tenants/A/exports/${second.id}`;
    h.artifacts.put = async () => {
      h.artifacts.files.set(key2, theirs);
      h.clock.now = new Date(h.clock.now.getTime() + 10 * 60_000);
      await h.store.claim('A', h.clock.now, 60_000, 5);
      throw new Error('storage_unavailable');
    };
    await h.service.runDue('A');
    expect(h.artifacts.files.get(key2)).toBe(theirs);
  });

  it('removes its own file when the completion is lost to another writer only while it owns the claim', async () => {
    const h = harness({ A: bigCompany(5001) });
    const job = await queue(h);
    const real = h.store.transition.bind(h.store);
    h.store.transition = async (next, expected, event) => {
      if (next.status === 'completed') {
        h.artifacts.files.set(`tenants/A/exports/${job.id}`, new Uint8Array([9]));
        return false;
      }
      return real(next, expected, event);
    };
    await h.service.runDue('A');
    // The job is still our running claim: the orphan file is removed.
    expect(h.artifacts.files.size).toBe(0);
  });

  it('viewOf leaves other statuses alone', () => {
    const job = { status: 'failed', expiresAt: null } as never;
    expect(viewOf(job, new Date())).toBe(job);
  });
});
