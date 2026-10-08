import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { TypeOrmPolicyStore } from '../../../packages/persistence/insurance/src/index.js';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import {
  adminUrl,
  startInsuranceDatabase,
  type InsuranceDatabase,
} from '../../../packages/persistence/insurance/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL insurance store (CI: mysql service,
 * OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset, a hard failure in CI). Vehicles stay
 * in memory: they are only the subject of the policies here. Two signed-in sessions race over the
 * same database. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const P = '/api/insurance-policies';
const AMOUNT = { kind: 'amount', amountMinor: 500000, currency: 'MXN' };

suite('BFF on the real MySQL insurance store', () => {
  let db: InsuranceDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminA2: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let editorA: Browser;
  let tenantA: string;
  let tenantB: string;
  let vehicleA: string;
  let vehicleB: string;

  beforeAll(async () => {
    db = await startInsuranceDatabase('ins');
    const store = new TypeOrmPolicyStore(await db.openRuntime());
    world = createBffWorld({ adapters: { tenants: new InMemoryTenantStore(), insurance: store } });
    tenantA = (await world.tenant('Empresa Alfa', 'subject-admin-a')).tenantId;
    tenantB = (await world.tenant('Empresa Beta', 'subject-admin-b')).tenantId;
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
    await world.member('subject-admin-a', 'editor', 'subject-editor-a');
    adminA = await world.loginAs('subject-admin-a');
    adminA2 = await world.loginAs('subject-admin-a');
    adminB = await world.loginAs('subject-admin-b');
    viewerA = await world.loginAs('subject-viewer-a');
    editorA = await world.loginAs('subject-editor-a');
    const vehicleOf = async (browser: Browser, tag: string) => {
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
      expect(vehicle.status).toBe(201);
      return vehicle.json.id as string;
    };
    vehicleA = await vehicleOf(adminA, 'A');
    vehicleB = await vehicleOf(adminB, 'B');
  }, 120_000);

  afterAll(async () => {
    world?.dispose();
    await db?.close();
  }, 60_000);

  const policy = (vehicleId: string, over: Record<string, unknown> = {}) => ({
    vehicleId,
    insurer: 'Aseguradora Ficticia',
    policyNumber: 'pol-001',
    coverageType: 'comprehensive',
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
    ...over,
  });
  const make = async (browser: Browser, vehicleId: string, over: Record<string, unknown> = {}) => {
    const reply = await browser.post(P, { json: policy(vehicleId, over) });
    expect(reply.status).toBe(201);
    return reply.json as { id: string; version: number };
  };

  it('runs the whole lifecycle and keeps every revision as a separate immutable row', async () => {
    const created = await adminA.post(P, {
      json: policy(vehicleA, { policyNumber: 'pol-lifecycle', deductible: AMOUNT }),
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json).toMatchObject({
      revision: 1,
      version: 1,
      status: 'valid',
      deductible: AMOUNT,
    });
    const edited = await adminA.put(`${P}/${id}`, {
      json: { version: 1, insurer: 'Otra Ficticia' },
    });
    expect(edited.json).toMatchObject({ insurer: 'Otra Ficticia', version: 2 });
    const before = await db.rows(
      'SELECT * FROM opslog_insurance_policy_revisions WHERE company_id = ? AND policy_id = ?',
      [tenantA, id],
    );
    const renewed = await adminA.post(`${P}/${id}/renew`, {
      json: { version: 2, startsOn: '2027-01-01', endsOn: '2027-10-20', deductible: null },
    });
    expect(renewed.json).toMatchObject({
      revision: 2,
      version: 3,
      deductible: null,
      covering: false,
    });
    const rows = await db.rows<{ revision: number }>(
      'SELECT * FROM opslog_insurance_policy_revisions WHERE company_id = ? AND policy_id = ? ORDER BY revision',
      [tenantA, id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before[0]);
    const history = await adminA.get(`${P}/${id}/history`);
    expect(
      history.json.items.map((r: { revision: number; status: string }) => [r.revision, r.status]),
    ).toEqual([
      [2, 'valid'],
      [1, 'replaced'],
    ]);
    expect(history.json.items[1]).toMatchObject({ deductible: AMOUNT });
    const archived = await adminA.post(`${P}/${id}/archive`, { json: { version: 3 } });
    expect(archived.json.archivedAt).not.toBeNull();
    expect(
      (await adminA.get(`${P}?includeArchived=true&vehicleId=${vehicleA}`)).json.items.map(
        (d: { id: string }) => d.id,
      ),
    ).toContain(id);
  });

  it('stores the deductible in typed columns and never serves it without view_costs', async () => {
    const stored = await make(adminA, vehicleA, { policyNumber: 'pol-costs', deductible: AMOUNT });
    const rows = await db.rows<Record<string, unknown>>(
      'SELECT deductible_kind, deductible_value, deductible_currency FROM opslog_insurance_policies WHERE company_id = ? AND id = ?',
      [tenantA, stored.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deductible_kind: 'amount', deductible_currency: 'MXN' });
    expect(Number(rows[0]?.['deductible_value'])).toBe(500000);
    for (const browser of [editorA, viewerA]) {
      const read = await browser.get(`${P}/${stored.id}`);
      expect(read.json).toMatchObject({ hasDeductible: true, deductible: null });
      expect(read.text).not.toContain('500000');
    }
    expect((await editorA.post(P, { json: policy(vehicleA, { deductible: AMOUNT }) })).status).toBe(
      403,
    );
  });

  it('stores the company in every row and no row of one company is reachable from the other', async () => {
    const mine = await make(adminA, vehicleA, { insurer: 'Solo alfa' });
    const theirs = await make(adminB, vehicleB, { insurer: 'Solo beta' });
    const rows = await db.rows<{ company_id: string; id: string }>(
      'SELECT company_id, id FROM opslog_insurance_policies WHERE id IN (?, ?)',
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
      ['PUT', '', { version: 1, insurer: 'Robada' }],
      ['POST', '/renew', { version: 1, startsOn: '2027-01-01', endsOn: '2030-01-01' }],
      ['POST', '/archive', { version: 1 }],
    ] as [string, string, unknown][]) {
      const foreign = await adminB.send(method, `${P}/${mine.id}${suffix}`, { json });
      const missing = await adminB.send(method, `${P}/${unknown}${suffix}`, { json });
      expect(foreign.status, suffix).toBe(404);
      expect({ ...foreign.json, correlationId: '' }).toEqual({
        ...missing.json,
        correlationId: '',
      });
    }
    expect((await adminA.get(`${P}/${mine.id}`)).json.insurer).toBe('Solo alfa');
    const insurersB = (await adminB.get(P)).json.items.map((d: { insurer: string }) => d.insurer);
    expect(insurersB).toContain('Solo beta');
    expect(insurersB).not.toContain('Solo alfa');
  });

  it('answers the same 422 for a vehicle of another company and an unknown vehicle', async () => {
    const replies = [
      await adminA.post(P, { json: policy(vehicleB) }),
      await adminA.post(P, { json: policy('00000000-0000-4000-8000-000000000000') }),
    ];
    for (const reply of replies) {
      expect(reply.status).toBe(422);
      expect(reply.json).toMatchObject({ code: 'invalid_vehicle', field: 'vehicle_id' });
    }
    expect(new Set(replies.map((r) => JSON.stringify({ ...r.json, correlationId: '' }))).size).toBe(
      1,
    );
  });

  it('filters by derived status and covered day in the database with the same boundaries as the domain', async () => {
    // the clock is 2026-10-06: the expiring window is 2026-10-06 ..= 2026-11-05, both inclusive
    for (const [key, startsOn, endsOn] of [
      ['expired', '2025-01-01', '2026-10-05'],
      ['today', '2026-01-01', '2026-10-06'],
      ['edge', '2026-01-01', '2026-11-05'],
      ['valid', '2026-01-01', '2026-11-06'],
      ['starts-today', '2026-10-06', '2027-10-05'],
      ['starts-tomorrow', '2026-10-07', '2027-10-06'],
    ] as const)
      await make(adminA, vehicleA, { insurer: `Borde ${key}`, startsOn, endsOn });
    const names = async (query: string) =>
      (await adminA.get(`${P}?${query}&vehicleId=${vehicleA}&limit=100`)).json.items
        .map((d: { insurer: string }) => d.insurer)
        .filter((t: string) => t.startsWith('Borde '));
    expect(await names('status=expired')).toEqual(['Borde expired']);
    expect(await names('status=expiring')).toEqual(['Borde today', 'Borde edge']);
    expect(await names('status=valid')).toEqual([
      'Borde valid',
      'Borde starts-today',
      'Borde starts-tomorrow',
    ]);
    expect(await names('coversOn=2026-10-06')).toEqual([
      'Borde today',
      'Borde edge',
      'Borde valid',
      'Borde starts-today',
    ]);
    expect(await names('coversOn=2026-10-05')).toEqual([
      'Borde expired',
      'Borde today',
      'Borde edge',
      'Borde valid',
    ]);
    expect(await names('coversOn=2026-10-07&status=expiring')).toEqual(['Borde edge']);
  });

  it('lets exactly one of several concurrent renewals from two sessions win', async () => {
    const p = await make(adminA, vehicleA, { insurer: 'Carrera' });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? adminA : adminA2).post(`${P}/${p.id}/renew`, {
          json: { version: 1, startsOn: '2027-01-01', endsOn: `${2028 + i}-01-01` },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.json.code === 'stale_version')).toHaveLength(
      7,
    );
    const history = await adminA.get(`${P}/${p.id}/history`);
    expect(history.json.total).toBe(2);
    const stored = await db.rows<{ revision: number; version: number }>(
      'SELECT revision, version FROM opslog_insurance_policies WHERE company_id = ? AND id = ?',
      [tenantA, p.id],
    );
    expect(stored).toEqual([{ revision: 2, version: 2 }]);
  });

  it('serializes an archive racing an edit: one wins, the other is stale', async () => {
    const p = await make(adminA, vehicleA, { insurer: 'Archivo carrera' });
    const [archived, edited] = await Promise.all([
      adminA.post(`${P}/${p.id}/archive`, { json: { version: 1 } }),
      adminA2.put(`${P}/${p.id}`, { json: { version: 1, insurer: 'Edicion carrera' } }),
    ]);
    expect([archived.status, edited.status].sort()).toEqual([200, 409]);
  });

  it('enforces roles on the real store: viewers read, editors change, only admins archive', async () => {
    const p = await make(adminA, vehicleA, { insurer: 'Roles' });
    expect((await viewerA.get(`${P}/${p.id}`)).status).toBe(200);
    expect(
      (await viewerA.put(`${P}/${p.id}`, { json: { version: 1, insurer: 'xx' } })).status,
    ).toBe(403);
    expect((await editorA.post(`${P}/${p.id}/archive`, { json: { version: 1 } })).status).toBe(403);
    expect(
      (await editorA.put(`${P}/${p.id}`, { json: { version: 1, insurer: 'Editor' } })).status,
    ).toBe(200);
    expect((await adminA.get(`${P}/${p.id}`)).json).toMatchObject({
      insurer: 'Editor',
      version: 2,
    });
  });

  it('keeps insurers, numbers and amounts out of the audit trail', async () => {
    await adminA.post(P, {
      json: policy(vehicleA, {
        insurer: 'Aseguradora-auditoria-99',
        policyNumber: 'POL-AUDITORIA-99',
        deductible: { kind: 'amount', amountMinor: 7654321, currency: 'USD' },
      }),
    });
    const text = JSON.stringify(
      await db.rows(
        `SELECT action, data FROM ${AUDIT_TABLES.local} WHERE tenant_id = ? AND entity_type = ?`,
        [tenantA, 'insurance_policy'],
      ),
    );
    expect(text).toContain('insurance_policy.created');
    for (const fragment of ['Aseguradora-auditoria-99', 'POL-AUDITORIA-99', '7654321'])
      expect(text).not.toContain(fragment);
  });
});
