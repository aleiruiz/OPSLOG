import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TypeOrmDocumentStore } from '../../../packages/persistence/documents/src/index.js';
import { createMySqlAuditRuntime } from '../../../packages/persistence/audit/src/index.js';
import {
  adminUrl,
  startDocumentsDatabase,
  type DocumentsDatabase,
} from '../../../packages/persistence/documents/src/test-support/mysql.js';
import { TypeOrmPolicyStore } from '../../../packages/persistence/insurance/src/index.js';
import {
  startInsuranceDatabase,
  type InsuranceDatabase,
} from '../../../packages/persistence/insurance/src/test-support/mysql.js';
import { TypeOrmSettingsStore } from '../../../packages/persistence/settings/src/index.js';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import {
  startSettingsDatabase,
  type SettingsDatabase,
} from '../../../packages/persistence/settings/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL documents, insurance and settings stores (CI: mysql
 * service, OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset, a hard failure in CI). Vehicles
 * stay in memory: they are only the subject of the documents and policies here. The alerts are
 * derived by real range queries over the expiry columns. Two signed-in sessions race over the same
 * databases. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const A = '/api/alerts';
const S = '/api/alerts/settings';

suite('BFF on the real MySQL stores: expiry alerts and settings', () => {
  let documents: DocumentsDatabase;
  let policies: InsuranceDatabase;
  let settings: SettingsDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminA2: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let editorA: Browser;
  let tenantA: string;
  let tenantB: string;
  let vehicleA: string;
  let vehicleA2: string;
  let vehicleB: string;

  beforeAll(async () => {
    documents = await startDocumentsDatabase('alr');
    policies = await startInsuranceDatabase('alr');
    settings = await startSettingsDatabase('alr');
    const source = await documents.openRuntime();
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
        documents: new TypeOrmDocumentStore(source),
        insurance: new TypeOrmPolicyStore(await policies.openRuntime()),
        settings: new TypeOrmSettingsStore(await settings.openRuntime()),
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
    const vehicleOf = async (browser: Browser, areaId: string, tag: string) => {
      const vehicle = await browser.post('/api/vehicles', {
        json: {
          economicNumber: `U-${tag}`,
          plate: `ABC${tag}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId,
          odometerKm: 10,
        },
      });
      expect(vehicle.status).toBe(201);
      return vehicle.json.id as string;
    };
    const area = async (browser: Browser, tag: string) =>
      (
        await browser.post('/api/areas', {
          json: { name: `Flota ${tag}`, code: null, parentId: null, responsibleIds: [] },
        })
      ).json.id as string;
    const areaA = await area(adminA, 'A');
    vehicleA = await vehicleOf(adminA, areaA, 'A1');
    vehicleA2 = await vehicleOf(adminA, areaA, 'A2');
    vehicleB = await vehicleOf(adminB, await area(adminB, 'B'), 'B1');
  }, 180_000);

  afterAll(async () => {
    world?.dispose();
    await documents?.close();
    await policies?.close();
    await settings?.close();
  }, 60_000);

  const doc = async (
    browser: Browser,
    ownerId: string,
    expiresOn: string,
    typeCode = 'registration_card',
  ) => {
    const reply = await browser.post('/api/documents', {
      json: { ownerType: 'vehicle', ownerId, typeCode, title: 'Documento de prueba', expiresOn },
    });
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);
    return reply.json as { id: string; version: number };
  };
  const pol = async (browser: Browser, vehicleId: string, endsOn: string, number: string) => {
    const reply = await browser.post('/api/insurance-policies', {
      json: {
        vehicleId,
        insurer: 'Aseguradora Ficticia',
        policyNumber: number,
        coverageType: 'comprehensive',
        startsOn: '2025-01-01',
        endsOn,
      },
    });
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);
    return reply.json as { id: string; version: number };
  };
  const ids = (reply: { json: { items: { subjectId: string }[] } }) =>
    reply.json.items.map((alert) => alert.subjectId);
  const count = async (db: { rows<T>(sql: string): Promise<T[]> }, table: string) =>
    (await db.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n;

  it('derives alerts with real range queries: inclusive last day, 30-day window, archived excluded, no writes', async () => {
    const edge = await doc(adminA, vehicleA, '2026-10-06');
    const last = await doc(adminA, vehicleA, '2026-11-05', 'technical_inspection');
    await doc(adminA, vehicleA, '2026-11-06', 'transport_permit');
    const old = await doc(adminA, vehicleA2, '2026-10-05', 'municipal_authorization');
    const hidden = await doc(adminA, vehicleA2, '2026-10-08', 'ownership_title');
    expect(
      (await adminA.post(`/api/documents/${hidden.id}/archive`, { json: { version: 1 } })).status,
    ).toBe(200);
    const soon = await pol(adminA, vehicleA2, '2026-10-20', 'pol-alr-1');
    const ended = await pol(adminA, vehicleA, '2026-09-01', 'pol-alr-2');
    await pol(adminA, vehicleA, '2027-10-20', 'pol-alr-3');
    await doc(adminB, vehicleB, '2026-10-07');

    const writes = [
      await count(documents, 'opslog_documents'),
      await count(policies, 'opslog_insurance_policies'),
      await count(settings, 'opslog_company_settings'),
    ];
    const reply = await adminA.get(A);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ asOf: '2026-10-06', windowDays: 30, total: 5 });
    expect(
      reply.json.items.map((a: { dueOn: string; severity: string }) => [a.dueOn, a.severity]),
    ).toEqual([
      ['2026-09-01', 'expired'],
      ['2026-10-05', 'expired'],
      ['2026-10-06', 'expiring'],
      ['2026-10-20', 'expiring'],
      ['2026-11-05', 'expiring'],
    ]);
    expect(reply.json.total).toBe(5);
    expect(new Set(ids(reply))).toEqual(new Set([ended.id, old.id, edge.id, soon.id, last.id]));
    expect(ids(await adminA.get(`${A}?severity=expired`))).toEqual([ended.id, old.id]);
    expect(ids(await adminA.get(`${A}?source=insurance_policy&vehicleId=${vehicleA2}`))).toEqual([
      soon.id,
    ]);
    expect([
      await count(documents, 'opslog_documents'),
      await count(policies, 'opslog_insurance_policies'),
      await count(settings, 'opslog_company_settings'),
    ]).toEqual(writes);
    expect((await adminB.get(A)).json.total).toBe(1);
  });

  it('never returns a row of another company, and every stored row carries its company', async () => {
    const mine = await doc(adminA, vehicleA, '2026-10-09', 'technical_inspection');
    const theirs = await doc(adminB, vehicleB, '2026-10-09', 'technical_inspection');
    const rows = await documents.rows<{ company_id: string; id: string }>(
      'SELECT company_id, id FROM opslog_documents WHERE id IN (?, ?)',
      [mine.id, theirs.id],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.company_id]))).toEqual({
      [mine.id]: tenantA,
      [theirs.id]: tenantB,
    });
    expect(ids(await adminA.get(`${A}?limit=100`))).toContain(mine.id);
    expect(ids(await adminA.get(`${A}?limit=100`))).not.toContain(theirs.id);
    expect(ids(await adminB.get(`${A}?limit=100`))).toContain(theirs.id);
    expect(ids(await adminB.get(`${A}?limit=100`))).not.toContain(mine.id);
    // A vehicle of the other company filters to nothing.
    expect((await adminA.get(`${A}?vehicleId=${vehicleB}`)).json.total).toBe(0);
  });

  it('restarts the cycle on renewal with the real stores', async () => {
    const renewing = await doc(adminA, vehicleA2, '2026-10-12', 'transport_permit');
    const key = (
      await adminA.get(`${A}?vehicleId=${vehicleA2}&source=vehicle_document`)
    ).json.items.find((a: { subjectId: string }) => a.subjectId === renewing.id).key as string;
    expect(
      (
        await adminA.post(`/api/documents/${renewing.id}/renew`, {
          json: { version: 1, expiresOn: '2026-10-25' },
        })
      ).status,
    ).toBe(200);
    const after = (
      await adminA.get(`${A}?vehicleId=${vehicleA2}&source=vehicle_document`)
    ).json.items.find((a: { subjectId: string }) => a.subjectId === renewing.id);
    expect(after.key).not.toBe(key);
    expect(after.dueOn).toBe('2026-10-25');
  });

  it('stores the settings per company, narrows the window and audits without values', async () => {
    const before = (await adminA.get(`${A}?limit=100`)).json.total as number;
    expect((await adminA.get(S)).json).toMatchObject({ version: 0, expiryWindowDays: 30 });
    const saved = await adminA.send('PUT', S, {
      json: { version: 0, expiryWindowDays: 3, recipientRoles: ['viewer', 'admin'] },
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ version: 1, recipientRoles: ['admin', 'viewer'] });
    const stored = await settings.rows<Record<string, unknown>>(
      'SELECT company_id, expiry_window_days, recipient_roles, version FROM opslog_company_settings',
    );
    expect(stored).toEqual([
      { company_id: tenantA, expiry_window_days: 3, recipient_roles: 'admin,viewer', version: 1 },
    ]);
    const narrowed = await adminA.get(`${A}?limit=100`);
    expect(narrowed.json.windowDays).toBe(3);
    expect(narrowed.json.total).toBeLessThan(before);
    for (const alert of narrowed.json.items) expect(alert.daysToExpiry).toBeLessThanOrEqual(3);
    expect((await adminB.get(S)).json).toMatchObject({ version: 0, expiryWindowDays: 30 });
    const text = JSON.stringify(
      await settings.rows(
        `SELECT action, data FROM ${AUDIT_TABLES.local} WHERE tenant_id = ? AND action = ?`,
        [tenantA, 'settings.updated'],
      ),
    );
    expect(text).toContain('settings.updated');
    expect(text).not.toContain('admin,viewer');
    expect(text).not.toContain('expiryWindowDays');
    // Back to the default window for the other tests.
    expect(
      (
        await adminA.send('PUT', S, {
          json: { version: 1, expiryWindowDays: 30, recipientRoles: ['admin', 'editor'] },
        })
      ).json.version,
    ).toBe(2);
  });

  it('lets exactly one of several concurrent first writes from two sessions win, and one concurrent replacement', async () => {
    const first = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        adminB.send('PUT', S, {
          json: { version: 0, expiryWindowDays: 1 + i, recipientRoles: ['admin'] },
        }),
      ),
    );
    expect(first.filter((r) => r.status === 200)).toHaveLength(1);
    expect(first.filter((r) => r.status === 409 && r.json.code === 'stale_version')).toHaveLength(
      7,
    );
    const second = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? adminA : adminA2).send('PUT', S, {
          json: { version: 2, expiryWindowDays: 10 + i, recipientRoles: ['editor'] },
        }),
      ),
    );
    expect(second.filter((r) => r.status === 200)).toHaveLength(1);
    expect(second.filter((r) => r.status === 409 && r.json.code === 'stale_version')).toHaveLength(
      7,
    );
    expect((await adminA.get(S)).json.version).toBe(3);
    expect((await adminB.get(S)).json.version).toBe(1);
  });

  it('enforces roles on the real store: everyone reads, only the administrator writes', async () => {
    const version = (await adminA.get(S)).json.version as number;
    const body = { version, expiryWindowDays: 30, recipientRoles: ['admin'] };
    for (const browser of [viewerA, editorA]) {
      expect((await browser.get(S)).status).toBe(200);
      expect((await browser.get(A)).status).toBe(200);
      expect((await browser.send('PUT', S, { json: body })).status).toBe(403);
    }
    expect((await adminA.get(S)).json.version).toBe(version);
    expect((await adminA.send('PUT', S, { json: body })).status).toBe(200);
  });
});
