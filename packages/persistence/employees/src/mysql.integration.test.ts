import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUDIT_MIGRATIONS_TABLE, AUDIT_TABLES } from '../../audit/src/index.js';
import {
  EmployeeError,
  EmployeeService,
  statusEntry,
  type Employee,
} from '../../../domain/employees/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../platform/pii/src/index.js';
import { BINARY_COLLATION, EMPLOYEE_TABLES } from './entities.js';
import { EmployeeStoreError } from './errors.js';
import { TypeOrmEmployeeStore, type StoreErrorEvent } from './store.js';
import { adminUrl, startEmployeesDatabase, type EmployeesDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const auditSchemaTables = [
  ...Object.values(AUDIT_TABLES),
  'opslog_audit_local_keys',
  AUDIT_MIGRATIONS_TABLE,
];

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const cipher = new EnvelopePiiCipher(
  new LocalDevKms({
    masterKey: Uint8Array.from({ length: 32 }, (_, i) => 200 - i),
    environment: 'test',
  }),
);

const unique = (): string => randomUUID().slice(0, 8).toUpperCase();
const fields = (over: Record<string, unknown> = {}) => ({
  kind: 'driver',
  firstName: 'Ana',
  lastName: 'Pérez',
  areaId: 'area-1',
  employeeNumber: `E-${unique()}`,
  idType: 'ine',
  nationalId: `SYNTH-${unique()}-ZZ`,
  phone: '+52 55 1234 5678',
  email: `ana.${unique().toLowerCase()}@example.test`,
  licenseNumber: `LIC-${unique()}`,
  licenseType: 'C',
  licenseExpiresOn: '2027-01-31',
  ...over,
});

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

/** The error of a statement, or undefined when it succeeds. */
const outcome = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

const errnoOf = (error: unknown): number | undefined =>
  (error as { errno?: number; driverError?: { errno?: number } }).driverError?.errno ??
  (error as { errno?: number }).errno;

suite('persistent employee store on MySQL', () => {
  let db: EmployeesDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmEmployeeStore;
  let storeB: TypeOrmEmployeeStore;
  let svcA: EmployeeService;
  let svcB: EmployeeService;
  const events: StoreErrorEvent[] = [];

  beforeAll(async () => {
    db = await startEmployeesDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmEmployeeStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmEmployeeStore(sourceB);
    svcA = new EmployeeService(storeA, { pii: cipher, now: () => NOW });
    svcB = new EmployeeService(storeB, { pii: cipher, now: () => NOW });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  }, 60_000);

  describe('schema', () => {
    it('is created in its own migrations table with binary collations and company-keyed constraints', async () => {
      const tables = await db.rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [db.databaseName],
      );
      const moduleTableList = Object.values(EMPLOYEE_TABLES)
        .map((name) => `'${name}'`)
        .join(', ');
      expect(tables.map((row) => row.t).sort()).toEqual(
        [
          ...Object.values(EMPLOYEE_TABLES),
          'opslog_employees_migrations',
          ...auditSchemaTables,
        ].sort(),
      );
      const columns = await db.rows<{ coll: string }>(
        `SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME IN (${moduleTableList})`,
        [db.databaseName],
      );
      expect(columns.length).toBeGreaterThan(20);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);
      const uniques = await db.rows<{ name: string; col: string; seq: number }>(
        `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 AND TABLE_NAME IN (${moduleTableList})
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db.databaseName],
      );
      // Every unique key, primary keys included, starts with company_id.
      for (const row of uniques.filter((candidate) => candidate.seq === 1))
        expect([row.name, row.col]).toEqual([row.name, 'company_id']);
      expect(
        [...new Set(uniques.map((row) => row.name))].filter((name) => name !== 'PRIMARY').sort(),
      ).toEqual([
        'uq_employee_history_version',
        'uq_employees_email',
        'uq_employees_national_id',
        'uq_employees_number',
      ]);
      const indexed = await db.rows<{ name: string; col: string; seq: number }>(
        `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 1 AND TABLE_NAME = ?`,
        [db.databaseName, EMPLOYEE_TABLES.employees],
      );
      for (const row of indexed.filter((candidate) => candidate.seq === 1))
        expect([row.name, row.col]).toEqual([row.name, 'company_id']);
    });

    it('rejects malformed rows by CHECK constraint, whoever writes them', async () => {
      const attempt = async (patch: Record<string, unknown>) => {
        const row = {
          company_id: 'tenant-checks',
          id: randomUUID(),
          kind: 'driver',
          first_name: 'Ana',
          last_name: 'Pérez',
          name_key: 'pérez ana',
          employee_number: null,
          employee_number_key: null,
          position: null,
          hire_date: null,
          area_id: 'a',
          status: 'active',
          status_reason: 'Alta',
          id_type: null,
          national_id_enc: null,
          national_id_idx: null,
          phone_enc: null,
          email_enc: null,
          email_idx: null,
          license_number_enc: null,
          license_number_idx: null,
          license_type: null,
          license_expires_on: null,
          version: 1,
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
          ...patch,
        };
        const columns = Object.keys(row);
        return outcome(
          db.admin.query(
            `INSERT INTO ${EMPLOYEE_TABLES.employees} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            Object.values(row),
          ),
        );
      };
      const hex = 'a'.repeat(64);
      const sealed = 'pii1.a.b.c.d';
      for (const patch of [
        { kind: 'mechanic' },
        { status: 'Activo' },
        { version: 0 },
        { first_name: '  ' },
        { name_key: '' },
        { employee_number: 'E-1' }, // number without key
        { employee_number: 'E-1', employee_number_key: '' },
        { hire_date: '06/10/2026' },
        { license_expires_on: 'soon', kind: 'driver' },
        { status_reason: '  ' },
        // plaintext never fits: a PII column must hold an envelope, with its index and type
        { national_id_enc: 'SYNTH-0000', national_id_idx: hex, id_type: 'ine' },
        { phone_enc: '+525512345678' },
        { email_enc: 'ana@example.test', email_idx: hex },
        { license_number_enc: 'LIC-1', license_number_idx: hex },
        { national_id_enc: sealed, national_id_idx: null, id_type: 'ine' },
        { national_id_enc: null, national_id_idx: hex },
        { national_id_enc: sealed, national_id_idx: hex, id_type: null },
        { email_enc: sealed, email_idx: null },
        { national_id_enc: sealed, national_id_idx: 'not-hex', id_type: 'ine' },
        { license_number_enc: sealed, license_number_idx: hex.toUpperCase() },
        // license data belongs to drivers
        { kind: 'other', license_type: 'C' },
        { kind: 'dispatcher', license_expires_on: '2027-01-01' },
        { kind: 'other', license_number_enc: sealed, license_number_idx: hex },
      ])
        expect(errnoOf(await attempt(patch)), JSON.stringify(patch)).toBe(3819);
      // a well-formed envelope and index are accepted
      expect(
        await attempt({
          employee_number: 'ok',
          employee_number_key: 'ok',
          national_id_enc: sealed,
          national_id_idx: hex,
          id_type: 'ine',
          phone_enc: sealed,
        }),
      ).toBeUndefined();
    });

    it('rejects malformed history rows by CHECK constraint', async () => {
      const e = await svcA.create(randomUUID(), ACTOR, fields());
      const attempt = async (patch: Record<string, unknown>) => {
        const row = {
          company_id: e.tenantId,
          id: randomUUID(),
          employee_id: e.id,
          kind: 'status',
          from_value: 'active',
          to_value: 'inactive',
          reason: 'x',
          actor_id: ACTOR,
          version: 2,
          at: NOW,
          ...patch,
        };
        const columns = Object.keys(row);
        return outcome(
          db.admin.query(
            `INSERT INTO ${EMPLOYEE_TABLES.history} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            Object.values(row),
          ),
        );
      };
      for (const patch of [
        { kind: 'other' },
        { to_value: 'Baja' },
        { from_value: 'Baja' },
        { reason: null },
        { reason: '  ' },
        { version: 0 },
        { kind: 'area', from_value: null, to_value: 'area-2', reason: null },
        { kind: 'area', from_value: 'area-1', to_value: 'area-2', reason: 'x' },
      ])
        expect(errnoOf(await attempt(patch)), JSON.stringify(patch)).toBe(3819);
      expect(
        await attempt({ kind: 'area', from_value: 'area-1', to_value: 'area-2', reason: null }),
      ).toBeUndefined();
    });

    it('gives the runtime account DML only', async () => {
      const error = await rejection(sourceA.query(`DROP TABLE ${EMPLOYEE_TABLES.history}`));
      expect(errnoOf(error)).toBe(1142);
      const alter = await rejection(
        sourceA.query(`ALTER TABLE ${EMPLOYEE_TABLES.employees} DROP COLUMN position`),
      );
      expect(errnoOf(alter)).toBe(1142);
    });
  });

  describe('personal data at rest (D23)', () => {
    it('holds only envelopes and blind indexes: no plaintext anywhere in the rows', async () => {
      const tenant = randomUUID();
      const input = fields({
        nationalId: 'SYNTH-4455-AB',
        phone: '+52 55 9000 1111',
        email: 'plain.value@example.test',
        licenseNumber: 'LIC-778899',
      });
      const created = await svcA.create(tenant, ACTOR, input);
      const raw = await db.rows<Record<string, unknown>>(
        `SELECT * FROM ${EMPLOYEE_TABLES.employees} WHERE company_id = ? AND id = ?`,
        [tenant, created.id],
      );
      const dump = JSON.stringify(raw);
      for (const secret of [
        'SYNTH-4455',
        '4455',
        '5590001111',
        '9000',
        'plain.value',
        'LIC-778899',
        '778899',
      ])
        expect(dump).not.toContain(secret);
      expect(raw[0]).toMatchObject({
        national_id_enc: expect.stringMatching(/^pii1\./),
        national_id_idx: expect.stringMatching(/^[0-9a-f]{64}$/),
        phone_enc: expect.stringMatching(/^pii1\./),
        email_idx: expect.stringMatching(/^[0-9a-f]{64}$/),
        license_number_idx: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // another process reads and opens it
      const read = await svcB.get(tenant, created.id);
      expect(await svcB.reveal(read)).toEqual({
        nationalId: 'SYNTH-4455-AB',
        phone: '+525590001111',
        email: 'plain.value@example.test',
        licenseNumber: 'LIC-778899',
      });
    });

    it('does not open under another tenant or row (ciphertext bound to its record)', async () => {
      const one = await svcA.create(randomUUID(), ACTOR, fields());
      const two = await svcA.create(randomUUID(), ACTOR, fields());
      await expect(svcB.reveal({ ...two, pii: one.pii })).rejects.toMatchObject({
        name: 'PiiError',
      });
    });

    it('uses different blind indexes for the same identification in two companies', async () => {
      const shared = fields({ nationalId: 'SHARED-ID-0001', email: 'shared@example.test' });
      const a = await svcA.create(randomUUID(), ACTOR, shared);
      const b = await svcB.create(randomUUID(), ACTOR, shared);
      expect(a.pii.nationalId?.index).not.toBe(b.pii.nationalId?.index);
      expect(a.pii.email?.index).not.toBe(b.pii.email?.index);
    });
  });

  describe('round trip and tenant isolation', () => {
    it('stores and reads an employee with its history, microsecond dates and exact strings', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, fields({ firstName: 'María José' }));
      expect(await storeB.find(tenant, created.id)).toEqual(created);
      expect(
        (await storeB.history(tenant, created.id, { limit: 10, offset: 0 })).items,
      ).toMatchObject([
        { kind: 'status', from: null, to: 'active', reason: 'Alta', version: 1, actorId: ACTOR },
      ]);
      const raw = await db.rows<Record<string, unknown>>(
        `SELECT company_id, name_key, hire_date FROM ${EMPLOYEE_TABLES.employees} WHERE id = ?`,
        [created.id],
      );
      expect(raw).toEqual([{ company_id: tenant, name_key: 'pérez maría josé', hire_date: null }]);
    });

    it('never reaches a row of another company: reads, writes, history and listings', async () => {
      const a = randomUUID();
      const b = randomUUID();
      const eA = await svcA.create(a, ACTOR, fields());
      const eB = await svcA.create(b, ACTOR, fields());
      expect(await storeA.find(b, eA.id)).toBeNull();
      expect((await storeA.history(b, eA.id, { limit: 5, offset: 0 })).items).toEqual([]);
      expect(await storeA.replace({ ...eA, tenantId: b, version: 2, firstName: 'Hacked' }, 1)).toBe(
        false,
      );
      expect((await storeA.find(a, eA.id))?.firstName).toBe('Ana');
      const listB = await storeA.list(b, { includeArchived: true }, { limit: 50, offset: 0 });
      expect(listB.items.map((item) => item.id)).toEqual([eB.id]);
      expect(listB.total).toBe(1);
    });

    it('allows the same employee number, identification and e-mail in two companies', async () => {
      const shared = fields({
        employeeNumber: 'EMP-0001',
        nationalId: 'SHARE-0001-XX',
        email: 'same@example.test',
      });
      const one = await svcA.create(randomUUID(), ACTOR, shared);
      const two = await svcB.create(randomUUID(), ACTOR, shared);
      expect((await storeA.find(two.tenantId, two.id))?.employeeNumber).toBe('EMP-0001');
      expect(one.employeeNumber).toBe('EMP-0001');
    });

    it('refuses a history row that attaches to an employee of another company (composite foreign key)', async () => {
      const a = randomUUID();
      const eA = await svcA.create(a, ACTOR, fields());
      const b = randomUUID();
      const eB = await svcB.create(b, ACTOR, fields());
      await db.admin.query(`DELETE FROM ${EMPLOYEE_TABLES.history} WHERE company_id = ?`, [b]);
      await db.admin.query(`DELETE FROM ${EMPLOYEE_TABLES.employees} WHERE company_id = ?`, [b]);
      const foreign = { ...statusEntry(eB, null, randomUUID(), ACTOR, NOW), employeeId: eA.id };
      expect(await rejection(storeA.insert(eB, foreign))).toMatchObject({ code: 'integrity' });
      expect(await storeA.find(b, eB.id)).toBeNull();
    });
  });

  describe('uniqueness per company (BR-011)', () => {
    it('names the colliding key; the keys are the normalized ones', async () => {
      const tenant = randomUUID();
      await svcA.create(
        tenant,
        ACTOR,
        fields({
          employeeNumber: 'Emp-1',
          nationalId: 'ab-1234 cd',
          email: 'First@Example.test',
        }),
      );
      const probe = (over: Record<string, unknown>) =>
        rejection(svcB.create(tenant, ACTOR, fields(over)));
      expect(await probe({ employeeNumber: 'EMP-1' })).toEqual(
        new EmployeeError('duplicate', 'employee_number'),
      );
      expect(await probe({ nationalId: 'AB 1234.CD' })).toEqual(
        new EmployeeError('duplicate', 'national_id'),
      );
      expect(await probe({ email: 'first@example.TEST' })).toEqual(
        new EmployeeError('duplicate', 'email'),
      );
      // the same number under another identification type is another identification
      await svcB.create(tenant, ACTOR, fields({ idType: 'dni', nationalId: 'ab-1234 cd' }));
      const count = await db.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${EMPLOYEE_TABLES.employees} WHERE company_id = ?`,
        [tenant],
      );
      expect(Number(count[0]?.n)).toBe(2);
    });

    it('treats many employees without number, identification or e-mail as distinct', async () => {
      const tenant = randomUUID();
      for (let i = 0; i < 3; i += 1)
        await svcA.create(tenant, ACTOR, {
          kind: 'other',
          firstName: 'Luis',
          lastName: 'Gómez',
          areaId: 'area-1',
        });
      expect(
        (await storeA.list(tenant, { includeArchived: true }, { limit: 10, offset: 0 })).total,
      ).toBe(3);
    });

    it('lets two employees share a license number (indexed, not unique)', async () => {
      const tenant = randomUUID();
      await svcA.create(tenant, ACTOR, fields({ licenseNumber: 'SAME-LIC-1' }));
      await svcB.create(tenant, ACTOR, fields({ licenseNumber: 'SAME-LIC-1' }));
      const rows = await db.rows<{ n: number }>(
        `SELECT COUNT(DISTINCT license_number_idx) AS n FROM ${EMPLOYEE_TABLES.employees} WHERE company_id = ?`,
        [tenant],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('lets exactly one of several concurrent creations of the same identification win, from two processes', async () => {
      const tenant = randomUUID();
      const attempts = Array.from({ length: 6 }, (_, i) =>
        (i % 2 === 0 ? svcA : svcB)
          .create(tenant, ACTOR, fields({ nationalId: 'RACE-ID-0001' }))
          .then(
            () => 'ok',
            (error: unknown) =>
              error instanceof EmployeeError ? `${error.code}:${error.field}` : 'other',
          ),
      );
      const results = await Promise.all(attempts);
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result === 'duplicate:national_id')).toHaveLength(5);
    });

    it('rejects a duplicate introduced by an update and keeps the employee unchanged', async () => {
      const tenant = randomUUID();
      const one = await svcA.create(tenant, ACTOR, fields({ employeeNumber: 'UP-1' }));
      const two = await svcA.create(tenant, ACTOR, fields({ employeeNumber: 'UP-2' }));
      expect(
        await rejection(svcA.update(tenant, ACTOR, two.id, 1, { employeeNumber: 'up-1' })),
      ).toEqual(new EmployeeError('duplicate', 'employee_number'));
      expect(
        await rejection(svcA.update(tenant, ACTOR, two.id, 1, { nationalId: 'x', idType: 'ine' })),
      ).toBeInstanceOf(EmployeeError);
      expect((await storeA.find(tenant, two.id))?.version).toBe(1);
      expect(one.version).toBe(1);
    });
  });

  describe('optimistic concurrency', () => {
    it('lets exactly one of many writers holding the same version win', async () => {
      const tenant = randomUUID();
      const e = await svcA.create(tenant, ACTOR, fields());
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? storeA : storeB).replace({ ...e, version: 2, firstName: `Name${i}` }, 1),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await storeA.find(tenant, e.id))?.version).toBe(2);
    });

    it('writes the change and its history entry atomically, even with two racers carrying one each', async () => {
      const tenant = randomUUID();
      const e = await svcA.create(tenant, ACTOR, fields());
      const next: Employee = { ...e, status: 'inactive', statusReason: 'Licencia', version: 2 };
      const results = await Promise.all([
        storeA.replace(next, 1, statusEntry(next, 'active', randomUUID(), ACTOR, NOW)),
        storeB.replace(next, 1, statusEntry(next, 'active', randomUUID(), ACTOR, NOW)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        (await storeA.history(tenant, e.id, { limit: 10, offset: 0 })).items.map((x) => x.version),
      ).toEqual([2, 1]);
    });

    it('rolls the change back when its history entry violates a constraint', async () => {
      const tenant = randomUUID();
      const e = await svcA.create(tenant, ACTOR, fields());
      const next: Employee = { ...e, status: 'inactive', statusReason: 'Licencia', version: 2 };
      const bad = { ...statusEntry(next, 'active', randomUUID(), ACTOR, NOW), version: 1 };
      expect(await rejection(storeA.replace(next, 1, bad))).toBeInstanceOf(Error);
      expect(await storeA.find(tenant, e.id)).toEqual(e);
    });

    it('rolls employee and history back when local audit append is denied', async () => {
      const tenant = randomUUID();
      await db.admin.query(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` FROM '${db.runtimeUser}'@'%'`,
      );
      try {
        expect(await rejection(svcA.create(tenant, ACTOR, fields()))).toBeInstanceOf(
          EmployeeStoreError,
        );
        for (const table of [EMPLOYEE_TABLES.employees, EMPLOYEE_TABLES.history])
          expect(
            await db.rows(`SELECT 1 FROM ${table} WHERE company_id = ?`, [tenant]),
          ).toHaveLength(0);
        for (const table of [AUDIT_TABLES.local, AUDIT_TABLES.delivery])
          expect(
            await db.rows(`SELECT event_id FROM ${table} WHERE tenant_id = ?`, [tenant]),
          ).toHaveLength(0);
      } finally {
        await db.admin.query(
          `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` TO '${db.runtimeUser}'@'%'`,
        );
      }
    });

    it('serializes concurrent status changes through the service: one wins, the rest are stale', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, fields());
      const results = await Promise.all(
        ['inactive', 'suspended', 'terminated', 'inactive', 'suspended', 'terminated'].map(
          (status, i) =>
            (i % 2 === 0 ? svcA : svcB)
              .changeStatus(tenant, ACTOR, created.id, 1, status, 'Carrera')
              .then(
                () => 'ok',
                (error: unknown) => (error instanceof EmployeeError ? error.code : 'other'),
              ),
        ),
      );
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result === 'stale_version')).toHaveLength(5);
      expect((await svcA.history(tenant, created.id)).total).toBe(2);
    });
  });

  describe('count port for the Areas module', () => {
    it('counts, per company and area, the employees that are not archived or terminated', async () => {
      const tenant = randomUUID();
      const other = randomUUID();
      const make = (t: string, areaId: string) =>
        svcA.create(t, ACTOR, {
          kind: 'other',
          firstName: 'Luis',
          lastName: 'Gómez',
          areaId,
        });
      await make(tenant, 'x');
      const idle = await make(tenant, 'x');
      const away = await make(tenant, 'x');
      const gone = await make(tenant, 'x');
      const filed = await make(tenant, 'x');
      await make(tenant, 'y');
      await make(other, 'x');
      await svcA.changeStatus(tenant, ACTOR, idle.id, 1, 'inactive', 'Temporada');
      await svcA.changeStatus(tenant, ACTOR, away.id, 1, 'suspended', 'Revisión');
      await svcA.changeStatus(tenant, ACTOR, gone.id, 1, 'terminated', 'Renuncia');
      await svcA.archive(tenant, filed.id, 1);
      expect(await storeB.countLiveInArea(tenant, 'x')).toBe(3);
      expect(await storeB.countLiveInArea(tenant, 'y')).toBe(1);
      expect(await storeB.countLiveInArea(other, 'x')).toBe(1);
      expect(await storeB.countLiveInArea(other, 'y')).toBe(0);
    });
  });

  describe('listing', () => {
    it('filters by kind, status and area, hides archived rows by default and pages in name order', async () => {
      const tenant = randomUUID();
      const people: [string, string, string, string][] = [
        ['Beto', 'Zamora', 'x', 'driver'],
        ['Ana', 'Alvarez', 'y', 'dispatcher'],
        ['Carla', 'Zamora', 'x', 'other'],
        ['Dora', 'Zamora', 'x', 'other'],
      ];
      const created: Employee[] = [];
      for (const [firstName, lastName, areaId, kind] of people)
        created.push(await svcA.create(tenant, ACTOR, { kind, firstName, lastName, areaId }));
      const [b, , c] = created as [Employee, Employee, Employee, Employee];
      await svcA.changeStatus(tenant, ACTOR, c.id, 1, 'inactive', 'Temporada');
      await svcA.archive(tenant, b.id, 1);
      const names = async (query: Record<string, unknown>) =>
        (await svcB.list(tenant, query)).items.map((e) => e.firstName);
      expect(await names({})).toEqual(['Ana', 'Carla', 'Dora']);
      expect(await names({ includeArchived: true })).toEqual(['Ana', 'Beto', 'Carla', 'Dora']);
      expect(await names({ areaId: 'x' })).toEqual(['Carla', 'Dora']);
      expect(await names({ status: 'inactive' })).toEqual(['Carla']);
      expect(await names({ kind: 'dispatcher' })).toEqual(['Ana']);
      expect(await names({ includeArchived: true, limit: 2, offset: 1 })).toEqual([
        'Beto',
        'Carla',
      ]);
      expect((await svcB.list(tenant, { limit: 1 })).total).toBe(3);
    });
  });

  describe('failure hygiene', () => {
    it('does not leak identifications, e-mails or SQL when the database refuses a statement', async () => {
      const tenant = randomUUID();
      const e = await svcA.create(
        tenant,
        ACTOR,
        fields({ nationalId: 'LEAK-ID-0001', email: 'leak@example.test' }),
      );
      const other = { ...e, id: randomUUID(), employeeNumber: 'LEAK-NUM', version: 0 };
      // `version` 0 violates a CHECK constraint, which the store reports as integrity.
      const error = await rejection(
        storeA.insert(other, statusEntry({ ...other, version: 1 }, null, randomUUID(), ACTOR, NOW)),
      );
      expect(error).toBeInstanceOf(EmployeeStoreError);
      expect(error).toMatchObject({ code: 'integrity', errno: 3819 });
      const text = `${(error as Error).message}${JSON.stringify(error)}${JSON.stringify(events)}`;
      for (const secret of [
        'LEAK-ID',
        'LEAK-NUM',
        'leak@',
        tenant,
        e.pii.nationalId?.sealed ?? '?',
        'INSERT',
        'opslog_',
      ])
        expect(text).not.toContain(secret);
    });
  });
});
