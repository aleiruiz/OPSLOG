import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUDIT_MIGRATIONS_TABLE, AUDIT_TABLES } from '../../audit/src/index.js';
import {
  PolicyError,
  PolicyService,
  revisionOf,
  type Policy,
  type PolicyFilter,
} from '../../../domain/insurance/src/index.js';
import { BINARY_COLLATION, POLICY_TABLES } from './entities.js';
import { PolicyStoreError } from './errors.js';
import { TypeOrmPolicyStore, type StoreErrorEvent } from './store.js';
import { adminUrl, startInsuranceDatabase, type InsuranceDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const auditSchemaTables = [
  ...Object.values(AUDIT_TABLES),
  'opslog_audit_local_keys',
  AUDIT_MIGRATIONS_TABLE,
];

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const input = (over: Record<string, unknown> = {}) => ({
  vehicleId: 'veh-1',
  insurer: 'Aseguradora Ficticia',
  coverageNotes: 'copia en archivo',
  policyNumber: 'POL-001',
  coverageType: 'comprehensive',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  deductible: { kind: 'amount', amountMinor: 500_000, currency: 'MXN' },
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

const window = { limit: 50, offset: 0 };
const insert = (db: InsuranceDatabase, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return outcome(
    db.admin.query(
      `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      Object.values(row),
    ),
  );
};

suite('persistent policy store on MySQL', () => {
  let db: InsuranceDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmPolicyStore;
  let storeB: TypeOrmPolicyStore;
  let svcA: PolicyService;
  let svcB: PolicyService;
  const events: StoreErrorEvent[] = [];

  beforeAll(async () => {
    db = await startInsuranceDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmPolicyStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmPolicyStore(sourceB);
    svcA = new PolicyService(storeA, { now: () => NOW });
    svcB = new PolicyService(storeB, { now: () => NOW });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  }, 60_000);

  describe('schema', () => {
    it('is created in its own migrations table with binary collations and company-keyed keys', async () => {
      const tables = await db.rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [db.databaseName],
      );
      const moduleTableList = Object.values(POLICY_TABLES)
        .map((name) => `'${name}'`)
        .join(', ');
      expect(tables.map((row) => row.t).sort()).toEqual(
        [
          ...Object.values(POLICY_TABLES),
          'opslog_insurance_migrations',
          ...auditSchemaTables,
        ].sort(),
      );
      const columns = await db.rows<{ coll: string }>(
        `SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME IN (${moduleTableList})`,
        [db.databaseName],
      );
      expect(columns.length).toBeGreaterThan(10);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);
      const keys = await db.rows<{ table: string; name: string; col: string; seq: number }>(
        `SELECT TABLE_NAME AS \`table\`, INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${moduleTableList})`,
        [db.databaseName],
      );
      // Every index, the primary keys included, starts with company_id.
      for (const row of keys.filter((candidate) => candidate.seq === 1))
        expect([row.table, row.name, row.col]).toEqual([row.table, row.name, 'company_id']);
    });

    it('rejects malformed policy rows by CHECK constraint, whoever writes them', async () => {
      const attempt = (patch: Record<string, unknown>) =>
        insert(db, POLICY_TABLES.policies, {
          company_id: 'tenant-checks',
          id: randomUUID(),
          vehicle_id: 'veh-1',
          insurer: 'Aseguradora Ficticia',
          coverage_notes: null,
          revision: 1,
          policy_number: 'POL-001',
          coverage_type: 'comprehensive',
          starts_on: '2026-01-01',
          ends_on: '2026-12-31',
          deductible_kind: null,
          deductible_value: null,
          deductible_currency: null,
          version: 1,
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
          ...patch,
        });
      for (const patch of [
        { insurer: ' ' },
        { insurer: 'A' },
        { coverage_notes: '  ' },
        { policy_number: '  ' },
        { coverage_type: 'unknown' },
        { version: 0 },
        { revision: 0 },
        { revision: 2, version: 1 },
        { starts_on: '01/01/2026' },
        { ends_on: 'soon' },
        { starts_on: '2027-01-01', ends_on: '2026-12-31' },
        { deductible_kind: 'other', deductible_value: 5 },
        { deductible_kind: 'amount', deductible_value: 5, deductible_currency: null },
        { deductible_kind: 'amount', deductible_value: 0, deductible_currency: 'MXN' },
        { deductible_kind: 'amount', deductible_value: 5, deductible_currency: 'mxn' },
        {
          deductible_kind: 'amount',
          deductible_value: 1_000_000_000_001,
          deductible_currency: 'MXN',
        },
        { deductible_kind: 'amount', deductible_value: null, deductible_currency: 'MXN' },
        { deductible_kind: 'percent', deductible_value: 0 },
        { deductible_kind: 'percent', deductible_value: 10_001 },
        { deductible_kind: 'percent', deductible_value: 500, deductible_currency: 'MXN' },
        { deductible_kind: null, deductible_value: 500 },
        { deductible_currency: 'MXN' },
      ]) {
        const error = await attempt(patch);
        expect(error, JSON.stringify(patch)).toBeDefined();
        expect(errnoOf(error), JSON.stringify(patch)).toBe(3819);
      }
      // well-formed rows: no deductible, an amount, a percentage and the extreme values
      expect(await attempt({})).toBeUndefined();
      expect(
        await attempt({
          deductible_kind: 'amount',
          deductible_value: 1_000_000_000_000,
          deductible_currency: 'USD',
        }),
      ).toBeUndefined();
      expect(
        await attempt({ deductible_kind: 'percent', deductible_value: 10_000 }),
      ).toBeUndefined();
      expect(await attempt({ starts_on: '2026-12-31' })).toBeUndefined();
    });

    it('rejects malformed revision rows by CHECK constraint', async () => {
      const p = await svcA.create(randomUUID(), ACTOR, input());
      const attempt = (patch: Record<string, unknown>) =>
        insert(db, POLICY_TABLES.revisions, {
          company_id: p.tenantId,
          policy_id: p.id,
          revision: 2,
          policy_number: 'POL-002',
          coverage_type: 'comprehensive',
          starts_on: '2027-01-01',
          ends_on: '2027-12-31',
          deductible_kind: null,
          deductible_value: null,
          deductible_currency: null,
          actor_id: ACTOR,
          at: NOW,
          ...patch,
        });
      for (const patch of [
        { revision: 0 },
        { policy_number: ' ' },
        { coverage_type: 'unknown' },
        { ends_on: 'soon' },
        { starts_on: '1/1/2027' },
        { starts_on: '2028-01-01' },
        { deductible_kind: 'percent', deductible_value: 0 },
        { deductible_kind: 'amount', deductible_value: 5 },
      ]) {
        const error = await attempt(patch);
        expect(error, JSON.stringify(patch)).toBeDefined();
        expect(errnoOf(error), JSON.stringify(patch)).toBe(3819);
      }
      expect(await attempt({})).toBeUndefined();
    });

    it('gives the runtime account DML only', async () => {
      const error = await rejection(sourceA.query(`DROP TABLE ${POLICY_TABLES.revisions}`));
      expect(errnoOf(error)).toBe(1142);
      const alter = await rejection(
        sourceA.query(`ALTER TABLE ${POLICY_TABLES.policies} DROP COLUMN coverage_notes`),
      );
      expect(errnoOf(alter)).toBe(1142);
    });

    it('keeps revisions append-only and policies undeletable for the runtime account', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, input());
      for (const sql of [
        `UPDATE ${POLICY_TABLES.revisions} SET ends_on = '2030-01-01' WHERE company_id = ?`,
        `DELETE FROM ${POLICY_TABLES.revisions} WHERE company_id = ?`,
        `DELETE FROM ${POLICY_TABLES.policies} WHERE company_id = ?`,
      ])
        expect(errnoOf(await rejection(sourceA.query(sql, [tenant]))), sql).toBe(1142);
      expect((await storeB.revisions(tenant, created.id, window)).total).toBe(1);
      expect(await storeB.find(tenant, created.id)).toEqual(created);
    });
  });

  describe('round trip and tenant isolation', () => {
    it('stores and reads a policy with its revisions, the deductible and exact strings', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, input({ insurer: 'Ñandú Seguros – ¿ok?' }));
      expect(await storeB.find(tenant, created.id)).toEqual(created);
      expect(created.insurer).toBe('Ñandú Seguros – ¿ok?');
      const revisions = await storeB.revisions(tenant, created.id, window);
      expect(revisions.items).toEqual([revisionOf(created, ACTOR, NOW)]);
      const pct = await svcA.create(
        tenant,
        ACTOR,
        input({ deductible: { kind: 'percent', basisPoints: 1250 } }),
      );
      const none = await svcA.create(tenant, ACTOR, input({ deductible: null }));
      const big = await svcA.create(
        tenant,
        ACTOR,
        input({ deductible: { kind: 'amount', amountMinor: 1_000_000_000_000, currency: 'COP' } }),
      );
      expect((await storeB.find(tenant, pct.id))?.deductible).toEqual({
        kind: 'percent',
        basisPoints: 1250,
      });
      expect((await storeB.find(tenant, none.id))?.deductible).toBeNull();
      expect((await storeB.find(tenant, big.id))?.deductible).toEqual({
        kind: 'amount',
        amountMinor: 1_000_000_000_000,
        currency: 'COP',
      });
    });

    it('never reaches a row of another company: reads, writes, revisions and listings', async () => {
      const a = randomUUID();
      const b = randomUUID();
      const polA = await svcA.create(a, ACTOR, input());
      const polB = await svcA.create(b, ACTOR, input({ insurer: 'Ajena Ficticia' }));
      expect(await storeA.find(b, polA.id)).toBeNull();
      expect(await storeA.revisions(b, polA.id, window)).toEqual({ items: [], total: 0 });
      expect((await storeA.list(a, { includeArchived: true }, window)).items).toEqual([polA]);
      expect((await storeA.list(b, { includeArchived: true }, window)).items).toEqual([polB]);
      expect(
        await storeA.replace({ ...polA, tenantId: b, version: 2, insurer: 'Pirata Ficticio' }, 1),
      ).toBe(false);
      expect((await storeA.find(a, polA.id))?.insurer).toBe('Aseguradora Ficticia');
      await expect(
        svcA.renew(b, ACTOR, polA.id, 1, { startsOn: '2027-01-01', endsOn: '2027-12-31' }),
      ).rejects.toEqual(new PolicyError('not_found'));
    });

    it('refuses a revision that attaches to a policy of another company (composite foreign key)', async () => {
      const a = await svcA.create(randomUUID(), ACTOR, input());
      const other: Policy = { ...a, tenantId: randomUUID(), id: randomUUID() };
      const foreign = { ...revisionOf(other, ACTOR, NOW), policyId: a.id };
      const error = await rejection(storeA.insert(other, foreign));
      expect(error).toMatchObject({ code: 'integrity' });
      // 1452 for an account with DDL privileges, 1216 for the DML-only runtime account
      expect([1452, 1216]).toContain((error as PolicyStoreError).errno);
      expect(await storeA.find(other.tenantId, other.id)).toBeNull();
    });
  });

  describe('renewal keeps the original', () => {
    it('appends a revision, leaves older rows byte-identical and reports status per revision', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, input());
      const before = await db.rows(
        `SELECT * FROM ${POLICY_TABLES.revisions} WHERE company_id = ? AND policy_id = ?`,
        [tenant, created.id],
      );
      const renewed = await svcA.renew(tenant, ACTOR, created.id, 1, {
        startsOn: '2027-01-01',
        endsOn: '2027-12-31',
        policyNumber: 'pol-002',
        deductible: null,
      });
      expect(renewed).toMatchObject({
        revision: 2,
        version: 2,
        policyNumber: 'POL-002',
        deductible: null,
      });
      const rows = await db.rows<{ revision: number }>(
        `SELECT * FROM ${POLICY_TABLES.revisions} WHERE company_id = ? AND policy_id = ? ORDER BY revision`,
        [tenant, created.id],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(before[0]);
      const history = await svcB.history(tenant, created.id);
      expect(
        history.items.map((r) => [r.revision, r.endsOn, r.status, r.deductible?.kind]),
      ).toEqual([
        [2, '2027-12-31', 'valid', undefined],
        [1, '2026-12-31', 'replaced', 'amount'],
      ]);
    });
  });

  describe('optimistic concurrency', () => {
    it('lets exactly one of many writers holding the same version win', async () => {
      const tenant = randomUUID();
      const p = await svcA.create(tenant, ACTOR, input());
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? storeA : storeB).replace(
            { ...p, version: 2, insurer: `Aseguradora ${i} Ficticia` },
            1,
          ),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await storeA.find(tenant, p.id))?.version).toBe(2);
    });

    it('lets exactly one of several concurrent renewals with the same version win, with one new revision', async () => {
      const tenant = randomUUID();
      const p = await svcA.create(tenant, ACTOR, input());
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 === 0 ? svcA : svcB)
            .renew(tenant, ACTOR, p.id, 1, { startsOn: '2027-01-01', endsOn: `${2028 + i}-01-01` })
            .then(
              () => 'ok',
              (error: unknown) => (error instanceof PolicyError ? error.code : 'other'),
            ),
        ),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'stale_version')).toHaveLength(5);
      expect((await svcA.history(tenant, p.id)).total).toBe(2);
    });

    it('serializes a renewal racing an archive: one wins, the other is stale', async () => {
      const tenant = randomUUID();
      const p = await svcA.create(tenant, ACTOR, input());
      const results = await Promise.all([
        svcA.renew(tenant, ACTOR, p.id, 1, { startsOn: '2027-01-01', endsOn: '2030-01-01' }).then(
          () => 'renew',
          (e: unknown) => (e as PolicyError).code,
        ),
        svcB.archive(tenant, p.id, 1).then(
          () => 'archive',
          (e: unknown) => (e as PolicyError).code,
        ),
      ]);
      expect(results.filter((r) => r === 'stale_version')).toHaveLength(1);
      expect(results.filter((r) => r === 'renew' || r === 'archive')).toHaveLength(1);
    });

    it('rolls the change back when its revision violates a constraint', async () => {
      const tenant = randomUUID();
      const p = await svcA.create(tenant, ACTOR, input());
      const next: Policy = { ...p, revision: 2, version: 2, endsOn: '2029-01-01' };
      // revision 1 already exists: the primary key refuses it and the policy update is undone
      const bad = { ...revisionOf(next, ACTOR, NOW), revision: 1 };
      expect(await rejection(storeA.replace(next, 1, bad))).toBeInstanceOf(Error);
      expect(await storeA.find(tenant, p.id)).toEqual(p);
    });
  });

  describe('listing, status and coverage filters', () => {
    it('filters by vehicle, coverage, derived status and covered day, orders by end date and pages', async () => {
      const tenant = randomUUID();
      const make = (over: Record<string, unknown>) => svcA.create(tenant, ACTOR, input(over));
      const p1 = await make({ endsOn: '2026-12-01' });
      const p2 = await make({
        endsOn: '2026-10-01',
        vehicleId: 'veh-2',
        coverageType: 'third_party',
      });
      const p3 = await make({ startsOn: '2027-01-01', endsOn: '2027-12-31', deductible: null });
      const p4 = await make({ endsOn: '2026-10-06' });
      const p5 = await make({ endsOn: '2026-11-05' });
      const p6 = await make({ endsOn: '2026-11-06' });
      const p7 = await make({ endsOn: '2026-10-20', coverageType: 'mandatory_liability' });
      const archived = await make({ endsOn: '2026-10-10' });
      await svcA.archive(tenant, archived.id, 1);
      const ids = async (query: Record<string, unknown>) =>
        (await svcA.list(tenant, query)).items.map((p) => p.id);
      expect(await ids({})).toEqual([p2.id, p4.id, p7.id, p5.id, p6.id, p1.id, p3.id]);
      expect(await ids({ includeArchived: true })).toContain(archived.id);
      expect(await ids({ status: 'expired' })).toEqual([p2.id]);
      // last day inclusive on both ends of the window: 2026-10-06 and 2026-11-05
      expect(await ids({ status: 'expiring' })).toEqual([p4.id, p7.id, p5.id]);
      expect(await ids({ status: 'valid' })).toEqual([p6.id, p1.id, p3.id]);
      expect(await ids({ vehicleId: 'veh-2' })).toEqual([p2.id]);
      expect(await ids({ coverageType: 'mandatory_liability' })).toEqual([p7.id]);
      // covering a day: both ends inclusive, an ended and a not yet started policy are out
      expect(await ids({ coversOn: '2026-10-06' })).toEqual([p4.id, p7.id, p5.id, p6.id, p1.id]);
      expect(await ids({ coversOn: '2026-10-07' })).toEqual([p7.id, p5.id, p6.id, p1.id]);
      expect(await ids({ coversOn: '2027-01-01' })).toEqual([p3.id]);
      expect(await ids({ coversOn: '2026-10-21', status: 'expiring' })).toEqual([p5.id]);
      const page = await svcA.list(tenant, { limit: 3, offset: 2 });
      expect(page.items.map((p) => p.id)).toEqual([p7.id, p5.id, p6.id]);
      expect(page.total).toBe(7);
      const filter: PolicyFilter = { includeArchived: false };
      expect((await storeA.list(randomUUID(), filter, window)).total).toBe(0);
    });
  });

  describe('failure hygiene', () => {
    it('does not leak insurers, numbers or SQL when the database refuses a statement', async () => {
      const tenant = randomUUID();
      const p = await svcA.create(
        tenant,
        ACTOR,
        input({ insurer: 'Aseguradora-ficticia-prueba', policyNumber: 'POL-FICTICIA-PRUEBA' }),
      );
      const bad: Policy = { ...p, id: randomUUID(), version: 0 };
      // `version` 0 violates a CHECK constraint, which the store reports as integrity.
      const error = await rejection(
        storeA.insert(bad, { ...revisionOf(bad, ACTOR, NOW), policyId: bad.id }),
      );
      expect(error).toBeInstanceOf(PolicyStoreError);
      expect(error).toMatchObject({ code: 'integrity', errno: 3819 });
      const text = `${(error as Error).message}${JSON.stringify(error)}${JSON.stringify(events)}`;
      for (const fragment of [
        'Aseguradora-ficticia-prueba',
        'POL-FICTICIA-PRUEBA',
        '500000',
        tenant,
        'INSERT',
        'opslog_',
      ])
        expect(text).not.toContain(fragment);
    });
  });
});
