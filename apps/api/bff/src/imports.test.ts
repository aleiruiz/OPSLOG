import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BFF_IMPORT_ENTITIES,
  BFF_IMPORT_MAX_BODY_BYTES,
  BFF_IMPORT_MAX_ROWS,
  BFF_IMPORT_MODES,
  BFF_IMPORT_OUTCOMES,
  BFF_IMPORT_ROW_CODES,
  BFF_IMPORT_STATUSES,
  BFF_IMPORT_TEMPLATES,
  BFF_ROUTES,
} from '../../../../packages/contracts/src/index.js';
import {
  IMPORT_COLUMNS,
  IMPORT_ENTITIES,
  IMPORT_MODES,
  IMPORT_STATUSES,
  MAX_ROWS,
  ROW_ISSUE_CODES,
  ROW_OUTCOMES,
} from '../../../../packages/domain/imports/src/index.js';
import { createBffWorld, type BffWorld, type Browser, type Reply } from './test-support.js';

let world: BffWorld;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

interface Side {
  readonly area: string;
}

interface Fixture {
  readonly adminA: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly piiA: Browser;
  readonly adminB: Browser;
  readonly a: Side;
  readonly b: Side;
}

async function side(browser: Browser): Promise<Side> {
  const area = await browser.post('/api/areas', { json: { name: 'Flota' } });
  return { area: area.json.id as string };
}

async function fixture(): Promise<Fixture> {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  await world.member('subject-admin-a', 'pii_reader', 'subject-pii-a');
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  return {
    adminA,
    adminB,
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    piiA: await world.loginAs('subject-pii-a'),
    a: await side(adminA),
    b: await side(adminB),
  };
}

const P = '/api/imports';
const pad = (n: number) => String(n).padStart(4, '0');

const vehicleRow = (area: string, n: number, over: Record<string, unknown> = {}) => ({
  economicNumber: `IMP-${pad(n)}`,
  plate: `IMP${pad(n)}`,
  make: 'Toyota',
  model: 'Hilux',
  year: '2022',
  areaId: area,
  odometerKm: '120',
  ...over,
});

const employeeRow = (area: string, n: number, over: Record<string, unknown> = {}) => ({
  kind: 'driver',
  firstName: 'Ana',
  lastName: `Prueba${'ABCDEFGHIJKLMNOP'[n]}`,
  areaId: area,
  employeeNumber: `EMP-${pad(n)}`,
  ...over,
});

const submit = (browser: Browser, json: unknown) => browser.post(P, { json });
const withoutId = (reply: Reply) => ({ ...reply.json, correlationId: '' });

const vehiclesTotal = async (browser: Browser): Promise<number> =>
  (await browser.get('/api/vehicles?includeArchived=true&limit=100')).json.total as number;

describe('contract', () => {
  it('declares the same vocabulary and template as the domain', () => {
    expect([...BFF_IMPORT_ENTITIES]).toEqual([...IMPORT_ENTITIES]);
    expect([...BFF_IMPORT_MODES]).toEqual([...IMPORT_MODES]);
    expect([...BFF_IMPORT_STATUSES]).toEqual([...IMPORT_STATUSES]);
    expect([...BFF_IMPORT_OUTCOMES]).toEqual([...ROW_OUTCOMES]);
    expect([...BFF_IMPORT_ROW_CODES]).toEqual([...ROW_ISSUE_CODES]);
    expect(BFF_IMPORT_MAX_ROWS).toBe(MAX_ROWS);
    for (const entity of IMPORT_ENTITIES) {
      expect([...BFF_IMPORT_TEMPLATES[entity].required]).toEqual([
        ...IMPORT_COLUMNS[entity].required,
      ]);
      expect([...BFF_IMPORT_TEMPLATES[entity].optional]).toEqual([
        ...IMPORT_COLUMNS[entity].optional,
      ]);
    }
  });

  it('protects every import route: reads need a session, the write also the CSRF token', () => {
    const routes = Object.entries(BFF_ROUTES).filter(([id]) => id.startsWith('imports.'));
    expect(routes).toHaveLength(5);
    for (const [id, definition] of routes)
      expect([id, definition.kind]).toEqual([
        id,
        definition.method === 'GET' ? 'session' : 'session-csrf',
      ]);
  });
});

describe('US-016: dry run and import of 300 vehicles', () => {
  it('validates without writing, then imports the 288 valid rows once, with the 12 errors reported', async () => {
    const { adminA, a } = await fixture();
    // Six plates are already registered; six rows carry an impossible date.
    for (let n = 1; n <= 6; n += 1)
      expect(
        (
          await adminA.post('/api/vehicles', {
            json: { ...vehicleRow(a.area, n), year: 2022, odometerKm: 5, vin: null },
          })
        ).status,
      ).toBe(201);
    const rows = Array.from({ length: 300 }, (_, i) => {
      const n = i + 1;
      if (n <= 6) return vehicleRow(a.area, n, { economicNumber: `NEW-${pad(n)}` });
      if (n > 294) return vehicleRow(a.area, n, { registeredOn: '2026-02-31' });
      return vehicleRow(a.area, n);
    });
    const before = await vehiclesTotal(adminA);
    const dry = await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows });
    expect(dry.status).toBe(201);
    expect(dry.headers['cache-control']).toBe('no-store');
    expect(dry.json).toMatchObject({
      replayed: false,
      job: {
        entity: 'vehicle',
        mode: 'dry_run',
        status: 'validated',
        totalRows: 300,
        validRows: 288,
        invalidRows: 12,
        importedRows: 0,
        createdBy: expect.stringMatching(/^user-/),
        version: 2,
      },
    });
    expect(dry.json.job).not.toHaveProperty('tenantId');
    expect(dry.json.job).not.toHaveProperty('fingerprint');
    expect(dry.json.job).not.toHaveProperty('idempotencyKey');
    // Nothing was written.
    expect(await vehiclesTotal(adminA)).toBe(before);
    const jobId = dry.json.job.id as string;
    const errors = await adminA.get(`${P}/${jobId}/rows?outcome=invalid&limit=25`);
    expect(errors.status).toBe(200);
    expect(errors.json).toMatchObject({
      total: 12,
      sort: { field: 'rowNumber', direction: 'asc' },
    });
    expect(errors.json.items).toHaveLength(12);
    expect(
      errors.json.items
        .slice(0, 6)
        .map((r: { rowNumber: number; code: string; columns: string[] }) => [
          r.rowNumber,
          r.code,
          r.columns,
        ]),
    ).toEqual(Array.from({ length: 6 }, (_, i) => [i + 1, 'duplicate', ['plate']]));
    expect(
      errors.json.items
        .slice(6)
        .map((r: { rowNumber: number; code: string; columns: string[] }) => [
          r.rowNumber,
          r.code,
          r.columns,
        ]),
    ).toEqual(Array.from({ length: 6 }, (_, i) => [295 + i, 'invalid_value', ['registeredOn']]));
    // No cell of any row comes back.
    expect(errors.text).not.toMatch(/IMP-|Toyota|Hilux|2026-02-31/);

    // Confirm the validated rows: only the valid ones are imported, and only once.
    const commit = {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'import-300-attempt-1',
      dryRunJobId: jobId,
      rows,
    };
    const done = await submit(adminA, commit);
    expect(done.status).toBe(201);
    expect(done.json).toMatchObject({
      replayed: false,
      job: { status: 'imported', validRows: 288, invalidRows: 12, importedRows: 288 },
    });
    expect(await vehiclesTotal(adminA)).toBe(before + 288);
    const replay = await submit(adminA, commit);
    expect(replay.json).toMatchObject({ replayed: true, job: { id: done.json.job.id } });
    expect(await vehiclesTotal(adminA)).toBe(before + 288);
    // A second run with a new key finds every row already registered: nothing extra is created.
    const rerun = await submit(adminA, { ...commit, idempotencyKey: 'import-300-attempt-2' });
    expect(rerun.json.job).toMatchObject({ status: 'failed', importedRows: 0, invalidRows: 300 });
    expect(await vehiclesTotal(adminA)).toBe(before + 288);
    // The audit-visible history: a started and a closing event, newest first.
    const history = await adminA.get(`${P}/${done.json.job.id}/history`);
    expect(history.json.items.map((e: { seq: number; kind: string }) => [e.seq, e.kind])).toEqual([
      [2, 'imported'],
      [1, 'started'],
    ]);
    expect(history.json.items[0]).toMatchObject({ acceptedRows: 288, rejectedRows: 12 });
    // The report of the imported rows links the created vehicles.
    const imported = await adminA.get(`${P}/${done.json.job.id}/rows?outcome=imported&limit=25`);
    expect(imported.json.total).toBe(288);
    const first = imported.json.items[0] as { entityId: string };
    expect((await adminA.get(`/api/vehicles/${first.entityId}`)).status).toBe(200);
  }, 60_000);

  it('lists the jobs, newest first, with signed cursors bound to the tenant and the filters', async () => {
    const { adminA, adminB, a, b } = await fixture();
    for (let n = 1; n <= 27; n += 1)
      await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(a.area, n)] });
    await submit(adminB, { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(b.area, 1)] });
    const page1 = await adminA.get(P);
    expect(page1.json).toMatchObject({
      total: 27,
      sort: { field: 'createdAt', direction: 'desc' },
    });
    expect(page1.json.items).toHaveLength(25);
    const cursor = page1.json.nextCursor as string;
    const page2 = await adminA.get(`${P}?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items).toHaveLength(2);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.items, ...page2.json.items].map((job: { id: string }) => job.id);
    expect(new Set(ids).size).toBe(27);
    for (const path of [
      `${P}?cursor=${encodeURIComponent(cursor)}&status=validated`,
      `${P}?cursor=${encodeURIComponent(cursor)}&limit=50`,
      `${P}?cursor=${encodeURIComponent(cursor)}&entity=vehicle`,
      `${P}?cursor=${encodeURIComponent(`${cursor}x`)}`,
      `${P}?cursor=garbage`,
      `${P}?entity=area`,
      `${P}?status=done`,
      `${P}?limit=7`,
      `${P}?unknown=1`,
      `${P}?entity=vehicle&entity=employee`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminB.get(`${P}?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    expect((await adminA.get(`${P}?entity=employee`)).json.total).toBe(0);
    expect((await adminA.get(`${P}?entity=vehicle&status=validated`)).json.total).toBe(27);
    expect((await adminB.get(P)).json.total).toBe(1);
  });

  it('pages the per-row report and the history with cursors bound to the job and the filter', async () => {
    const { adminA, a } = await fixture();
    const rows = Array.from({ length: 30 }, (_, i) => vehicleRow(a.area, i + 1));
    const job = (await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows })).json.job;
    const other = (
      await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows: rows.slice(0, 2) })
    ).json.job;
    const page1 = await adminA.get(`${P}/${job.id}/rows`);
    expect(page1.json.items).toHaveLength(25);
    const cursor = page1.json.nextCursor as string;
    const page2 = await adminA.get(`${P}/${job.id}/rows?cursor=${encodeURIComponent(cursor)}`);
    expect(page2.json.items.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([
      26, 27, 28, 29, 30,
    ]);
    expect(page2.json.nextCursor).toBeNull();
    for (const path of [
      `${P}/${other.id}/rows?cursor=${encodeURIComponent(cursor)}`,
      `${P}/${job.id}/rows?cursor=${encodeURIComponent(cursor)}&outcome=valid`,
      `${P}/${job.id}/rows?outcome=maybe`,
      `${P}/${job.id}/rows?limit=7`,
      `${P}/${job.id}/rows?x=1`,
      `${P}/${job.id}/history?cursor=garbage`,
      `${P}/${job.id}/history?limit=7`,
      `${P}/${job.id}/history?outcome=valid`,
      `${P}/${job.id}/history?limit=25&limit=50`,
    ])
      expect((await adminA.get(path)).status, path).toBe(400);
    expect((await adminA.get(`${P}/${job.id}/rows?outcome=valid&limit=50`)).json.total).toBe(30);
    expect((await adminA.get(`${P}/${job.id}/history?limit=25`)).json.nextCursor).toBeNull();
  });
});

describe('modes and idempotency', () => {
  it('commit_all imports nothing while one row is invalid, and everything when all are valid', async () => {
    const { adminA, a } = await fixture();
    const rows = [
      vehicleRow(a.area, 1),
      vehicleRow(a.area, 2, { year: '1800' }),
      vehicleRow(a.area, 3),
    ];
    const rejected = await submit(adminA, {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'all-or-nothing-1',
      rows,
    });
    expect(rejected.json.job).toMatchObject({
      status: 'failed',
      importedRows: 0,
      invalidRows: 1,
      validRows: 2,
    });
    expect(await vehiclesTotal(adminA)).toBe(0);
    const report = await adminA.get(`${P}/${rejected.json.job.id}/rows`);
    expect(report.json.items.map((r: { outcome: string }) => r.outcome)).toEqual([
      'skipped',
      'invalid',
      'skipped',
    ]);
    expect(report.json.items[1]).toMatchObject({ code: 'invalid_value', columns: ['year'] });
    // The corrected file, with a new key, imports.
    const fixed = [rows[0], vehicleRow(a.area, 2), rows[2]];
    const ok = await submit(adminA, {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'all-or-nothing-2',
      rows: fixed,
    });
    expect(ok.json.job).toMatchObject({ status: 'imported', importedRows: 3 });
    expect(await vehiclesTotal(adminA)).toBe(3);
  });

  it('refuses a commit without a key, a key reused for other rows, and a confirmation that no longer matches', async () => {
    const { adminA, adminB, a, b } = await fixture();
    const rows = [vehicleRow(a.area, 1), vehicleRow(a.area, 2)];
    expect((await submit(adminA, { entity: 'vehicle', mode: 'commit_all', rows })).status).toBe(
      400,
    );
    expect(
      (
        await submit(adminA, {
          entity: 'vehicle',
          mode: 'commit_all',
          idempotencyKey: 'short',
          rows,
        })
      ).status,
    ).toBe(400);
    expect(await vehiclesTotal(adminA)).toBe(0);
    const preview = (await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows })).json.job;
    const commit = {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'reuse-key-0001',
      dryRunJobId: preview.id,
    };
    // The rows changed after the preview: not what was validated.
    const changed = await submit(adminA, { ...commit, rows: [rows[0], vehicleRow(a.area, 9)] });
    expect(changed.status).toBe(409);
    expect(changed.json.code).toBe('conflict');
    // Another tenant's preview is as unknown as a missing one.
    const foreign = await submit(adminB, { ...commit, rows: [vehicleRow(b.area, 1)] });
    expect(foreign.status).toBe(404);
    const stolen = await submit(adminB, { ...commit, rows });
    expect(stolen.status).toBe(404);
    const missing = await submit(adminB, {
      ...commit,
      dryRunJobId: 'job-that-does-not-exist',
      rows,
    });
    expect(withoutId(stolen)).toEqual(withoutId(missing));
    expect(await vehiclesTotal(adminA)).toBe(0);
    expect((await submit(adminA, { ...commit, rows })).json.job.status).toBe('imported');
    // The key now belongs to this request alone.
    const other = await submit(adminA, { ...commit, dryRunJobId: undefined, rows: [rows[0]] });
    expect(other.status).toBe(409);
    expect(other.json.code).toBe('conflict');
    const asDryRun = await submit(adminA, {
      entity: 'vehicle',
      mode: 'dry_run',
      idempotencyKey: 'reuse-key-0001',
      rows,
    });
    expect(asDryRun.status).toBe(409);
    expect(await vehiclesTotal(adminA)).toBe(2);
    // A dry run does not confirm a different entity's job, and a commit job is not a preview.
    const doneJob = (await adminA.get(`${P}?status=imported`)).json.items[0] as { id: string };
    expect(
      (
        await submit(adminA, {
          ...commit,
          idempotencyKey: 'reuse-key-0002',
          dryRunJobId: doneJob.id,
          rows,
        })
      ).status,
    ).toBe(409);
  });

  it('applies VIN uniqueness per company, inside the file and against stored vehicles', async () => {
    const { adminA, adminB, a, b } = await fixture();
    const vin = 'AAAAAAAAAA0000001';
    const rows = [
      vehicleRow(a.area, 1, { vin }),
      vehicleRow(a.area, 2, { vin: vin.toLowerCase() }),
      vehicleRow(a.area, 3, { vin: 'AAAAAAAAAA0000003' }),
      vehicleRow(a.area, 4, { vin: 'IOQAAAAAAA0000004' }),
    ];
    const dry = await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows });
    expect(dry.json.job).toMatchObject({ validRows: 2, invalidRows: 2 });
    const errors = (await adminA.get(`${P}/${dry.json.job.id}/rows?outcome=invalid`)).json.items;
    expect(
      errors.map((r: { rowNumber: number; code: string; columns: string[] }) => [
        r.rowNumber,
        r.code,
        r.columns,
      ]),
    ).toEqual([
      [2, 'duplicate_in_file', ['vin']],
      [4, 'invalid_value', ['vin']],
    ]);
    await submit(adminA, {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'vin-company-a1',
      rows,
    });
    // The VIN is taken in company A now…
    const again = await submit(adminA, {
      entity: 'vehicle',
      mode: 'dry_run',
      rows: [vehicleRow(a.area, 7, { vin })],
    });
    const clash = (await adminA.get(`${P}/${again.json.job.id}/rows`)).json.items[0];
    expect(clash).toMatchObject({ outcome: 'invalid', code: 'duplicate', columns: ['vin'] });
    // …and free in company B.
    const other = await submit(adminB, {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'vin-company-b1',
      rows: [vehicleRow(b.area, 1, { vin })],
    });
    expect(other.json.job).toMatchObject({ status: 'imported', importedRows: 1 });
  });

  it('validates the area through the area rule, uniformly for foreign, unknown and inactive areas', async () => {
    const { adminA, adminB, a, b } = await fixture();
    const inactive = await adminA.post('/api/areas', { json: { name: 'Cerrada' } });
    expect(
      (await adminA.post(`/api/areas/${inactive.json.id}/deactivate`, { json: { version: 1 } }))
        .status,
    ).toBe(200);
    const rows = [
      vehicleRow(b.area, 1),
      vehicleRow('00000000-0000-4000-8000-000000000000', 2),
      vehicleRow(inactive.json.id, 3),
      vehicleRow(a.area, 4),
    ];
    const job = (
      await submit(adminA, {
        entity: 'vehicle',
        mode: 'commit_valid',
        idempotencyKey: 'area-rule-0001',
        rows,
      })
    ).json.job;
    expect(job).toMatchObject({ validRows: 1, invalidRows: 3, importedRows: 1 });
    const errors = (await adminA.get(`${P}/${job.id}/rows?outcome=invalid`)).json.items as {
      code: string;
      columns: string[];
    }[];
    expect(new Set(errors.map((r) => JSON.stringify([r.code, r.columns])))).toEqual(
      new Set([JSON.stringify(['invalid_area', ['areaId']])]),
    );
    expect(await vehiclesTotal(adminB)).toBe(0);
  });

  it('accepts a CSV text and refuses malformed ones', async () => {
    const { adminA, a } = await fixture();
    const header = 'economicNumber,plate,make,model,year,areaId,odometerKm,vin';
    const csv = `${header}\r\nCSV-1,CSV001,"Marca, S.A.",Modelo,2021,${a.area},50,\r\nCSV-2,CSV002,Marca,Modelo,2021,${a.area},60,AAAAAAAAAA0000009\r\n`;
    const dry = await submit(adminA, { entity: 'vehicle', mode: 'dry_run', csv });
    expect(dry.json.job).toMatchObject({ validRows: 2, invalidRows: 0 });
    const done = await submit(adminA, {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'csv-import-0001',
      csv,
    });
    expect(done.json.job.importedRows).toBe(2);
    const listed = (await adminA.get('/api/vehicles')).json.items as { make: string }[];
    expect(listed.map((v) => v.make)).toContain('Marca, S.A.');
    for (const bad of [
      `${header},color\r\nx`,
      'plate\r\nX',
      `${header}\r\n"unterminated`,
      `${header}\r\nA,B`,
      '',
      `${header}\r\nA"B,C,D,E,F,G,H,I`,
    ])
      expect(
        (await submit(adminA, { entity: 'vehicle', mode: 'dry_run', csv: bad })).status,
        bad,
      ).toBe(400);
    expect(
      (
        await submit(adminA, {
          entity: 'vehicle',
          mode: 'dry_run',
          csv,
          rows: [vehicleRow(a.area, 1)],
        })
      ).status,
    ).toBe(400);
  });
});

describe('injection and limits', () => {
  it('rejects formula cells and reports only the column, never the cell', async () => {
    const { adminA, a } = await fixture();
    const rows = [
      vehicleRow(a.area, 1, { make: '=HYPERLINK("http://evil.test","x")' }),
      vehicleRow(a.area, 2, { model: '@SUM(1+1)' }),
      vehicleRow(a.area, 3, { plate: '+1+1' }),
      vehicleRow(a.area, 4, { economicNumber: '-2+3' }),
      vehicleRow(a.area, 5, { make: '\t=cmd|x' }),
      vehicleRow(a.area, 6),
    ];
    const dry = await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows });
    expect(dry.json.job).toMatchObject({ validRows: 1, invalidRows: 5 });
    const errors = await adminA.get(`${P}/${dry.json.job.id}/rows?outcome=invalid`);
    expect(
      errors.json.items.map((r: { code: string; columns: string[] }) => [r.code, r.columns]),
    ).toEqual([
      ['formula_injection', ['make']],
      ['formula_injection', ['model']],
      ['formula_injection', ['plate']],
      ['formula_injection', ['economicNumber']],
      ['formula_injection', ['make']],
    ]);
    expect(errors.text).not.toMatch(/HYPERLINK|evil\.test|SUM/);
    const committed = await submit(adminA, {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'formula-run-01',
      rows,
    });
    expect(committed.json.job.importedRows).toBe(1);
    expect(await vehiclesTotal(adminA)).toBe(1);
  });

  it('rejects malformed bodies, a row limit overrun and an oversized body', async () => {
    const { adminA, a } = await fixture();
    const row = vehicleRow(a.area, 1);
    for (const json of [
      {},
      { entity: 'vehicle' },
      { entity: 'vehicle', mode: 'dry_run' },
      { entity: 'vehicle', mode: 'dry_run', rows: [] },
      { entity: 'vehicle', mode: 'dry_run', rows: 'x' },
      { entity: 'vehicle', mode: 'dry_run', rows: [row], tenantId: 'other' },
      { entity: 'vehicle', mode: 'dry_run', rows: [{ ...row, tenantId: 'other' }] },
      { entity: 'vehicle', mode: 'dry_run', rows: [{ ...row, companyId: 'other' }] },
      { entity: 'truck', mode: 'dry_run', rows: [row] },
      { entity: 'vehicle', mode: 'preview', rows: [row] },
      { entity: 'vehicle', mode: 'dry_run', rows: [row], dryRunJobId: 'job-1' },
      { entity: 'vehicle', mode: 'dry_run', rows: [[row]] },
      { entity: 'employee', mode: 'dry_run', rows: [row] },
      {
        entity: 'vehicle',
        mode: 'dry_run',
        rows: Array.from({ length: BFF_IMPORT_MAX_ROWS + 1 }, () => row),
      },
    ])
      expect((await submit(adminA, json)).status, JSON.stringify(json).slice(0, 80)).toBe(400);
    const exact = await submit(adminA, {
      entity: 'vehicle',
      mode: 'dry_run',
      rows: Array.from({ length: BFF_IMPORT_MAX_ROWS }, (_, i) => vehicleRow(a.area, i + 1)),
    });
    expect(exact.json.job.totalRows).toBe(BFF_IMPORT_MAX_ROWS);
    // Bodies above the import limit are refused before authentication, like every other route.
    const huge = await adminA.send('POST', P, { raw: ' '.repeat(BFF_IMPORT_MAX_BODY_BYTES + 1) });
    expect(huge.status).toBe(413);
    const anonymous = world.browser();
    await world.prepare(anonymous);
    expect(
      (await anonymous.send('POST', P, { raw: ' '.repeat(BFF_IMPORT_MAX_BODY_BYTES + 1) })).status,
    ).toBe(413);
    // Other routes keep the small default.
    expect((await adminA.send('POST', '/api/vehicles', { raw: ' '.repeat(20_000) })).status).toBe(
      413,
    );
    expect((await adminA.send('PUT', `${P}/x`, { json: {} })).status).toBe(405);
    expect((await adminA.send('DELETE', `${P}/x`)).status).toBe(405);
    expect((await adminA.get(`${P}/bad%20id`)).status).toBe(404);
  });
});

describe('employees', () => {
  const pii = (n: number) => ({
    idType: 'ine',
    nationalId: `SYNTH-ID-7788-Q${n}`,
    phone: '+52 55 9000 1234',
    email: `ana.prueba${n}@synthetic.example`,
    licenseNumber: `LIC-445566-${n}`,
    licenseType: 'c',
    licenseExpiresOn: '2099-01-31',
  });

  it('imports employees through the employee service and never returns or audits personal data', async () => {
    const { adminA, a } = await fixture();
    const rows = [
      employeeRow(a.area, 1, pii(1)),
      employeeRow(a.area, 2, { ...pii(2), employeeNumber: 'EMP-0001' }),
      employeeRow(a.area, 3, { ...pii(3), email: 'not-an-email' }),
      employeeRow(a.area, 4, { ...pii(4), nationalId: '=1+1' }),
      employeeRow(a.area, 5, { kind: 'dispatcher', ...pii(5) }),
      employeeRow(a.area, 6, { idType: 'ine' }),
      employeeRow(a.area, 7, { kind: 'other' }),
    ];
    const dry = await submit(adminA, { entity: 'employee', mode: 'dry_run', rows });
    expect(dry.json.job).toMatchObject({ totalRows: 7, validRows: 2, invalidRows: 5 });
    const errors = (await adminA.get(`${P}/${dry.json.job.id}/rows?outcome=invalid`)).json.items;
    expect(errors.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([2, 3, 4, 5, 6]);
    expect(errors.find((r: { rowNumber: number }) => r.rowNumber === 3)).toMatchObject({
      code: 'invalid_value',
      columns: ['email'],
    });
    expect(errors.find((r: { rowNumber: number }) => r.rowNumber === 4)).toMatchObject({
      code: 'formula_injection',
      columns: ['nationalId'],
    });
    const done = await submit(adminA, {
      entity: 'employee',
      mode: 'commit_valid',
      idempotencyKey: 'employees-run-01',
      dryRunJobId: dry.json.job.id,
      rows,
    });
    expect(done.json.job).toMatchObject({ status: 'imported', importedRows: 2, invalidRows: 5 });
    // Stored through the service: readable (decrypted) only with the PII permission.
    const imported = (await adminA.get(`${P}/${done.json.job.id}/rows?outcome=imported`)).json
      .items as { entityId: string }[];
    const detail = await adminA.get(`/api/employees/${imported[0]?.entityId}`);
    expect(detail.json.pii).toMatchObject({
      email: 'ana.prueba1@synthetic.example',
      nationalId: 'SYNTH-ID-7788-Q1',
    });
    // Nothing a row carried is in any job surface, error or audit event.
    const surfaces = [
      done.text,
      dry.text,
      (await adminA.get(`${P}/${done.json.job.id}/rows?limit=50`)).text,
      (await adminA.get(`${P}/${done.json.job.id}/history`)).text,
      (await adminA.get(P)).text,
      JSON.stringify(world.errors),
    ].join('\n');
    for (const fragment of [
      'SYNTH-ID-7788',
      'prueba1@synthetic',
      'LIC-445566',
      '9000 1234',
      '5590001234',
      'not-an-email',
    ])
      expect(surfaces).not.toContain(fragment);
    // The employee number repeats a stored one now: caught by a dry run before writing.
    const again = await submit(adminA, {
      entity: 'employee',
      mode: 'dry_run',
      rows: [employeeRow(a.area, 9, { employeeNumber: 'emp-0001' })],
    });
    expect((await adminA.get(`${P}/${again.json.job.id}/rows`)).json.items[0]).toMatchObject({
      code: 'duplicate',
      columns: ['employeeNumber'],
    });
    // An identification stored already is a duplicate at commit time (blind index), reported per row.
    const clash = await submit(adminA, {
      entity: 'employee',
      mode: 'commit_valid',
      idempotencyKey: 'employees-run-02',
      rows: [employeeRow(a.area, 10, pii(1)), employeeRow(a.area, 11, pii(11))],
    });
    expect(clash.json.job).toMatchObject({ importedRows: 1, invalidRows: 1 });
    const rejected = (await adminA.get(`${P}/${clash.json.job.id}/rows?outcome=invalid`)).json
      .items[0];
    expect(rejected).toMatchObject({ rowNumber: 1, code: 'duplicate', columns: ['nationalId'] });
  });

  it('asks for the personal-data permission when a row carries personal data', async () => {
    const { adminA, editorA, viewerA, piiA, a } = await fixture();
    const withPii = { entity: 'employee', mode: 'dry_run', rows: [employeeRow(a.area, 1, pii(1))] };
    const plain = { entity: 'employee', mode: 'dry_run', rows: [employeeRow(a.area, 1)] };
    const before = (await adminA.get(P)).json.total;
    expect((await submit(editorA, withPii)).status).toBe(403);
    expect((await submit(editorA, plain)).status).toBe(201);
    expect((await submit(piiA, withPii)).status).toBe(201);
    expect((await submit(viewerA, plain)).status).toBe(403);
    expect((await adminA.get(P)).json.total).toBe(before + 2);
  });
});

describe('who may do what', () => {
  it('answers 401 without a session and 403 for a missing permission, changing nothing', async () => {
    const { adminA, editorA, viewerA, a } = await fixture();
    const rows = [vehicleRow(a.area, 1)];
    const made = (await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows })).json.job as {
      id: string;
    };
    const anonymous = world.browser();
    await world.prepare(anonymous);
    const calls: [string, string, unknown?][] = [
      ['GET', P],
      ['GET', `${P}/${made.id}`],
      ['GET', `${P}/${made.id}/rows`],
      ['GET', `${P}/${made.id}/history`],
      ['POST', P, { entity: 'vehicle', mode: 'dry_run', rows }],
    ];
    for (const [method, path, json] of calls)
      expect((await anonymous.send(method, path, { json })).status, `${method} ${path}`).toBe(401);
    const denied = await viewerA.post(P, { json: { entity: 'vehicle', mode: 'dry_run', rows } });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'forbidden', message: 'Permission denied' });
    // A viewer reads jobs and results.
    expect((await viewerA.get(`${P}/${made.id}`)).json).toMatchObject({ id: made.id });
    expect((await viewerA.get(`${P}/${made.id}/rows`)).status).toBe(200);
    expect((await viewerA.get(`${P}/${made.id}/history`)).status).toBe(200);
    // An editor imports vehicles with create.
    expect(
      (
        await submit(editorA, {
          entity: 'vehicle',
          mode: 'commit_all',
          idempotencyKey: 'editor-import-01',
          rows,
        })
      ).json.job.importedRows,
    ).toBe(1);
    expect((await adminA.get(P)).json.total).toBe(2);
  });

  it('requires the CSRF token on the import write', async () => {
    const { adminA, a } = await fixture();
    const json = { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(a.area, 1)] };
    for (const csrf of [null, '', 'forged']) {
      const reply = await adminA.send('POST', P, { json, csrf });
      expect(reply.status, String(csrf)).toBe(403);
      expect(reply.json.code).toBe('csrf_failed');
    }
    expect((await adminA.get(P)).json.total).toBe(0);
  });
});

describe('tenant isolation over HTTP', () => {
  it('answers 404 to another tenant exactly as for an unknown id, and keeps jobs apart', async () => {
    const { adminA, adminB, a } = await fixture();
    const job = (
      await submit(adminA, { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(a.area, 1)] })
    ).json.job as { id: string };
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const suffix of ['', '/rows', '/history']) {
      const one = await adminB.get(`${P}/${job.id}${suffix}`);
      const two = await adminB.get(`${P}/${unknown}${suffix}`);
      expect(one.status, suffix).toBe(404);
      expect(withoutId(one)).toEqual(withoutId(two));
    }
    expect((await adminB.get(P)).json.total).toBe(0);
    expect((await adminA.get(`${P}/${job.id}`)).json).toMatchObject({ id: job.id });
    // The same key in two companies are two different jobs.
    const request = { entity: 'vehicle', mode: 'commit_valid', idempotencyKey: 'shared-key-0001' };
    const mine = await submit(adminA, { ...request, rows: [vehicleRow(a.area, 1)] });
    const theirs = await submit(adminB, { ...request, rows: [vehicleRow(a.area, 1)] });
    expect(mine.json.job.id).not.toBe(theirs.json.job.id);
    expect(theirs.json.job).toMatchObject({ status: 'failed', importedRows: 0 });
    expect(await vehiclesTotal(adminB)).toBe(0);
  });
});

describe('audit and logs', () => {
  it('audits the job and every created record by id and action, with no row value', async () => {
    const { adminA, a } = await fixture();
    const events: unknown[] = [];
    const real = world.platform.audit.append.bind(world.platform.audit);
    vi.spyOn(world.platform.audit, 'append').mockImplementation((event) => {
      events.push(event);
      return real(event);
    });
    const rows = [vehicleRow(a.area, 1, { vin: 'AAAAAAAAAA0000001' }), vehicleRow(a.area, 2)];
    const done = await submit(adminA, {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'audit-import-001',
      rows,
    });
    expect(done.status).toBe(201);
    const actions = (events as { action: string; entityType: string }[]).map(
      (e) => `${e.entityType}:${e.action}`,
    );
    expect(actions.sort()).toEqual([
      'import_job:import_job.created',
      'vehicle:vehicle.created',
      'vehicle:vehicle.created',
    ]);
    const text = JSON.stringify(events);
    for (const fragment of ['IMP-0001', 'IMP0001', 'AAAAAAAAAA0000001', 'Toyota', 'Hilux'])
      expect(text).not.toContain(fragment);
    // A replay audits nothing new.
    events.length = 0;
    await submit(adminA, {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'audit-import-001',
      rows,
    });
    expect(events).toEqual([]);
    expect(world.errors).toEqual([]);
  });
});
