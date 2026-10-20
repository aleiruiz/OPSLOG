import { afterEach, describe, expect, it } from 'vitest';
import { BFF_ROUTES, bffPath, bffRouteIds } from '../../../../packages/contracts/src/index.js';
import { createBffWorld, type Browser, type BffWorld } from './test-support.js';

let world: BffWorld;
afterEach(() => world?.dispose());

const REPORTS = '/api/v1/reports';
const EXPORTS = '/api/v1/exports';

async function fixture() {
  world = createBffWorld();
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const admin2 = await world.member('subject-admin-a', 'admin', 'subject-admin2-a');
  const adminA = await world.loginAs('subject-admin-a');
  const admin2A = await world.loginAs('subject-admin2-a');
  const viewerA = await world.loginAs('subject-viewer-a');
  const adminB = await world.loginAs('subject-admin-b');
  const area = async (admin: Browser): Promise<string> => {
    const reply = await admin.post('/api/areas', { json: { name: 'Taller' } });
    return reply.json.id as string;
  };
  const areaA = await area(adminA);
  const areaB = await area(adminB);
  const vehicle = async (
    admin: Browser,
    areaId: string,
    economicNumber: string,
    plate: string,
    model = 'NP300',
  ) => {
    const reply = await admin.post('/api/vehicles', {
      json: {
        economicNumber,
        plate,
        make: 'Nissan',
        model,
        year: 2023,
        areaId,
        odometerKm: 5000,
      },
    });
    expect(reply.status, reply.text).toBe(201);
  };
  await vehicle(adminA, areaA, 'ECO-1', 'AAA-001', '=SUM(1+1)');
  await vehicle(adminA, areaA, 'ECO-2', 'AAA-002');
  await vehicle(adminB, areaB, 'ECO-B', 'BBB-001');
  const dispatcher = await adminA.post('/api/employees', {
    json: {
      kind: 'dispatcher',
      firstName: 'Luis',
      lastName: 'Mora',
      areaId: areaA,
      employeeNumber: 'D-1',
      phone: '+52 55 1234 5678',
    },
  });
  expect(dispatcher.status, dispatcher.text).toBe(201);
  return { adminA, admin2A, admin2Id: admin2.identityId, viewerA, adminB };
}

const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString('utf8');

describe('contract', () => {
  it('declares the report and export routes with their protection', () => {
    for (const id of [
      'reports.catalog',
      'reports.preview',
      'reports.export',
      'exports.list',
      'exports.get',
      'exports.download',
    ] as const)
      expect(bffRouteIds).toContain(id);
    expect(BFF_ROUTES['reports.export']).toMatchObject({
      method: 'POST',
      kind: 'session-csrf',
      status: 201,
    });
    expect(BFF_ROUTES['exports.download']).toMatchObject({ method: 'GET', kind: 'session' });
    expect(bffPath('exports.download', { exportId: 'a b' })).toBe('/api/v1/exports/a%20b/download');
  });
});

describe('catalog and preview', () => {
  it('needs a session and lists only the reports and columns the reader may see', async () => {
    const f = await fixture();
    expect((await world.browser().get(REPORTS)).status).toBe(401);
    const admin = await f.adminA.get(REPORTS);
    expect(admin.status, admin.text).toBe(200);
    expect(admin.json.canExport).toBe(true);
    expect(admin.json.reports.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining(['drivers', 'dispatchers', 'vehicle_inventory', 'insurance']),
    );
    expect(admin.json.families.map((x: { id: string }) => x.id)).toContain('workforce');
    const dispatchers = (id: string, reply: typeof admin) =>
      reply.json.reports.find((r: { id: string }) => r.id === id);
    const viewer = await f.viewerA.get(REPORTS);
    expect(viewer.json.canExport).toBe(false);
    const columns = (reply: typeof admin) =>
      dispatchers('dispatchers', reply).columns.map((c: { id: string }) => c.id);
    expect(columns(admin)).toContain('phone');
    expect(columns(viewer)).not.toContain('phone');
  });

  it('previews a page of rows of the own company only', async () => {
    const f = await fixture();
    const reply = await f.adminA.get(
      `${REPORTS}/vehicle_inventory/preview?columns=economicNumber,plate&sort=plate&limit=1`,
    );
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({ total: 2, offset: 0, limit: 1 });
    expect(reply.json.rows).toEqual([['ECO-1', 'AAA-001']]);
    const other = await f.adminB.get(`${REPORTS}/vehicle_inventory/preview?columns=plate`);
    expect(other.json.rows).toEqual([['BBB-001']]);
    const second = await f.adminA.get(
      `${REPORTS}/vehicle_inventory/preview?columns=plate&sort=plate&limit=1&offset=1`,
    );
    expect(second.json.rows).toEqual([['AAA-002']]);
  });

  it('drops a personal column the reader may not see, from the query and the answer', async () => {
    const f = await fixture();
    const reply = await f.viewerA.get(`${REPORTS}/dispatchers/preview?columns=name,phone`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json.columns.map((c: { id: string }) => c.id)).toEqual(['name']);
    expect(reply.text).not.toContain('5678');
    const sorted = await f.viewerA.get(`${REPORTS}/dispatchers/preview?sort=phone`);
    expect(sorted.status).toBe(403);
    const full = await f.adminA.get(`${REPORTS}/dispatchers/preview?columns=name,phone`);
    expect(full.text).toContain('5678');
  });

  it('answers 404 for an unknown report and a uniform 400 for a malformed query', async () => {
    const f = await fixture();
    expect((await f.adminA.get(`${REPORTS}/nope/preview`)).status).toBe(404);
    const bad = [
      '?limit=0',
      '?limit=101',
      '?limit=x',
      '?offset=-1',
      '?columns=',
      '?columns=a,,b',
      '?columns=plate&columns=plate',
      '?direction=up',
      '?sort=a-b',
      '?unknown=1',
      '?status=',
      '?status=active&status=active',
      '?columns=plate,plate',
      `?${Array.from({ length: 21 }, (_, i) => `f${i}=x`).join('&')}`,
    ];
    for (const query of bad) {
      const reply = await f.adminA.get(`${REPORTS}/vehicle_inventory/preview${query}`);
      expect(reply.status, query).toBe(400);
      expect(reply.json.code).toBe('bad_request');
    }
    expect(
      (await f.adminA.get(`${REPORTS}/vehicle_inventory/preview?status=nope`)).text,
    ).not.toContain('nope');
  });
});

describe('exports', () => {
  const create = (admin: Browser, id: string, json: unknown, headers = {}) =>
    admin.post(`${REPORTS}/${id}/exports`, { json, headers });

  it('exports directly, lists it, reads it and downloads a CSV with neutralized formulas', async () => {
    const f = await fixture();
    const made = await create(f.adminA, 'vehicle_inventory', {
      format: 'csv',
      columns: ['economicNumber', 'plate', 'model'],
      sort: 'plate',
    });
    expect(made.status, made.text).toBe(201);
    expect(made.json).toMatchObject({
      reportId: 'vehicle_inventory',
      format: 'csv',
      status: 'completed',
      mode: 'direct',
      rowCount: 2,
      replayed: false,
    });
    expect(made.json).not.toHaveProperty('sessionId');
    expect(made.json).not.toHaveProperty('requestHash');
    const id = made.json.id as string;
    const list = await f.adminA.get(EXPORTS);
    expect(list.json).toMatchObject({ total: 1, offset: 0, limit: 25 });
    expect((await f.adminA.get(`${EXPORTS}/${id}`)).json.id).toBe(id);
    const file = await f.adminA.get(`${EXPORTS}/${id}/download`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="[\w.-]+\.csv"$/);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    const csv = text(file.bytes);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain("'=SUM(1+1)");
    expect(csv).not.toContain(',=SUM');
    expect(csv).not.toContain('BBB-001');
  });

  it('produces xlsx and pdf and refuses a format the report does not offer', async () => {
    const f = await fixture();
    const xlsx = await create(f.adminA, 'vehicle_inventory', { format: 'xlsx' });
    const file = await f.adminA.get(`${EXPORTS}/${xlsx.json.id}/download`);
    expect(
      Buffer.from(file.bytes ?? [])
        .subarray(0, 2)
        .toString('latin1'),
    ).toBe('PK');
    const pdf = await create(f.adminA, 'vehicle_documents', { format: 'pdf' });
    expect(pdf.status, pdf.text).toBe(201);
    const pdfFile = await f.adminA.get(`${EXPORTS}/${pdf.json.id}/download`);
    expect(
      Buffer.from(pdfFile.bytes ?? [])
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');
    expect((await create(f.adminA, 'drivers', { format: 'pdf' })).status).toBe(400);
  });

  it('needs export, never leaks another person or company, and validates the body', async () => {
    const f = await fixture();
    expect((await create(f.viewerA, 'drivers', { format: 'csv' })).status).toBe(403);
    expect((await create(f.adminA, 'nope', { format: 'csv' })).status).toBe(404);
    const bad = [
      {},
      { format: 'ods' },
      { format: 'csv', columns: [] },
      { format: 'csv', columns: ['a-b'] },
      { format: 'csv', columns: 'plate' },
      { format: 'csv', filters: [] },
      { format: 'csv', filters: { status: 3 } },
      { format: 'csv', sort: 7 },
      { format: 'csv', direction: 'up' },
      { format: 'csv', tenantId: 'x' },
    ];
    for (const json of bad)
      expect((await create(f.adminA, 'drivers', json)).status, JSON.stringify(json)).toBe(400);
    const mine = await create(f.adminA, 'drivers', { format: 'csv' });
    const id = mine.json.id as string;
    for (const other of [f.admin2A, f.adminB]) {
      expect((await other.get(`${EXPORTS}/${id}`)).status).toBe(404);
      expect((await other.get(`${EXPORTS}/${id}/download`)).status).toBe(404);
    }
    expect((await f.adminB.get(EXPORTS)).json.total).toBe(0);
    expect((await f.adminA.get(`${EXPORTS}?limit=0`)).status).toBe(400);
    expect((await f.adminA.get(`${EXPORTS}?foo=1`)).status).toBe(400);
  });

  it('is idempotent by Idempotency-Key and answers 409 for the same key with another request', async () => {
    const f = await fixture();
    const headers = { 'idempotency-key': 'export-key-0001' };
    const first = await create(f.adminA, 'drivers', { format: 'csv' }, headers);
    const again = await create(f.adminA, 'drivers', { format: 'csv' }, headers);
    expect(again.json.id).toBe(first.json.id);
    expect(again.json.replayed).toBe(true);
    expect((await f.adminA.get(EXPORTS)).json.total).toBe(1);
    const clash = await create(f.adminA, 'dispatchers', { format: 'csv' }, headers);
    expect(clash.status).toBe(409);
    const malformed = await create(
      f.adminA,
      'drivers',
      { format: 'csv' },
      {
        'idempotency-key': 'x',
      },
    );
    expect(malformed.status).toBe(400);
  });

  it('delivers nothing once the person lost the permissions', async () => {
    const f = await fixture();
    const made = await create(f.admin2A, 'dispatchers', {
      format: 'csv',
      columns: ['name', 'phone'],
    });
    expect(made.status, made.text).toBe(201);
    const ok = await f.admin2A.get(`${EXPORTS}/${made.json.id}/download`);
    expect(text(ok.bytes)).toContain('5678');
    // The person is demoted to a role without `export` and `view_pii`.
    const admin = await world.platform.signIn(await world.principal('subject-admin-a'));
    const token = admin.value?.token as string;
    const changed = await world.platform.changeRole(token, 'corr-role', f.admin2Id, 'viewer');
    expect(changed.ok).toBe(true);
    const denied = await f.admin2A.get(`${EXPORTS}/${made.json.id}/download`);
    // Changing the role ends the person's sessions: nothing is delivered (the 403 of a live session
    // that lost a permission is covered by the export service tests).
    expect(denied.status).toBe(401);
    expect(denied.bytes).toBeUndefined();
    expect(denied.text).not.toContain('5678');
    const again = await world.loginAs('subject-admin2-a');
    const list = await again.get(EXPORTS);
    expect(list.status).toBe(200);
    expect(
      (await again.post(`${REPORTS}/drivers/exports`, { json: { format: 'csv' } })).status,
    ).toBe(403);
  });

  it('answers 410 once the file expired and 404 for an unknown job', async () => {
    const f = await fixture();
    const made = await create(f.adminA, 'drivers', { format: 'csv' });
    expect((await f.adminA.get(`${EXPORTS}/${made.json.id}/download`)).status).toBe(200);
    world.advance(8 * 86_400_000);
    // The session ended with the week; the person signs in again and the file is gone.
    const again = await world.loginAs('subject-admin-a');
    const gone = await again.get(`${EXPORTS}/${made.json.id}/download`);
    expect(gone.status).toBe(410);
    expect(gone.json.code).toBe('gone');
    expect((await again.get(`${EXPORTS}/${made.json.id}`)).json.status).toBe('expired');
    expect((await again.get(`${EXPORTS}/unknown`)).status).toBe(404);
  });
});
