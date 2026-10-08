import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUDIT_MIGRATIONS_TABLE, AUDIT_TABLES } from '../../audit/src/index.js';
import {
  DocumentError,
  DocumentService,
  revisionOf,
  type Document,
  type DocumentFilter,
} from '../../../domain/documents/src/index.js';
import { BINARY_COLLATION, DOCUMENT_TABLES } from './entities.js';
import { DocumentStoreError } from './errors.js';
import { TypeOrmDocumentStore, type StoreErrorEvent } from './store.js';
import { adminUrl, startDocumentsDatabase, type DocumentsDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const auditSchemaTables = [
  ...Object.values(AUDIT_TABLES),
  'opslog_audit_local_keys',
  AUDIT_MIGRATIONS_TABLE,
];

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const input = (over: Record<string, unknown> = {}) => ({
  ownerType: 'vehicle',
  ownerId: 'veh-1',
  typeCode: 'registration_card',
  title: 'Tarjeta de circulación',
  notes: 'original en archivo',
  issuedOn: '2025-03-31',
  expiresOn: '2027-03-31',
  documentNumber: 'TC-001',
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

suite('persistent document store on MySQL', () => {
  let db: DocumentsDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmDocumentStore;
  let storeB: TypeOrmDocumentStore;
  let svcA: DocumentService;
  let svcB: DocumentService;
  const events: StoreErrorEvent[] = [];

  beforeAll(async () => {
    db = await startDocumentsDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmDocumentStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmDocumentStore(sourceB);
    svcA = new DocumentService(storeA, { now: () => NOW });
    svcB = new DocumentService(storeB, { now: () => NOW });
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
      const moduleTableList = Object.values(DOCUMENT_TABLES)
        .map((name) => `'${name}'`)
        .join(', ');
      expect(tables.map((row) => row.t).sort()).toEqual(
        [
          ...Object.values(DOCUMENT_TABLES),
          'opslog_documents_migrations',
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

    it('rejects malformed document rows by CHECK constraint, whoever writes them', async () => {
      const attempt = async (patch: Record<string, unknown>) => {
        const row = {
          company_id: 'tenant-checks',
          id: randomUUID(),
          owner_type: 'vehicle',
          vehicle_id: 'veh-1',
          employee_id: null,
          type_code: 'registration_card',
          title: 'Tarjeta',
          notes: null,
          revision: 1,
          issued_on: '2025-01-01',
          expires_on: '2026-01-01',
          expiry_key: '2026-01-01',
          document_number: null,
          version: 1,
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
          ...patch,
        };
        const columns = Object.keys(row);
        return outcome(
          db.admin.query(
            `INSERT INTO ${DOCUMENT_TABLES.documents} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            Object.values(row),
          ),
        );
      };
      for (const patch of [
        { owner_type: 'policy' },
        { vehicle_id: null }, // no owner
        { employee_id: 'emp-1' }, // two owners
        { owner_type: 'employee' }, // type of the other owner column
        { type_code: 'Bad Type' },
        { title: '  ' },
        { notes: '  ' },
        { version: 0 },
        { revision: 0 },
        { revision: 2, version: 1 },
        { issued_on: '06/10/2026' },
        { expires_on: 'soon', expiry_key: 'soon' },
        { issued_on: '2026-02-01', expires_on: '2026-01-01', expiry_key: '2026-01-01' },
        { expiry_key: '2020-01-01' }, // key does not follow the date
        { expires_on: null, expiry_key: '2026-01-01' },
        { document_number: '  ' },
      ])
        expect(errnoOf(await attempt(patch)), JSON.stringify(patch)).toBe(3819);
      // a well-formed row, with and without expiry, and an employee owner, are accepted
      expect(await attempt({})).toBeUndefined();
      expect(
        await attempt({ expires_on: null, issued_on: null, expiry_key: '9999-12-31' }),
      ).toBeUndefined();
      expect(
        await attempt({ owner_type: 'employee', vehicle_id: null, employee_id: 'emp-1' }),
      ).toBeUndefined();
    });

    it('rejects malformed revision rows by CHECK constraint', async () => {
      const d = await svcA.create(randomUUID(), ACTOR, input());
      const attempt = async (patch: Record<string, unknown>) => {
        const row = {
          company_id: d.tenantId,
          document_id: d.id,
          revision: 2,
          issued_on: null,
          expires_on: '2028-01-01',
          document_number: null,
          actor_id: ACTOR,
          at: NOW,
          ...patch,
        };
        const columns = Object.keys(row);
        return outcome(
          db.admin.query(
            `INSERT INTO ${DOCUMENT_TABLES.revisions} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            Object.values(row),
          ),
        );
      };
      for (const patch of [
        { revision: 0 },
        { expires_on: 'soon' },
        { issued_on: '1/1/2026' },
        { issued_on: '2029-01-01' },
      ])
        expect(errnoOf(await attempt(patch)), JSON.stringify(patch)).toBe(3819);
      expect(await attempt({})).toBeUndefined();
    });

    it('gives the runtime account DML only', async () => {
      const error = await rejection(sourceA.query(`DROP TABLE ${DOCUMENT_TABLES.revisions}`));
      expect(errnoOf(error)).toBe(1142);
      const alter = await rejection(
        sourceA.query(`ALTER TABLE ${DOCUMENT_TABLES.documents} DROP COLUMN notes`),
      );
      expect(errnoOf(alter)).toBe(1142);
    });

    it('keeps revisions append-only and documents undeletable for the runtime account', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, input());
      for (const sql of [
        `UPDATE ${DOCUMENT_TABLES.revisions} SET expires_on = '2030-01-01' WHERE company_id = ?`,
        `DELETE FROM ${DOCUMENT_TABLES.revisions} WHERE company_id = ?`,
        `DELETE FROM ${DOCUMENT_TABLES.documents} WHERE company_id = ?`,
      ])
        expect(errnoOf(await rejection(sourceA.query(sql, [tenant]))), sql).toBe(1142);
      expect((await storeB.revisions(tenant, created.id, window)).total).toBe(1);
      expect(await storeB.find(tenant, created.id)).toEqual(created);
    });
  });

  describe('round trip and tenant isolation', () => {
    it('stores and reads a document with its revisions, microsecond dates and exact strings', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, input({ title: 'Ñandú – ¿ok?' }));
      expect(await storeB.find(tenant, created.id)).toEqual(created);
      expect(created.title).toBe('Ñandú – ¿ok?');
      const revisions = await storeB.revisions(tenant, created.id, window);
      expect(revisions.items).toEqual([revisionOf(created, ACTOR, NOW)]);
    });

    it('never reaches a row of another company: reads, writes, revisions and listings', async () => {
      const a = randomUUID();
      const b = randomUUID();
      const docA = await svcA.create(a, ACTOR, input());
      const docB = await svcA.create(b, ACTOR, input({ title: 'Ajena' }));
      expect(await storeA.find(b, docA.id)).toBeNull();
      expect(await storeA.revisions(b, docA.id, window)).toEqual({ items: [], total: 0 });
      expect((await storeA.list(a, { includeArchived: true }, window)).items).toEqual([docA]);
      expect((await storeA.list(b, { includeArchived: true }, window)).items).toEqual([docB]);
      expect(await storeA.replace({ ...docA, tenantId: b, version: 2, title: 'Pirata' }, 1)).toBe(
        false,
      );
      expect((await storeA.find(a, docA.id))?.title).toBe('Tarjeta de circulación');
      await expect(svcA.renew(b, ACTOR, docA.id, 1, { expiresOn: '2030-01-01' })).rejects.toEqual(
        new DocumentError('not_found'),
      );
    });

    it('refuses a revision that attaches to a document of another company (composite foreign key)', async () => {
      const a = await svcA.create(randomUUID(), ACTOR, input());
      const other: Document = { ...a, tenantId: randomUUID(), id: randomUUID() };
      const foreign = { ...revisionOf(other, ACTOR, NOW), documentId: a.id };
      const error = await rejection(storeA.insert(other, foreign));
      expect(error).toMatchObject({ code: 'integrity' });
      // 1452 for an account with DDL privileges, 1216 for the DML-only runtime account
      expect([1452, 1216]).toContain((error as DocumentStoreError).errno);
      expect(await storeA.find(other.tenantId, other.id)).toBeNull();
    });

    it('rolls document and revision back when local audit append is denied', async () => {
      const tenant = randomUUID();
      await db.admin.query(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` FROM '${db.runtimeUser}'@'%'`,
      );
      try {
        expect(await rejection(svcA.create(tenant, ACTOR, input()))).toBeInstanceOf(
          DocumentStoreError,
        );
        for (const table of [DOCUMENT_TABLES.documents, DOCUMENT_TABLES.revisions])
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
  });

  describe('renewal keeps the original', () => {
    it('appends a revision, leaves older rows byte-identical and reports status per revision', async () => {
      const tenant = randomUUID();
      const created = await svcA.create(tenant, ACTOR, input());
      const before = await db.rows(
        `SELECT * FROM ${DOCUMENT_TABLES.revisions} WHERE company_id = ? AND document_id = ?`,
        [tenant, created.id],
      );
      const renewed = await svcA.renew(tenant, ACTOR, created.id, 1, {
        issuedOn: '2026-10-01',
        expiresOn: '2029-03-31',
        documentNumber: 'tc-002',
      });
      expect(renewed).toMatchObject({ revision: 2, version: 2, documentNumber: 'TC-002' });
      const rows = await db.rows<{ revision: number }>(
        `SELECT * FROM ${DOCUMENT_TABLES.revisions} WHERE company_id = ? AND document_id = ? ORDER BY revision`,
        [tenant, created.id],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(before[0]);
      const history = await svcB.history(tenant, created.id);
      expect(history.items.map((r) => [r.revision, r.expiresOn, r.status])).toEqual([
        [2, '2029-03-31', 'valid'],
        [1, '2027-03-31', 'replaced'],
      ]);
    });
  });

  describe('optimistic concurrency', () => {
    it('lets exactly one of many writers holding the same version win', async () => {
      const tenant = randomUUID();
      const d = await svcA.create(tenant, ACTOR, input());
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? storeA : storeB).replace({ ...d, version: 2, title: `Titulo ${i}` }, 1),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await storeA.find(tenant, d.id))?.version).toBe(2);
    });

    it('lets exactly one of several concurrent renewals with the same version win, with one new revision', async () => {
      const tenant = randomUUID();
      const d = await svcA.create(tenant, ACTOR, input());
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 === 0 ? svcA : svcB)
            .renew(tenant, ACTOR, d.id, 1, { expiresOn: `${2028 + i}-01-01` })
            .then(
              () => 'ok',
              (error: unknown) => (error instanceof DocumentError ? error.code : 'other'),
            ),
        ),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'stale_version')).toHaveLength(5);
      expect((await svcA.history(tenant, d.id)).total).toBe(2);
    });

    it('serializes a renewal racing an archive: one wins, the other is stale', async () => {
      const tenant = randomUUID();
      const d = await svcA.create(tenant, ACTOR, input());
      const results = await Promise.all([
        svcA.renew(tenant, ACTOR, d.id, 1, { expiresOn: '2030-01-01' }).then(
          () => 'renew',
          (e: unknown) => (e as DocumentError).code,
        ),
        svcB.archive(tenant, d.id, 1).then(
          () => 'archive',
          (e: unknown) => (e as DocumentError).code,
        ),
      ]);
      expect(results.filter((r) => r === 'stale_version')).toHaveLength(1);
      expect(results.filter((r) => r === 'renew' || r === 'archive')).toHaveLength(1);
    });

    it('rolls the change back when its revision violates a constraint', async () => {
      const tenant = randomUUID();
      const d = await svcA.create(tenant, ACTOR, input());
      const next: Document = { ...d, revision: 2, version: 2, expiresOn: '2029-01-01' };
      // revision 1 already exists: the primary key refuses it and the document update is undone
      const bad = { ...revisionOf(next, ACTOR, NOW), revision: 1 };
      expect(await rejection(storeA.replace(next, 1, bad))).toBeInstanceOf(Error);
      expect(await storeA.find(tenant, d.id)).toEqual(d);
    });
  });

  describe('listing and expiry filters', () => {
    it('filters by owner, type and derived status, orders by expiry and pages with a total', async () => {
      const tenant = randomUUID();
      const make = (over: Record<string, unknown>) => svcA.create(tenant, ACTOR, input(over));
      const d1 = await make({ expiresOn: '2026-12-01' });
      const d2 = await make({
        expiresOn: '2026-10-01',
        typeCode: 'transport_permit',
        ownerId: 'veh-2',
      });
      const d3 = await make({ typeCode: 'ownership_title', expiresOn: null, issuedOn: null });
      const d4 = await make({ expiresOn: '2026-10-06' });
      const d5 = await make({ expiresOn: '2026-11-05' });
      const d6 = await make({ expiresOn: '2026-11-06' });
      const e1 = await make({
        ownerType: 'employee',
        ownerId: 'emp-1',
        typeCode: 'medical_exam',
        expiresOn: '2026-10-20',
      });
      const archived = await make({ expiresOn: '2026-10-10' });
      await svcA.archive(tenant, archived.id, 1);
      const ids = async (query: Record<string, unknown>) =>
        (await svcA.list(tenant, query)).items.map((d) => d.id);
      expect(await ids({})).toEqual([d2.id, d4.id, e1.id, d5.id, d6.id, d1.id, d3.id]);
      expect(await ids({ includeArchived: true })).toContain(archived.id);
      expect(await ids({ status: 'expired' })).toEqual([d2.id]);
      expect(await ids({ status: 'expiring' })).toEqual([d4.id, e1.id, d5.id]);
      expect(await ids({ status: 'valid' })).toEqual([d6.id, d1.id, d3.id]);
      expect(await ids({ ownerType: 'employee' })).toEqual([e1.id]);
      expect(await ids({ ownerType: 'vehicle', ownerId: 'veh-2' })).toEqual([d2.id]);
      expect(await ids({ ownerType: 'employee', ownerId: 'veh-2' })).toEqual([]);
      expect(await ids({ typeCode: 'ownership_title' })).toEqual([d3.id]);
      const page = await svcA.list(tenant, { limit: 3, offset: 2 });
      expect(page.items.map((d) => d.id)).toEqual([e1.id, d5.id, d6.id]);
      expect(page.total).toBe(7);
      const filter: DocumentFilter = { includeArchived: false };
      expect((await storeA.list(randomUUID(), filter, window)).total).toBe(0);
    });
  });

  describe('failure hygiene', () => {
    it('does not leak titles, numbers or SQL when the database refuses a statement', async () => {
      const tenant = randomUUID();
      const d = await svcA.create(
        tenant,
        ACTOR,
        input({ title: 'Titulo-ficticio-prueba', documentNumber: 'NUM-FICTICIO-PRUEBA' }),
      );
      const bad: Document = { ...d, id: randomUUID(), version: 0 };
      // `version` 0 violates a CHECK constraint, which the store reports as integrity.
      const error = await rejection(
        storeA.insert(bad, { ...revisionOf(bad, ACTOR, NOW), documentId: bad.id }),
      );
      expect(error).toBeInstanceOf(DocumentStoreError);
      expect(error).toMatchObject({ code: 'integrity', errno: 3819 });
      const text = `${(error as Error).message}${JSON.stringify(error)}${JSON.stringify(events)}`;
      for (const secret of [
        'Titulo-ficticio-prueba',
        'NUM-FICTICIO-PRUEBA',
        tenant,
        'INSERT',
        'opslog_',
      ])
        expect(text).not.toContain(secret);
    });
  });
});
