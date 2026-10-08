import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  AreaError,
  AreaService,
  NO_RESOURCES,
  historyEntry,
  newArea,
  parseNewArea,
  type Area,
} from '../../../domain/areas/src/index.js';
import { AREA_TABLES, BINARY_COLLATION } from './entities.js';
import { AreaStoreError } from './errors.js';
import { TypeOrmAreaStore, type StoreErrorEvent } from './store.js';
import { adminUrl, startAreasDatabase, type AreasDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const areaOf = (tenant: string, over: Partial<Area> & { name?: string } = {}): Area => ({
  ...newArea(
    tenant,
    randomUUID(),
    parseNewArea({ name: over.name ?? `Area ${randomUUID().slice(0, 8)}` }),
    1,
    NOW,
  ),
  ...over,
});
const insert = (store: TypeOrmAreaStore, area: Area) =>
  store.transaction(area.tenantId, (tx) =>
    tx.insert(
      area,
      historyEntry(
        area,
        'created',
        [],
        { from: null, to: area.parentId },
        randomUUID(),
        ACTOR,
        NOW,
      ),
    ),
  );

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

const errnoOf = (error: unknown): number | undefined =>
  (error as { errno?: number; driverError?: { errno?: number } }).driverError?.errno ??
  (error as { errno?: number }).errno;

suite('persistent area store on MySQL', () => {
  let db: AreasDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmAreaStore;
  let storeB: TypeOrmAreaStore;
  const events: StoreErrorEvent[] = [];
  const services = () => {
    const options = { resources: { vehicles: NO_RESOURCES, people: NO_RESOURCES } };
    return [new AreaService(storeA, options), new AreaService(storeB, options)] as const;
  };

  beforeAll(async () => {
    db = await startAreasDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmAreaStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmAreaStore(sourceB);
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
      expect(tables.map((row) => row.t).sort()).toEqual(
        [
          ...Object.values(AREA_TABLES),
          'opslog_areas_migrations',
          'opslog_audit_local',
          'opslog_audit_delivery',
          'opslog_audit_local_keys',
          'opslog_audit_log',
          'opslog_audit_registry',
          'opslog_audit_migrations',
        ].sort(),
      );
      const areaTableList = [...Object.values(AREA_TABLES)].map((name) => `'${name}'`).join(', ');
      const columns = await db.rows<{ coll: string }>(
        `SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME IN (${areaTableList})`,
        [db.databaseName],
      );
      expect(columns.length).toBeGreaterThan(10);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);
      const uniques = await db.rows<{ name: string; col: string; seq: number }>(
        `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 AND TABLE_NAME IN (${areaTableList})
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db.databaseName],
      );
      // Every unique key, primary keys included, starts with company_id.
      for (const row of uniques.filter((candidate) => candidate.seq === 1))
        expect([row.name, row.col]).toEqual([row.name, 'company_id']);
      expect(
        [...new Set(uniques.map((row) => row.name))].filter((name) => name !== 'PRIMARY').sort(),
      ).toEqual(['uq_area_history_version', 'uq_areas_code', 'uq_areas_sibling_name']);
      const foreignKeys = await db.rows<{ name: string; cols: string }>(
        `SELECT CONSTRAINT_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) AS cols
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${areaTableList}) AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME`,
        [db.databaseName],
      );
      expect(foreignKeys.map((fk) => [fk.name, fk.cols]).sort()).toEqual([
        ['fk_area_history_area', 'company_id,area_id'],
        ['fk_area_responsibles_area', 'company_id,area_id'],
        ['fk_areas_parent', 'company_id,parent_id'],
      ]);
    });

    it('rejects out-of-range rows by CHECK constraint, whoever writes them', async () => {
      const tenant = 'tenant-checks';
      const parent = areaOf(tenant);
      await insert(storeA, parent);
      const attempt = async (patch: Record<string, unknown>) => {
        const id = randomUUID();
        const row = {
          company_id: tenant,
          id,
          name: 'n',
          name_key: `n-${id}`,
          code: null,
          parent_id: null,
          parent_key: '',
          depth: 1,
          active: 1,
          version: 1,
          created_at: NOW,
          updated_at: NOW,
          deactivated_at: null,
          ...patch,
        };
        const columns = Object.keys(row);
        return rejection(
          db.admin.query(
            `INSERT INTO ${AREA_TABLES.areas} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            Object.values(row),
          ),
        );
      };
      for (const patch of [
        // Depth is bounded by the database too: a fifth level, level 0, a root that is not level 1,
        // a child that claims level 1.
        { depth: 5, parent_id: parent.id, parent_key: parent.id },
        { depth: 0 },
        { depth: 2 },
        { depth: 1, parent_id: parent.id, parent_key: parent.id },
        { parent_key: 'x' },
        { active: 0 },
        { active: 1, deactivated_at: NOW },
        { version: 0 },
        { name: '  ' },
        { code: 'lower' },
        { code: '-A' },
      ])
        expect(errnoOf(await attempt(patch)), JSON.stringify(patch)).toBe(3819);
      // A parent in another company is unreachable (composite foreign key).
      expect(errnoOf(await attempt({ depth: 2, parent_id: randomUUID(), parent_key: 'x' }))).toBe(
        3819,
      );
      const other = areaOf('tenant-other');
      await insert(storeA, other);
      expect(errnoOf(await attempt({ depth: 2, parent_id: other.id, parent_key: other.id }))).toBe(
        1452,
      );
      // An area cannot be its own parent.
      const self = randomUUID();
      expect(
        errnoOf(
          await rejection(
            db.admin.query(
              `INSERT INTO ${AREA_TABLES.areas} (company_id, id, name, name_key, parent_id, parent_key, depth, active, version, created_at, updated_at)
               VALUES (?, ?, 's', 's', ?, ?, 2, 1, 1, ?, ?)`,
              [tenant, self, self, self, NOW, NOW],
            ),
          ),
        ),
      ).toBe(3819);
    });

    it('gives the runtime account DML only', async () => {
      expect(errnoOf(await rejection(sourceA.query(`DROP TABLE ${AREA_TABLES.history}`)))).toBe(
        1142,
      );
      expect(
        errnoOf(
          await rejection(sourceA.query(`ALTER TABLE ${AREA_TABLES.areas} DROP COLUMN name`)),
        ),
      ).toBe(1142);
    });

    it('is reversible: the down migration removes every table and up recreates them', async () => {
      // `startAreasDatabase` already ran down+up once; the schema must be whole afterwards.
      const names = await db.rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [db.databaseName],
      );
      expect(names).toHaveLength(Object.keys(AREA_TABLES).length + 7);
    });
  });

  describe('round trip and tenant isolation', () => {
    it('stores and reads an area with responsibles and history, exact strings and microsecond dates', async () => {
      const tenant = randomUUID();
      const area = {
        ...areaOf(tenant, { name: 'Base Norte' }),
        code: 'BN-1',
        responsibleIds: ['u1', 'u2'],
      };
      await insert(storeA, area);
      expect(await storeB.find(tenant, area.id)).toEqual(area);
      expect((await storeB.history(tenant, area.id, { limit: 5, offset: 0 })).items).toMatchObject([
        { action: 'created', fields: [], version: 1, actorId: ACTOR, fromParentId: null },
      ]);
      expect(
        await db.rows(
          `SELECT company_id, name_key, parent_key, code, depth, active FROM ${AREA_TABLES.areas} WHERE id = ?`,
          [area.id],
        ),
      ).toEqual([
        {
          company_id: tenant,
          name_key: 'base norte',
          parent_key: '',
          code: 'BN-1',
          depth: 1,
          active: 1,
        },
      ]);
    });

    it('never reaches a row of another company: reads, writes, history, children and listings', async () => {
      const a = randomUUID();
      const b = randomUUID();
      const areaA = areaOf(a);
      const areaB = areaOf(b);
      await insert(storeA, areaA);
      await insert(storeA, areaB);
      expect(await storeA.find(b, areaA.id)).toBeNull();
      expect((await storeA.history(b, areaA.id, { limit: 5, offset: 0 })).total).toBe(0);
      const foreignWrite = await storeA.transaction(b, (tx) =>
        tx.replace(
          { ...areaA, tenantId: b, version: 2, name: 'Hacked' },
          1,
          historyEntry(
            { ...areaA, tenantId: b, version: 2 },
            'updated',
            ['name'],
            { from: null, to: null },
            randomUUID(),
            ACTOR,
            NOW,
          ),
        ),
      );
      expect(foreignWrite).toBe(false);
      await storeA.transaction(b, (tx) => tx.setDepth(areaA.id, 3));
      expect(await storeA.find(a, areaA.id)).toMatchObject({ depth: 1, name: areaA.name });
      expect(
        await storeA.transaction(b, async (tx) => (await tx.children(null)).map((n) => n.id)),
      ).toEqual([areaB.id]);
      const listB = await storeA.list(b, { includeInactive: true }, { limit: 50, offset: 0 });
      expect(listB.items.map((item) => item.id)).toEqual([areaB.id]);
    });

    it('allows the same name and code in two companies', async () => {
      const shared = { name: 'Operaciones', code: 'OPS' };
      const one = { ...areaOf(randomUUID(), shared), code: 'OPS' };
      const two = { ...areaOf(randomUUID(), shared), code: 'OPS' };
      await insert(storeA, one);
      await insert(storeB, two);
      expect((await storeA.find(two.tenantId, two.id))?.code).toBe('OPS');
    });

    it('refuses a child, a responsible or a history row that attaches to an area of another company', async () => {
      const a = randomUUID();
      const areaA = areaOf(a);
      await insert(storeA, areaA);
      const b = randomUUID();
      const child = areaOf(b, { parentId: areaA.id, depth: 2 });
      expect(await rejection(insert(storeA, child))).toMatchObject({ code: 'integrity' });
      const mine = areaOf(b);
      const foreign = historyEntry(
        { ...mine, id: areaA.id },
        'created',
        [],
        { from: null, to: null },
        randomUUID(),
        ACTOR,
        NOW,
      );
      expect(
        await rejection(storeA.transaction(b, (tx) => tx.insert(mine, foreign))),
      ).toMatchObject({ code: 'integrity' });
      expect(await storeA.find(b, mine.id)).toBeNull();
    });
  });

  describe('uniqueness', () => {
    it('names the colliding key: sibling names (roots included) and codes per company', async () => {
      const tenant = randomUUID();
      const root = { ...areaOf(tenant, { name: 'Norte' }), code: 'N1' };
      await insert(storeA, root);
      const probe = (over: Partial<Area>) => rejection(insert(storeB, { ...areaOf(tenant, over) }));
      expect(await probe({ name: 'NORTE' })).toEqual(new AreaError('duplicate', 'name'));
      expect(await probe({ name: 'Sur', code: 'N1' })).toEqual(new AreaError('duplicate', 'code'));
      // Under another parent the same name is free.
      const child = areaOf(tenant, { name: 'Norte', parentId: root.id, depth: 2 });
      await insert(storeA, child);
      expect(
        await rejection(
          insert(storeA, areaOf(tenant, { name: 'norte', parentId: root.id, depth: 2 })),
        ),
      ).toEqual(new AreaError('duplicate', 'name'));
      const count = await db.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${AREA_TABLES.areas} WHERE company_id = ?`,
        [tenant],
      );
      expect(Number(count[0]?.n)).toBe(2);
    });

    it('treats many areas without a code as distinct', async () => {
      const tenant = randomUUID();
      for (let i = 0; i < 3; i += 1) await insert(storeA, areaOf(tenant));
      expect(
        (await storeA.list(tenant, { includeInactive: true }, { limit: 10, offset: 0 })).total,
      ).toBe(3);
    });

    it('lets exactly one of several concurrent creations of the same name win, from two processes', async () => {
      const tenant = randomUUID();
      const attempts = Array.from({ length: 6 }, (_, i) =>
        insert(i % 2 === 0 ? storeA : storeB, areaOf(tenant, { name: 'Carrera' })).then(
          () => 'ok',
          (error: unknown) =>
            error instanceof AreaError ? `${error.code}:${error.field}` : 'other',
        ),
      );
      const results = await Promise.all(attempts);
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result === 'duplicate:name')).toHaveLength(5);
    });
  });

  describe('optimistic concurrency and responsibles', () => {
    it('lets exactly one of many writers holding the same version win, and writes change + history + responsibles atomically', async () => {
      const tenant = randomUUID();
      const area = areaOf(tenant);
      await insert(storeA, area);
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? storeA : storeB).transaction(tenant, (tx) => {
            const next = { ...area, version: 2, name: `Nombre ${i}`, responsibleIds: [`u${i}`] };
            return tx.replace(
              next,
              1,
              historyEntry(
                next,
                'updated',
                ['name'],
                { from: null, to: null },
                randomUUID(),
                ACTOR,
                NOW,
              ),
            );
          }),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const stored = await storeA.find(tenant, area.id);
      expect(stored?.version).toBe(2);
      expect(stored?.responsibleIds).toHaveLength(1);
      expect(stored?.responsibleIds[0]).toBe(`u${stored?.name.split(' ')[1]}`);
      expect((await storeA.history(tenant, area.id, { limit: 10, offset: 0 })).total).toBe(2);
    });

    it('diffs responsibles in place: removed users go, added users appear, the rest stay', async () => {
      const tenant = randomUUID();
      const area = { ...areaOf(tenant), responsibleIds: ['u1', 'u2'] };
      await insert(storeA, area);
      const next = { ...area, version: 2, responsibleIds: ['u2', 'u3'] };
      await storeA.transaction(tenant, (tx) =>
        tx.replace(
          next,
          1,
          historyEntry(
            next,
            'updated',
            ['responsibles'],
            { from: null, to: null },
            randomUUID(),
            ACTOR,
            NOW,
          ),
        ),
      );
      expect((await storeB.find(tenant, area.id))?.responsibleIds).toEqual(['u2', 'u3']);
    });

    it('rolls the area change back when its history row violates a constraint', async () => {
      const tenant = randomUUID();
      const area = areaOf(tenant);
      await insert(storeA, area);
      const next = { ...area, version: 2, name: 'Cambiada', responsibleIds: ['u9'] };
      // Same version as the creation entry: violates the unique (company, area, version) key.
      const bad = historyEntry(
        { ...next, version: 1 },
        'updated',
        ['name'],
        { from: null, to: null },
        randomUUID(),
        ACTOR,
        NOW,
      );
      expect(
        await rejection(storeA.transaction(tenant, (tx) => tx.replace(next, 1, bad))),
      ).toBeInstanceOf(Error);
      expect(await storeA.find(tenant, area.id)).toEqual(area);
    });
  });

  describe('hierarchy invariants under concurrency', () => {
    it('never lets two crossing moves from two processes create a cycle', async () => {
      const [svcA, svcB] = services();
      for (let round = 0; round < 8; round += 1) {
        const tenant = randomUUID();
        const a = await svcA.create(tenant, ACTOR, { name: 'A' });
        const b = await svcA.create(tenant, ACTOR, { name: 'B' });
        const results = await Promise.allSettled([
          svcA.update(tenant, ACTOR, a.id, 1, { parentId: b.id }),
          svcB.update(tenant, ACTOR, b.id, 1, { parentId: a.id }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: 'invalid_hierarchy' });
        const rows = await db.rows<{ parent_id: string | null }>(
          `SELECT parent_id FROM ${AREA_TABLES.areas} WHERE company_id = ?`,
          [tenant],
        );
        expect(rows.filter((row) => row.parent_id === null)).toHaveLength(1);
      }
    });

    it('never exceeds four levels when a subtree move races an insert inside that subtree', async () => {
      const [svcA, svcB] = services();
      for (let round = 0; round < 6; round += 1) {
        const tenant = randomUUID();
        // top (1) > mid (2); other (1) > deep (2). Each of these is valid alone: `top` under `deep`
        // gives levels 3..4, and a child of `mid` is level 3. Together they would reach level 5.
        const top = await svcA.create(tenant, ACTOR, { name: 'Top' });
        const mid = await svcA.create(tenant, ACTOR, { name: 'Mid', parentId: top.id });
        const other = await svcA.create(tenant, ACTOR, { name: 'Other' });
        const deep = await svcA.create(tenant, ACTOR, { name: 'Deep', parentId: other.id });
        const results = await Promise.allSettled([
          svcA.update(tenant, ACTOR, top.id, 1, { parentId: deep.id }),
          svcB.create(tenant, ACTOR, { name: 'Child', parentId: mid.id }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: 'invalid_hierarchy' });
        const maxDepth = await db.rows<{ d: number }>(
          `SELECT MAX(depth) AS d FROM ${AREA_TABLES.areas} WHERE company_id = ?`,
          [tenant],
        );
        expect(Number(maxDepth[0]?.d)).toBeLessThanOrEqual(4);
      }
    });

    it('keeps every stored depth equal to the real level after racing moves', async () => {
      const [svcA, svcB] = services();
      const tenant = randomUUID();
      const roots = await Promise.all(
        ['R1', 'R2', 'R3'].map((name) => svcA.create(tenant, ACTOR, { name })),
      );
      const [r1, r2, r3] = roots as [Area, Area, Area];
      const child = await svcA.create(tenant, ACTOR, { name: 'C', parentId: r1.id });
      await svcA.create(tenant, ACTOR, { name: 'G', parentId: child.id });
      await Promise.allSettled([
        svcA.update(tenant, ACTOR, child.id, 1, { parentId: r2.id }),
        svcB.update(tenant, ACTOR, r3.id, 1, { parentId: r1.id }),
        svcB.update(tenant, ACTOR, r2.id, 1, { parentId: r3.id }),
      ]);
      const rows = await db.rows<{ id: string; parent_id: string | null; depth: number }>(
        `SELECT id, parent_id, depth FROM ${AREA_TABLES.areas} WHERE company_id = ?`,
        [tenant],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const levelOf = (id: string): number => {
        let level = 1;
        for (let row = byId.get(id); row?.parent_id; row = byId.get(row.parent_id)) level += 1;
        return level;
      };
      for (const row of rows) expect([row.id, row.depth]).toEqual([row.id, levelOf(row.id)]);
    });

    it('never leaves an active area under a deactivated one when deactivation races a child creation', async () => {
      const [svcA, svcB] = services();
      for (let round = 0; round < 6; round += 1) {
        const tenant = randomUUID();
        const parent = await svcA.create(tenant, ACTOR, { name: 'Padre' });
        const results = await Promise.allSettled([
          svcA.deactivate(tenant, ACTOR, parent.id, 1),
          svcB.create(tenant, ACTOR, { name: 'Hija', parentId: parent.id }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rows = await db.rows<{ active: number; parent_id: string | null }>(
          `SELECT active, parent_id FROM ${AREA_TABLES.areas} WHERE company_id = ?`,
          [tenant],
        );
        const parentRow = rows.find((row) => row.parent_id === null);
        const childRow = rows.find((row) => row.parent_id !== null);
        expect(!(parentRow?.active === 0 && childRow?.active === 1)).toBe(true);
      }
    });

    it('serializes a deactivation against a concurrent resource check without double-applying', async () => {
      const [svcA] = services();
      const tenant = randomUUID();
      const area = await svcA.create(tenant, ACTOR, { name: 'Unica' });
      const results = await Promise.allSettled(
        [storeA, storeB, storeA, storeB].map((store) =>
          new AreaService(store, {
            resources: { vehicles: NO_RESOURCES, people: NO_RESOURCES },
          }).deactivate(tenant, ACTOR, area.id, 1),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await storeA.find(tenant, area.id))?.version).toBe(2);
      expect((await storeA.history(tenant, area.id, { limit: 10, offset: 0 })).total).toBe(2);
    });

    it('uses one lock row per company and never blocks another company', async () => {
      const [svcA] = services();
      const slow = randomUUID();
      const quick = randomUUID();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const holding = storeA.transaction(slow, async () => gate);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Another company proceeds while the first transaction still holds its lock.
      await svcA.create(quick, ACTOR, { name: 'Rapida' });
      release();
      await holding;
      const locks = await db.rows<{ company_id: string }>(
        `SELECT company_id FROM ${AREA_TABLES.locks} WHERE company_id IN (?, ?)`,
        [slow, quick],
      );
      expect(locks.map((row) => row.company_id).sort()).toEqual([quick, slow].sort());
    });
  });

  describe('listing and history', () => {
    it('filters by parent and activity, pages in a stable order with a total, and loads responsibles', async () => {
      const tenant = randomUUID();
      const [svc] = services();
      const b = await svc.create(tenant, ACTOR, { name: 'b', responsibleIds: ['u1'] });
      const a = await svc.create(tenant, ACTOR, { name: 'A' });
      await svc.create(tenant, ACTOR, { name: 'C', parentId: b.id, responsibleIds: ['u2', 'u3'] });
      await svc.deactivate(tenant, ACTOR, a.id, 1);
      const names = async (query: Record<string, unknown>) =>
        (await svc.list(tenant, query)).items.map((x) => x.name);
      expect(await names({})).toEqual(['b', 'C']);
      expect(await names({ includeInactive: true })).toEqual(['A', 'b', 'C']);
      expect(await names({ includeInactive: true, parentId: null })).toEqual(['A', 'b']);
      expect(await names({ parentId: b.id })).toEqual(['C']);
      expect(await names({ includeInactive: true, limit: 1, offset: 1 })).toEqual(['b']);
      expect((await svc.list(tenant, { includeInactive: true, limit: 1 })).total).toBe(3);
      expect((await svc.list(tenant, { parentId: b.id })).items[0]?.responsibleIds).toEqual([
        'u2',
        'u3',
      ]);
      const history = await svc.history(tenant, a.id, { limit: 1 });
      expect(history.total).toBe(2);
      expect(history.items[0]).toMatchObject({ action: 'deactivated', version: 2 });
    });
  });

  describe('failure hygiene', () => {
    it('does not leak names, codes or SQL when the database refuses a statement', async () => {
      const tenant = randomUUID();
      const area = { ...areaOf(tenant, { name: 'Nombre Secreto' }), code: 'LEAK-1' };
      // `version` 0 violates a CHECK constraint, which the store reports as integrity.
      const error = await rejection(insert(storeA, { ...area, version: 0 }));
      expect(error).toBeInstanceOf(AreaStoreError);
      expect(error).toMatchObject({ code: 'integrity', errno: 3819 });
      const text = `${(error as Error).message}${JSON.stringify(error)}${JSON.stringify(events)}`;
      for (const secret of ['Nombre Secreto', 'LEAK-1', tenant, 'INSERT', 'opslog_'])
        expect(text).not.toContain(secret);
    });
  });
});
