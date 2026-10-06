import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EnvelopePiiCipher,
  InMemoryTenantStore,
  LocalDevKms,
} from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import type {
  Employee,
  EmployeeHistoryEntry,
} from '../../../packages/domain/employees/src/index.js';
import { TypeOrmAreaStore } from '../../../packages/persistence/areas/src/index.js';
import {
  startAreasDatabase,
  type AreasDatabase,
} from '../../../packages/persistence/areas/src/test-support/mysql.js';
import { TypeOrmEmployeeStore } from '../../../packages/persistence/employees/src/index.js';
import {
  adminUrl,
  startEmployeesDatabase,
  type EmployeesDatabase,
} from '../../../packages/persistence/employees/src/test-support/mysql.js';

/**
 * The BFF and the platform on the real MySQL employees AND areas stores: the people count port of
 * BR-021 and the area gate run against the database (CI: mysql service,
 * OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset, a hard failure in CI). One process, one
 * pool per store; two signed-in sessions race over the same databases. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const SECRETS = {
  nationalId: 'SYNTH-ID-7788-QX',
  phone: '+52 55 9000 1234',
  email: 'ana.perez@synthetic.example',
  licenseNumber: 'LIC-445566-ZZ',
};
const FRAGMENTS = [
  'SYNTH-ID-7788',
  '9000 1234',
  '90001234',
  'synthetic.example',
  'ana.perez',
  'LIC-445566',
];

let serial = 0;
const person = (areaId: string, over: Record<string, unknown> = {}) => {
  serial += 1;
  return {
    kind: 'other',
    firstName: 'Luis',
    lastName: 'Gomez',
    areaId,
    employeeNumber: `N-${serial}`,
    ...over,
  };
};
const driver = (areaId: string, over: Record<string, unknown> = {}) =>
  person(areaId, {
    kind: 'driver',
    idType: 'ine',
    ...SECRETS,
    licenseType: 'c',
    licenseExpiresOn: '2099-01-31',
    ...over,
  });

const hooks: { insert: { entered: () => void; hold: Promise<void> } | null } = { insert: null };
const latch = () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let entered: () => void = () => undefined;
  const wasEntered = new Promise<void>((resolve) => (entered = resolve));
  return { hold, release, entered, wasEntered };
};
const tick = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class HeldEmployeeStore extends TypeOrmEmployeeStore {
  public override async insert(next: Employee, entry: EmployeeHistoryEntry): Promise<void> {
    const held = hooks.insert;
    hooks.insert = null;
    if (held) {
      held.entered();
      await held.hold;
    }
    return super.insert(next, entry);
  }
}

suite('BFF on real MySQL employees and areas stores', () => {
  let areasDb: AreasDatabase;
  let employeesDb: EmployeesDatabase;
  let world: BffWorld;
  let adminA: Browser;
  let adminA2: Browser;
  let adminB: Browser;
  let viewerA: Browser;
  let editorA: Browser;
  let piiA: Browser;
  let tenantA: string;
  let tenantB: string;
  let areaB: string;

  const makeArea = async (browser: Browser, name: string) => {
    const reply = await browser.post('/api/areas', {
      json: { name, code: null, parentId: null, responsibleIds: [] },
    });
    expect(reply.status, name).toBe(201);
    return reply.json.id as string;
  };

  beforeAll(async () => {
    areasDb = await startAreasDatabase('empa');
    employeesDb = await startEmployeesDatabase('empl');
    const areas = new TypeOrmAreaStore(await areasDb.openRuntime());
    const employees = new HeldEmployeeStore(await employeesDb.openRuntime());
    const tenants = new InMemoryTenantStore();
    world = createBffWorld({
      adapters: {
        tenants,
        areas,
        employees,
        pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')),
      },
    });
    tenantA = (await world.tenant('Empresa Alfa', 'subject-admin-a')).tenantId;
    tenantB = (await world.tenant('Empresa Beta', 'subject-admin-b')).tenantId;
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
    await world.member('subject-admin-a', 'editor', 'subject-editor-a');
    await world.member('subject-admin-a', 'pii_reader', 'subject-pii-a');
    adminA = await world.loginAs('subject-admin-a');
    adminB = await world.loginAs('subject-admin-b');
    viewerA = await world.loginAs('subject-viewer-a');
    editorA = await world.loginAs('subject-editor-a');
    piiA = await world.loginAs('subject-pii-a');
    adminA2 = await world.loginAs('subject-admin-a');
    areaB = await makeArea(adminB, 'Base');
  }, 120_000);

  afterEach(async () => {
    hooks.insert = null;
    await employeesDb.admin.query('DELETE FROM opslog_employee_history');
    await employeesDb.admin.query('DELETE FROM opslog_employees');
    for (const table of ['opslog_area_history', 'opslog_area_responsibles'])
      await areasDb.admin.query(`DELETE FROM ${table}`);
    for (const depth of [4, 3, 2, 1])
      await areasDb.admin.query('DELETE FROM opslog_areas WHERE company_id = ? AND depth = ?', [
        tenantA,
        depth,
      ]);
  });

  afterAll(async () => {
    world?.dispose();
    await employeesDb?.close();
    await areasDb?.close();
  }, 60_000);

  const rows = () =>
    employeesDb.rows<Record<string, unknown>>('SELECT * FROM opslog_employees ORDER BY id');

  it('runs the whole lifecycle, stores the company on every row and no plaintext personal data', async () => {
    const home = await makeArea(adminA, 'Base');
    const created = await adminA.post('/api/employees', { json: driver(home) });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json).not.toHaveProperty('tenantId');
    expect((await adminA.get(`/api/employees/${id}`)).json.pii).toMatchObject({
      nationalId: SECRETS.nationalId,
      phone: '+525590001234',
      email: SECRETS.email,
      licenseNumber: SECRETS.licenseNumber,
    });
    expect(
      (await adminA.put(`/api/employees/${id}`, { json: { version: 1, position: 'Jefe' } })).json,
    ).toMatchObject({ position: 'Jefe', version: 2 });
    expect(
      (
        await adminA.post(`/api/employees/${id}/status`, {
          json: { version: 2, status: 'suspended', reason: 'Caso 1' },
        })
      ).json,
    ).toMatchObject({ status: 'suspended', version: 3 });
    expect((await adminA.get(`/api/employees/${id}/history`)).json.items).toHaveLength(2);
    expect(
      (await adminA.post(`/api/employees/${id}/archive`, { json: { version: 3 } })).status,
    ).toBe(200);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.['company_id']).toBe(tenantA);
    expect(stored[0]?.['archived_at']).not.toBeNull();
    const dump = JSON.stringify([
      stored,
      await employeesDb.rows('SELECT * FROM opslog_employee_history'),
    ]);
    for (const fragment of FRAGMENTS) expect(dump, fragment).not.toContain(fragment);
    expect(dump).toContain('pii1.');
    const history = await employeesDb.rows<{ company_id: string }>(
      'SELECT company_id FROM opslog_employee_history',
    );
    expect(history.every((row) => row.company_id === tenantA)).toBe(true);
  });

  it('keeps tenants apart: another company gets 404 and its own keys do not collide', async () => {
    const home = await makeArea(adminA, 'Base');
    const mine = await adminA.post('/api/employees', { json: driver(home) });
    const id = mine.json.id as string;
    // The same number, identification and e-mail are free in another company (no oracle).
    const theirs = await adminB.post('/api/employees', { json: driver(areaB) });
    expect(theirs.status).toBe(201);
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const [method, path, json] of [
      ['GET', `/api/employees/${id}`],
      ['GET', `/api/employees/${id}/history`],
      ['PUT', `/api/employees/${id}`, { version: 1, position: 'Robado' }],
      ['POST', `/api/employees/${id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/employees/${id}/archive`, { version: 1 }],
    ] as [string, string, unknown?][]) {
      const foreign = await adminB.send(method, path, { json });
      const absent = await adminB.send(method, path.replace(id, unknown), { json });
      expect(foreign.status, path).toBe(404);
      expect({ ...foreign.json, correlationId: '' }).toEqual({ ...absent.json, correlationId: '' });
    }
    expect((await adminA.get(`/api/employees/${id}`)).json.version).toBe(1);
    expect((await adminA.get('/api/employees')).json.total).toBe(1);
    expect((await adminB.get('/api/employees')).json.total).toBe(1);
    const counts = await employeesDb.rows<{ company_id: string; n: number }>(
      'SELECT company_id, COUNT(*) AS n FROM opslog_employees GROUP BY company_id',
    );
    expect(Object.fromEntries(counts.map((row) => [row.company_id, Number(row.n)]))).toEqual({
      [tenantA]: 1,
      [tenantB]: 1,
    });
    // blind indexes differ across companies for equal values
    const indexes = await employeesDb.rows<{ national_id_idx: string }>(
      'SELECT national_id_idx FROM opslog_employees',
    );
    expect(new Set(indexes.map((row) => row.national_id_idx)).size).toBe(2);
  });

  it('denies roles without the permission and masks personal data, leaving the rows untouched', async () => {
    const home = await makeArea(adminA, 'Base');
    const id = (await adminA.post('/api/employees', { json: driver(home) })).json.id as string;
    for (const [method, path, json] of [
      ['POST', '/api/employees', person(home)],
      ['PUT', `/api/employees/${id}`, { version: 1, position: 'x' }],
      ['POST', `/api/employees/${id}/status`, { version: 1, status: 'inactive', reason: 'x' }],
      ['POST', `/api/employees/${id}/archive`, { version: 1 }],
    ] as [string, string, unknown][])
      expect((await viewerA.send(method, path, { json })).status, `viewer ${path}`).toBe(403);
    expect(
      (await editorA.post(`/api/employees/${id}/archive`, { json: { version: 1 } })).status,
    ).toBe(403);
    expect(
      (await editorA.post('/api/employees', { json: driver(home, { employeeNumber: 'Z-1' }) }))
        .status,
    ).toBe(403);
    expect((await viewerA.get(`/api/employees/${id}`)).json.pii).toBeNull();
    expect((await piiA.get(`/api/employees/${id}`)).json.pii.nationalId).toBe(SECRETS.nationalId);
    expect((await adminA.get(`/api/employees/${id}`)).json.version).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it('enforces the duplicate keys against the database through blind indexes', async () => {
    const home = await makeArea(adminA, 'Base');
    await adminA.post('/api/employees', { json: driver(home, { employeeNumber: 'D-1' }) });
    const number = await adminA.post('/api/employees', {
      json: driver(home, {
        employeeNumber: 'd-1',
        nationalId: 'OTHER-1',
        email: 'o1@synthetic.example',
      }),
    });
    expect(number).toMatchObject({
      status: 409,
      json: { code: 'duplicate', field: 'employee_number' },
    });
    const national = await adminA.post('/api/employees', {
      json: driver(home, { nationalId: 'synth id 7788 qx', email: 'o2@synthetic.example' }),
    });
    expect(national.json).toMatchObject({ code: 'duplicate', field: 'national_id' });
    const mail = await adminA.post('/api/employees', {
      json: driver(home, { nationalId: 'OTHER-3', email: 'ANA.PEREZ@synthetic.example' }),
    });
    expect(mail.json).toMatchObject({ code: 'duplicate', field: 'email' });
    expect((await adminA.get('/api/employees')).json.total).toBe(1);
  });

  it('lets exactly one of two concurrent writers win, from two sessions', async () => {
    const home = await makeArea(adminA, 'Base');
    for (let round = 0; round < 5; round += 1) {
      const id = (await adminA.post('/api/employees', { json: person(home) })).json.id as string;
      const replies = await Promise.all([
        adminA.put(`/api/employees/${id}`, { json: { version: 1, position: 'Uno' } }),
        adminA2.put(`/api/employees/${id}`, { json: { version: 1, position: 'Dos' } }),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.json.code).toBe('stale_version');
      expect((await adminA.get(`/api/employees/${id}`)).json.version).toBe(2);
    }
  });

  it('lets exactly one of two concurrent creates of the same identification win', async () => {
    const home = await makeArea(adminA, 'Base');
    const replies = await Promise.all([
      adminA.post('/api/employees', {
        json: driver(home, { employeeNumber: 'C-1', email: 'c1@synthetic.example' }),
      }),
      adminA2.post('/api/employees', {
        json: driver(home, { employeeNumber: 'C-2', email: 'c2@synthetic.example' }),
      }),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect((await adminA.get('/api/employees')).json.total).toBe(1);
  });

  describe('BR-021 against the database', () => {
    it('counts live employees per company and area, and frees the area on terminate or archive', async () => {
      const home = await makeArea(adminA, 'Base');
      const other = await makeArea(adminA, 'Otra');
      const a = (await adminA.post('/api/employees', { json: person(home) })).json.id as string;
      const b = (await adminA.post('/api/employees', { json: person(home) })).json.id as string;
      const c = (await adminA.post('/api/employees', { json: person(home) })).json.id as string;
      await adminB.post('/api/employees', { json: person(areaB) });
      await adminA.post(`/api/employees/${b}/status`, {
        json: { version: 1, status: 'inactive', reason: 'Licencia' },
      });
      await adminA.post(`/api/employees/${c}/status`, {
        json: { version: 1, status: 'suspended', reason: 'Caso' },
      });
      expect((await adminA.get(`/api/areas/${home}`)).json.resourceCounts.people).toBe(3);
      expect((await adminA.get(`/api/areas/${other}`)).json.resourceCounts.people).toBe(0);
      const blocked = await adminA.post(`/api/areas/${home}/deactivate`, { json: { version: 1 } });
      expect(blocked).toMatchObject({
        status: 409,
        json: { code: 'area_in_use', field: 'people' },
      });
      await adminA.post(`/api/employees/${a}/status`, {
        json: { version: 1, status: 'terminated', reason: 'Renuncia' },
      });
      await adminA.post(`/api/employees/${b}/status`, {
        json: { version: 2, status: 'terminated', reason: 'Baja' },
      });
      expect((await adminA.get(`/api/areas/${home}`)).json.resourceCounts.people).toBe(1);
      await adminA.post(`/api/employees/${c}/archive`, { json: { version: 2 } });
      expect((await adminA.get(`/api/areas/${home}`)).json.resourceCounts.people).toBe(0);
      expect(
        (await adminA.post(`/api/areas/${home}/deactivate`, { json: { version: 1 } })).status,
      ).toBe(200);
    });

    it('answers the same 422 for unknown, foreign and inactive areas', async () => {
      const closed = await makeArea(adminA, 'Cerrada');
      await adminA.post(`/api/areas/${closed}/deactivate`, { json: { version: 1 } });
      for (const areaId of ['desconocida', areaB, closed]) {
        const reply = await adminA.post('/api/employees', { json: person(areaId) });
        expect(reply, areaId).toMatchObject({ status: 422, json: { code: 'invalid_area' } });
      }
      expect(await rows()).toEqual([]);
    });

    it('holds the deactivation until an in-flight employee assignment commits, then refuses it', async () => {
      const home = await makeArea(adminA, 'Base');
      const insert = latch();
      hooks.insert = { entered: insert.entered, hold: insert.hold };
      const create = adminA.post('/api/employees', { json: person(home) });
      await insert.wasEntered;
      const deactivate = adminA2.post(`/api/areas/${home}/deactivate`, { json: { version: 1 } });
      let settled = false;
      void deactivate.then(() => (settled = true));
      await tick();
      expect(settled).toBe(false);
      insert.release();
      const [created, deactivated] = await Promise.all([create, deactivate]);
      expect(created.status).toBe(201);
      expect(deactivated).toMatchObject({
        status: 409,
        json: { code: 'area_in_use', field: 'people' },
      });
      expect((await adminA.get(`/api/areas/${home}`)).json.active).toBe(true);
    });

    it('exactly one of a concurrent assignment and deactivation wins; an inactive area never holds an employee', async () => {
      let assigned = 0;
      let closed = 0;
      for (let round = 0; round < 12; round += 1) {
        const home = await makeArea(adminA, `Carrera ${round}`);
        const create = () => adminA.post('/api/employees', { json: person(home) });
        const deactivate = () =>
          adminA2.post(`/api/areas/${home}/deactivate`, { json: { version: 1 } });
        const results =
          round % 2 === 0
            ? await Promise.all([create(), deactivate()])
            : (await Promise.all([deactivate(), create()])).reverse();
        const created = results[0]!;
        const deactivated = results[1]!;
        expect((created.status === 201) !== (deactivated.status === 200), `round ${round}`).toBe(
          true,
        );
        if (created.status === 201) {
          assigned += 1;
          expect(deactivated).toMatchObject({ status: 409, json: { code: 'area_in_use' } });
        } else {
          closed += 1;
          expect(created).toMatchObject({ status: 422, json: { code: 'invalid_area' } });
        }
      }
      expect(assigned + closed).toBe(12);
      const inactive = new Set(
        (
          await areasDb.rows<{ id: string }>(
            'SELECT id FROM opslog_areas WHERE company_id = ? AND active = 0',
            [tenantA],
          )
        ).map((row) => row.id),
      );
      for (const row of await rows()) expect(inactive.has(row['area_id'] as string)).toBe(false);
    });
  });
});
