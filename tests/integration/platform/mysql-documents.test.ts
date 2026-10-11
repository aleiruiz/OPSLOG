import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TypeOrmDocumentStore } from '../../../packages/persistence/documents/src/index.js';
import { createMySqlAuditRuntime } from '../../../packages/persistence/audit/src/index.js';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import {
  adminUrl,
  startDocumentsDatabase,
  type DocumentsDatabase,
} from '../../../packages/persistence/documents/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL documents store (CI: mysql service,
 * OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset, a hard failure in CI). Vehicles and
 * employees stay in memory: they are only owners here. Two signed-in sessions race over the same
 * database. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

suite('BFF on the real MySQL documents store', () => {
  let db: DocumentsDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminA2: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let editorA: Browser;
  let tenantA: string;
  let tenantB: string;
  let vehicleA: string;
  let employeeA: string;
  let vehicleB: string;

  beforeAll(async () => {
    db = await startDocumentsDatabase('docs');
    const source = await db.openRuntime();
    const store = new TypeOrmDocumentStore(source);
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
        documents: store,
        audit: auditRuntime.audit,
        auditRelay: auditRuntime.auditRelay,
        outbox: auditRuntime.outbox,
      },
    });
    tenantA = (await world.tenant('Empresa Alfa', 'subject-admin-a')).tenantId;
    tenantB = (await world.tenant('Empresa Beta', 'subject-admin-b')).tenantId;
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
    await world.member('subject-admin-a', 'editor', 'subject-editor-a');
    adminA = await world.loginAs('subject-admin-a');
    adminA2 = await world.loginAs('subject-admin-a');
    adminB = await world.loginAs('subject-admin-b');
    viewerA = await world.loginAs('subject-viewer-a');
    editorA = await world.loginAs('subject-editor-a');
    const owners = async (browser: Browser, tag: string) => {
      const area = await browser.post('/api/areas', {
        json: { name: `Flota ${tag}`, code: null, parentId: null, responsibleIds: [] },
      });
      const vehicle = await browser.post('/api/vehicles', {
        json: {
          economicNumber: `U-${tag}`,
          plate: `ABC${tag}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId: area.json.id,
          odometerKm: 10,
        },
      });
      const employee = await browser.post('/api/employees', {
        json: { kind: 'other', firstName: 'Luis', lastName: 'Gomez', areaId: area.json.id },
      });
      expect([vehicle.status, employee.status]).toEqual([201, 201]);
      return { vehicle: vehicle.json.id as string, employee: employee.json.id as string };
    };
    const a = await owners(adminA, 'A');
    const b = await owners(adminB, 'B');
    vehicleA = a.vehicle;
    employeeA = a.employee;
    vehicleB = b.vehicle;
  }, 120_000);

  afterAll(async () => {
    world?.dispose();
    await db?.close();
  }, 60_000);

  const card = (ownerId: string, over: Record<string, unknown> = {}) => ({
    ownerType: 'vehicle',
    ownerId,
    typeCode: 'registration_card',
    title: 'Tarjeta de circulación',
    expiresOn: '2027-03-31',
    ...over,
  });
  const make = async (browser: Browser, ownerId: string, over: Record<string, unknown> = {}) => {
    const reply = await browser.post('/api/documents', { json: card(ownerId, over) });
    expect(reply.status).toBe(201);
    return reply.json as { id: string; version: number };
  };

  it('runs the whole lifecycle and keeps every revision as a separate immutable row', async () => {
    const created = await adminA.post('/api/documents', {
      json: card(vehicleA, { issuedOn: '2025-03-31', documentNumber: 'tc-lifecycle' }),
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json).toMatchObject({ revision: 1, version: 1, status: 'valid' });
    const edited = await adminA.put(`/api/documents/${id}`, {
      json: { version: 1, title: 'Otra' },
    });
    expect(edited.json).toMatchObject({ title: 'Otra', version: 2 });
    const before = await db.rows(
      'SELECT * FROM opslog_document_revisions WHERE company_id = ? AND document_id = ?',
      [tenantA, id],
    );
    const renewed = await adminA.post(`/api/documents/${id}/renew`, {
      json: { version: 2, issuedOn: '2026-10-01', expiresOn: '2026-10-20' },
    });
    expect(renewed.json).toMatchObject({ revision: 2, version: 3, status: 'expiring' });
    const rows = await db.rows<{ revision: number }>(
      'SELECT * FROM opslog_document_revisions WHERE company_id = ? AND document_id = ? ORDER BY revision',
      [tenantA, id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before[0]);
    const history = await adminA.get(`/api/documents/${id}/history`);
    expect(
      history.json.items.map((r: { revision: number; status: string }) => [r.revision, r.status]),
    ).toEqual([
      [2, 'expiring'],
      [1, 'replaced'],
    ]);
    const archived = await adminA.post(`/api/documents/${id}/archive`, { json: { version: 3 } });
    expect(archived.json.archivedAt).not.toBeNull();
    expect(
      (
        await adminA.get(
          `/api/documents?includeArchived=true&ownerType=vehicle&ownerId=${vehicleA}`,
        )
      ).json.items.map((d: { id: string }) => d.id),
    ).toContain(id);
  });

  it('stores the company in every row and no row of one company is reachable from the other', async () => {
    const mine = await make(adminA, vehicleA, { title: 'Solo alfa' });
    const theirs = await make(adminB, vehicleB, { title: 'Solo beta' });
    const rows = await db.rows<{ company_id: string; id: string }>(
      'SELECT company_id, id FROM opslog_documents WHERE id IN (?, ?)',
      [mine.id, theirs.id],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.company_id]))).toEqual({
      [mine.id]: tenantA,
      [theirs.id]: tenantB,
    });
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const [method, suffix, json] of [
      ['GET', '', undefined],
      ['GET', '/history', undefined],
      ['PUT', '', { version: 1, title: 'Robado' }],
      ['POST', '/renew', { version: 1, expiresOn: '2030-01-01' }],
      ['POST', '/archive', { version: 1 }],
    ] as [string, string, unknown][]) {
      const foreign = await adminB.send(method, `/api/documents/${mine.id}${suffix}`, { json });
      const missing = await adminB.send(method, `/api/documents/${unknown}${suffix}`, { json });
      expect(foreign.status, suffix).toBe(404);
      expect({ ...foreign.json, correlationId: '' }).toEqual({
        ...missing.json,
        correlationId: '',
      });
    }
    expect((await adminA.get(`/api/documents/${mine.id}`)).json.title).toBe('Solo alfa');
    const titlesB = (await adminB.get('/api/documents')).json.items.map(
      (d: { title: string }) => d.title,
    );
    expect(titlesB).toContain('Solo beta');
    expect(titlesB).not.toContain('Solo alfa');
  });

  it('answers the same 422 for an owner of another company, an unknown owner and a wrong owner type', async () => {
    const replies = [
      await adminA.post('/api/documents', { json: card(vehicleB) }),
      await adminA.post('/api/documents', { json: card('00000000-0000-4000-8000-000000000000') }),
      await adminA.post('/api/documents', {
        json: card(vehicleA, { ownerType: 'employee', typeCode: 'medical_exam' }),
      }),
    ];
    for (const reply of replies) {
      expect(reply.status).toBe(422);
      expect(reply.json).toMatchObject({ code: 'invalid_owner', field: 'owner_id' });
    }
    expect(new Set(replies.map((r) => JSON.stringify({ ...r.json, correlationId: '' }))).size).toBe(
      1,
    );
    const ok = await adminA.post('/api/documents', {
      json: card(employeeA, { ownerType: 'employee', typeCode: 'medical_exam', title: 'Examen' }),
    });
    expect(ok.status).toBe(201);
  });

  it('filters by derived status in the database with the same boundaries as the domain', async () => {
    // the clock is 2026-10-06: the expiring window is 2026-10-06 ..= 2026-11-05, both inclusive
    const ids: Record<string, string> = {};
    for (const [key, expiresOn] of [
      ['expired', '2026-10-05'],
      ['today', '2026-10-06'],
      ['edge', '2026-11-05'],
      ['valid', '2026-11-06'],
    ] as const)
      ids[key] = (await make(adminA, vehicleA, { title: `Borde ${key}`, expiresOn })).id;
    const titles = async (status: string) =>
      (
        await adminA.get(
          `/api/documents?status=${status}&ownerType=vehicle&ownerId=${vehicleA}&limit=100`,
        )
      ).json.items
        .map((d: { title: string }) => d.title)
        .filter((t: string) => t.startsWith('Borde '));
    expect(await titles('expired')).toEqual(['Borde expired']);
    expect(await titles('expiring')).toEqual(['Borde today', 'Borde edge']);
    expect(await titles('valid')).toEqual(['Borde valid']);
  });

  it('lets exactly one of several concurrent renewals from two sessions win', async () => {
    const doc = await make(adminA, vehicleA, { title: 'Carrera' });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? adminA : adminA2).post(`/api/documents/${doc.id}/renew`, {
          json: { version: 1, expiresOn: `${2028 + i}-01-01` },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.json.code === 'stale_version')).toHaveLength(
      7,
    );
    const history = await adminA.get(`/api/documents/${doc.id}/history`);
    expect(history.json.total).toBe(2);
    const stored = await db.rows<{ revision: number; version: number }>(
      'SELECT revision, version FROM opslog_documents WHERE company_id = ? AND id = ?',
      [tenantA, doc.id],
    );
    expect(stored).toEqual([{ revision: 2, version: 2 }]);
  });

  it('serializes an archive racing an edit: one wins, the other is stale', async () => {
    const doc = await make(adminA, vehicleA, { title: 'Archivo carrera' });
    const [archived, edited] = await Promise.all([
      adminA.post(`/api/documents/${doc.id}/archive`, { json: { version: 1 } }),
      adminA2.put(`/api/documents/${doc.id}`, { json: { version: 1, title: 'Edicion carrera' } }),
    ]);
    expect([archived.status, edited.status].sort()).toEqual([200, 409]);
  });

  it('enforces roles on the real store: viewers read, editors change, only admins archive', async () => {
    const doc = await make(adminA, vehicleA, { title: 'Roles' });
    expect((await viewerA.get(`/api/documents/${doc.id}`)).status).toBe(200);
    expect(
      (await viewerA.put(`/api/documents/${doc.id}`, { json: { version: 1, title: 'x' } })).status,
    ).toBe(403);
    expect(
      (await editorA.post(`/api/documents/${doc.id}/archive`, { json: { version: 1 } })).status,
    ).toBe(403);
    expect(
      (await editorA.put(`/api/documents/${doc.id}`, { json: { version: 1, title: 'Editor' } }))
        .status,
    ).toBe(200);
    expect((await adminA.get(`/api/documents/${doc.id}`)).json).toMatchObject({
      title: 'Editor',
      version: 2,
    });
  });

  it('keeps titles and numbers out of the audit trail', async () => {
    await adminA.post('/api/documents', {
      json: card(vehicleA, { title: 'Titulo-auditoria-99', documentNumber: 'NUM-AUDITORIA-99' }),
    });
    const text = JSON.stringify(
      await db.rows(
        `SELECT action, data FROM ${AUDIT_TABLES.local} WHERE tenant_id = ? AND entity_type = ?`,
        [tenantA, 'document'],
      ),
    );
    expect(text).toContain('document.created');
    expect(text).not.toContain('Titulo-auditoria-99');
    expect(text).not.toContain('NUM-AUDITORIA-99');
  });
});
