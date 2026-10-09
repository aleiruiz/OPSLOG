import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TypeOrmImportStore } from '../../../packages/persistence/imports/src/index.js';
import { createMySqlAuditRuntime } from '../../../packages/persistence/audit/src/index.js';
import {
  adminUrl,
  startImportsDatabase,
  type ImportsDatabase,
} from '../../../packages/persistence/imports/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL import store (CI: mysql service,
 * OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset). Vehicles stay in memory: they are the
 * records the import creates. Two signed-in sessions race over the same database. Synthetic data only.
 */
const suite = adminUrl ? describe : describe.skip;

const P = '/api/imports';
const pad = (n: number) => String(n).padStart(4, '0');

suite('BFF on the real MySQL import store', () => {
  let db: ImportsDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminA2: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let areaA: string;
  let areaB: string;

  const row = (area: string, n: number, over: Record<string, unknown> = {}) => ({
    economicNumber: `MY-${pad(n)}`,
    plate: `MY${pad(n)}`,
    make: 'Toyota',
    model: 'Hilux',
    year: '2022',
    areaId: area,
    odometerKm: '10',
    ...over,
  });
  const total = async (browser: Browser) =>
    (await browser.get('/api/vehicles?includeArchived=true&limit=25')).json.total as number;

  beforeAll(async () => {
    db = await startImportsDatabase('imp');
    const source = await db.openRuntime();
    const tenants = new InMemoryTenantStore();
    const auditRuntime = createMySqlAuditRuntime({
      listTenantIds: () => tenants.all().map((tenant) => tenant.id),
      resolveRuntime: () => source,
      resolveRelay: () => source,
      resolveReader: () => source,
    });
    world = createBffWorld({
      adapters: {
        tenants,
        imports: new TypeOrmImportStore(source),
        audit: auditRuntime.audit,
        auditRelay: auditRuntime.auditRelay,
      },
    });
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    await world.tenant('Empresa Beta', 'subject-admin-b');
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
    adminA = await world.loginAs('subject-admin-a');
    adminA2 = await world.loginAs('subject-admin-a');
    adminB = await world.loginAs('subject-admin-b');
    viewerA = await world.loginAs('subject-viewer-a');
    areaA = (await adminA.post('/api/areas', { json: { name: 'Flota A' } })).json.id as string;
    areaB = (await adminB.post('/api/areas', { json: { name: 'Flota B' } })).json.id as string;
  }, 120_000);

  afterAll(async () => {
    world?.dispose();
    await db?.close();
  }, 60_000);

  it('validates, imports once, replays and keeps the append-only history', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      i < 3 ? row(areaA, i + 1, { year: '1800' }) : row(areaA, i + 1),
    );
    const before = await total(adminA);
    const dry = await adminA.post(P, { json: { entity: 'vehicle', mode: 'dry_run', rows } });
    expect(dry.status, JSON.stringify(dry.json)).toBe(201);
    expect(dry.json.job).toMatchObject({ status: 'validated', validRows: 37, invalidRows: 3 });
    expect(await total(adminA)).toBe(before);
    const commit = {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'mysql-import-0001',
      dryRunJobId: dry.json.job.id,
      rows,
    };
    const done = await adminA.post(P, { json: commit });
    expect(done.json).toMatchObject({
      replayed: false,
      job: { status: 'imported', importedRows: 37, invalidRows: 3 },
    });
    const replay = await adminA.post(P, { json: commit });
    expect(replay.json).toMatchObject({ replayed: true, job: { id: done.json.job.id } });
    expect((await adminA.post(P, { json: { ...commit, rows: rows.slice(3) } })).status).toBe(409);
    expect(await total(adminA)).toBe(before + 37);
    const errors = await adminA.get(`${P}/${done.json.job.id}/rows?outcome=invalid&limit=25`);
    expect(
      errors.json.items.map((r: { rowNumber: number; code: string }) => [r.rowNumber, r.code]),
    ).toEqual([
      [1, 'invalid_value'],
      [2, 'invalid_value'],
      [3, 'invalid_value'],
    ]);
    const history = await adminA.get(`${P}/${done.json.job.id}/history`);
    expect(history.json.items.map((e: { seq: number; kind: string }) => [e.seq, e.kind])).toEqual([
      [2, 'imported'],
      [1, 'started'],
    ]);
    // Paging the rows through signed cursors.
    const first = await adminA.get(`${P}/${done.json.job.id}/rows?limit=25`);
    const next = await adminA.get(
      `${P}/${done.json.job.id}/rows?limit=25&cursor=${encodeURIComponent(first.json.nextCursor)}`,
    );
    expect(first.json.items).toHaveLength(25);
    expect(next.json.items).toHaveLength(15);
    expect((await viewerA.get(`${P}/${done.json.job.id}`)).status).toBe(200);
    expect((await viewerA.post(P, { json: commit })).status).toBe(403);
  }, 60_000);

  it('runs the same request from two sessions at once and creates each vehicle once', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(areaA, 100 + i));
    const before = await total(adminA);
    const request = {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'mysql-race-00001',
      rows,
    };
    const replies = await Promise.all([
      adminA.post(P, { json: request }),
      adminA2.post(P, { json: request }),
    ]);
    for (const reply of replies) expect([201, 409]).toContain(reply.status);
    expect(
      replies.some((reply) => reply.status === 201 && reply.json.job.status === 'imported'),
    ).toBe(true);
    const settled = await adminA.post(P, { json: request });
    expect(settled.json).toMatchObject({
      replayed: true,
      job: { status: 'imported', importedRows: 20 },
    });
    expect(await total(adminA)).toBe(before + 20);
  }, 60_000);

  it('keeps tenants apart: jobs, keys and areas', async () => {
    const mine = await adminA.post(P, {
      json: {
        entity: 'vehicle',
        mode: 'commit_all',
        idempotencyKey: 'mysql-tenant-001',
        rows: [row(areaA, 200)],
      },
    });
    expect(mine.json.job.status).toBe('imported');
    const theirs = await adminB.post(P, {
      json: {
        entity: 'vehicle',
        mode: 'commit_all',
        idempotencyKey: 'mysql-tenant-001',
        rows: [row(areaB, 200)],
      },
    });
    expect(theirs.json.job).toMatchObject({ status: 'imported', importedRows: 1 });
    expect(theirs.json.job.id).not.toBe(mine.json.job.id);
    expect((await adminB.get(`${P}/${mine.json.job.id}`)).status).toBe(404);
    expect((await adminB.get(`${P}/${mine.json.job.id}/rows`)).status).toBe(404);
    expect((await adminB.get(`${P}/${mine.json.job.id}/history`)).status).toBe(404);
    const crossArea = await adminB.post(P, {
      json: { entity: 'vehicle', mode: 'dry_run', rows: [row(areaA, 201)] },
    });
    expect(crossArea.json.job).toMatchObject({ validRows: 0, invalidRows: 1 });
    expect(
      (await adminB.get(P)).json.items.every((job: { id: string }) => job.id !== mine.json.job.id),
    ).toBe(true);
  });
});
