import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUDIT_MIGRATIONS_TABLE, AUDIT_TABLES } from '../../audit/src/index.js';
import { SettingsService, type CompanySettings } from '../../../domain/settings/src/index.js';
import { BINARY_COLLATION, SETTINGS_TABLES } from './entities.js';
import { SettingsStoreError } from './errors.js';
import { TypeOrmSettingsStore, type StoreErrorEvent } from './store.js';
import { adminUrl, startSettingsDatabase, type SettingsDatabase } from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const auditSchemaTables = [
  ...Object.values(AUDIT_TABLES),
  'opslog_audit_local_keys',
  AUDIT_MIGRATIONS_TABLE,
];

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const T = SETTINGS_TABLES;

const settings = (tenant: string, over: Partial<CompanySettings> = {}): CompanySettings => ({
  tenantId: tenant,
  expiryWindowDays: 15,
  recipientRoles: ['admin', 'editor'],
  version: 1,
  updatedBy: ACTOR,
  updatedAt: NOW.toISOString(),
  ...over,
});

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

const insert = (db: SettingsDatabase, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return outcome(
    db.admin.query(
      `INSERT INTO ${T.settings} (${columns.map((c) => `\`${c}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      Object.values(row),
    ),
  );
};

suite('persistent settings store on MySQL', () => {
  let db: SettingsDatabase;
  let sourceA: DataSource;
  let sourceB: DataSource;
  let storeA: TypeOrmSettingsStore;
  let storeB: TypeOrmSettingsStore;
  let svcA: SettingsService;
  let svcB: SettingsService;
  const events: StoreErrorEvent[] = [];

  beforeAll(async () => {
    db = await startSettingsDatabase('store');
    sourceA = await db.openRuntime();
    sourceB = await db.openRuntime();
    storeA = new TypeOrmSettingsStore(sourceA, { onError: (event) => events.push(event) });
    // A second pool stands in for another API process.
    storeB = new TypeOrmSettingsStore(sourceB);
    svcA = new SettingsService(storeA, { now: () => new Date() });
    svcB = new SettingsService(storeB, { now: () => new Date() });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  }, 60_000);

  const row = (patch: Record<string, unknown> = {}) => ({
    company_id: 'tenant-checks',
    expiry_window_days: 15,
    recipient_roles: 'admin,editor',
    version: 1,
    updated_by: ACTOR,
    updated_at: NOW,
    ...patch,
  });

  describe('schema', () => {
    it('is created in its own migrations table with binary collations and a company primary key', async () => {
      const tables = await db.rows<{ t: string }>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [db.databaseName],
      );
      expect(tables.map((r) => r.t).sort()).toEqual(
        [...Object.values(T), 'opslog_settings_migrations', ...auditSchemaTables].sort(),
      );
      const columns = await db.rows<{ coll: string }>(
        `SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar', 'char') AND TABLE_NAME = ?`,
        [db.databaseName, T.settings],
      );
      expect(columns).toHaveLength(3);
      expect(columns.filter((column) => column.coll !== BINARY_COLLATION)).toEqual([]);
      const keys = await db.rows<{ name: string; col: string }>(
        `SELECT INDEX_NAME AS name, COLUMN_NAME AS col FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [db.databaseName, T.settings],
      );
      expect(keys).toEqual([{ name: 'PRIMARY', col: 'company_id' }]);
    });

    it('rejects malformed rows by CHECK constraint, whoever writes them', async () => {
      const illegal: Record<string, Record<string, unknown>> = {
        'window zero': { expiry_window_days: 0 },
        'window above 30': { expiry_window_days: 31 },
        'version zero': { version: 0 },
        'blank writer': { updated_by: '   ' },
        'empty recipients': { recipient_roles: '' },
        'unknown role': { recipient_roles: 'admin,root' },
        'trailing comma': { recipient_roles: 'admin,' },
        'leading space': { recipient_roles: ' admin' },
        'upper case role': { recipient_roles: 'Admin' },
        'six roles': { recipient_roles: 'admin,editor,viewer,auditor,pii_reader,admin' },
      };
      for (const [label, patch] of Object.entries(illegal)) {
        const error = await insert(db, row(patch));
        expect([label, errnoOf(error)]).toEqual([label, 3819]);
      }
      const nulls = await insert(db, { ...row(), recipient_roles: null });
      expect(errnoOf(nulls)).toBe(1048);
      expect(
        await insert(db, row({ company_id: 'tenant-edge-1', expiry_window_days: 1 })),
      ).toBeUndefined();
      expect(
        await insert(db, row({ company_id: 'tenant-edge-30', expiry_window_days: 30 })),
      ).toBeUndefined();
      expect(
        await insert(
          db,
          row({
            company_id: 'tenant-all',
            recipient_roles: 'admin,editor,viewer,auditor,pii_reader',
          }),
        ),
      ).toBeUndefined();
    });

    it('keeps the company key exact: binary collation makes ids case and accent sensitive', async () => {
      expect(await insert(db, row({ company_id: 'Tenant-Case' }))).toBeUndefined();
      expect(await insert(db, row({ company_id: 'tenant-case' }))).toBeUndefined();
      expect(errnoOf(await insert(db, row({ company_id: 'Tenant-Case' })))).toBe(1062);
    });
  });

  describe('least privilege', () => {
    it('lets the runtime account read, insert and update but never delete, truncate or alter', async () => {
      const probe = await sourceA.query(`SELECT COUNT(*) AS n FROM ${T.settings}`);
      expect(Number(probe[0].n)).toBeGreaterThan(0);
      const denied = async (sql: string) => errnoOf(await outcome(sourceA.query(sql)));
      expect(await denied(`DELETE FROM ${T.settings}`)).toBe(1142);
      expect(await denied(`TRUNCATE TABLE ${T.settings}`)).toBe(1142);
      expect(await denied(`DROP TABLE ${T.settings}`)).toBe(1142);
      expect(await denied(`ALTER TABLE ${T.settings} ADD COLUMN x INT`)).toBe(1142);
      const grants = await db.rows<Record<string, string>>(
        `SHOW GRANTS FOR '${db.runtimeUser}'@'%'`,
      );
      const text = grants.map((grant) => Object.values(grant)[0]).join('\n');
      expect(text).toContain('SELECT, INSERT, UPDATE');
      expect(text).not.toMatch(/DELETE|ALL PRIVILEGES|GRANT OPTION/);
    });
  });

  describe('store behaviour', () => {
    it('round-trips settings with microseconds, canonical roles and the UTC clock', async () => {
      const value = settings('tenant-rt', {
        updatedAt: '2026-10-06T12:00:00.123Z',
        recipientRoles: ['viewer', 'pii_reader'],
        expiryWindowDays: 30,
      });
      expect(await storeA.find('tenant-rt')).toBeNull();
      expect(await storeA.insert(value)).toBe(true);
      expect(await storeB.find('tenant-rt')).toEqual(value);
    });

    it('rolls settings back when the runtime cannot append local audit', async () => {
      const value = settings('tenant-audit-rollback');
      await db.admin.query(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` FROM '${db.runtimeUser}'@'%'`,
      );
      try {
        expect(await outcome(storeA.insert(value))).toBeInstanceOf(SettingsStoreError);
        expect(await storeA.find(value.tenantId)).toBeNull();
        expect(
          await db.rows(`SELECT event_id FROM ${AUDIT_TABLES.local} WHERE tenant_id = ?`, [
            value.tenantId,
          ]),
        ).toHaveLength(0);
        expect(
          await db.rows(`SELECT event_id FROM ${AUDIT_TABLES.delivery} WHERE tenant_id = ?`, [
            value.tenantId,
          ]),
        ).toHaveLength(0);
      } finally {
        await db.admin.query(
          `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`opslog_append_local_audit_and_delivery\` TO '${db.runtimeUser}'@'%'`,
        );
      }
    });

    it('decides a second first write by the primary key', async () => {
      expect(await storeA.insert(settings('tenant-dup'))).toBe(true);
      expect(await storeB.insert(settings('tenant-dup', { expiryWindowDays: 3 }))).toBe(false);
      expect((await storeA.find('tenant-dup'))?.expiryWindowDays).toBe(15);
    });

    it('replaces only the matching version and never touches another company', async () => {
      await storeA.insert(settings('tenant-r1'));
      await storeA.insert(settings('tenant-r2'));
      const next = settings('tenant-r1', {
        version: 2,
        expiryWindowDays: 7,
        recipientRoles: ['auditor'],
      });
      expect(await storeA.replace(next, 9)).toBe(false);
      expect(await storeA.replace(next, 1)).toBe(true);
      expect(await storeA.replace(next, 1)).toBe(false);
      expect(await storeB.find('tenant-r1')).toEqual(next);
      expect((await storeA.find('tenant-r2'))?.version).toBe(1);
      expect(await storeA.replace(settings('tenant-none', { version: 2 }), 1)).toBe(false);
    });

    it('treats a stored row that breaks the domain shape as an integrity error without leaking it', async () => {
      // The CHECK refuses it for any writer, so simulate drift by a store over a corrupted read.
      const error = await outcome(
        new TypeOrmSettingsStore({
          options: sourceA.options,
          getRepository: () => ({
            findOneBy: async () => ({
              tenantId: 'x',
              expiryWindowDays: 15,
              recipientRoles: 'editor,admin',
              version: 1,
              updatedBy: ACTOR,
              updatedAt: NOW,
            }),
          }),
        } as unknown as DataSource).find('x'),
      );
      expect(error).toBeInstanceOf(SettingsStoreError);
      expect(error).toMatchObject({ code: 'integrity' });
    });

    it('sanitizes a driver failure: no SQL, no parameters', async () => {
      const broken = new TypeOrmSettingsStore(
        await db.openRuntime(1).then(async (source) => {
          await source.destroy();
          return source;
        }),
        { onError: (event) => events.push(event) },
      );
      const error = await outcome(broken.find('tenant-secret-value'));
      expect(error).toBeInstanceOf(SettingsStoreError);
      expect(JSON.stringify(error)).not.toContain('tenant-secret-value');
      expect(String((error as Error).message)).not.toContain('SELECT');
      expect(events.at(-1)?.operation).toBe('find');
    });
  });

  describe('real concurrency', () => {
    it('lets exactly one of many concurrent first writes win, across two pools', async () => {
      const input = { expiryWindowDays: 10, recipientRoles: ['admin'] };
      const outcomes = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 === 0 ? svcA : svcB).update('tenant-race', ACTOR, 0, {
            ...input,
            expiryWindowDays: 1 + index,
          }),
        ),
      );
      const won = outcomes.filter((result) => result.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const result of outcomes.filter((candidate) => candidate.status === 'rejected'))
        expect(result.reason).toMatchObject({ code: 'stale_version' });
      expect((await svcA.get('tenant-race')).version).toBe(1);
    });

    it('lets exactly one of many concurrent replacements of the same version win', async () => {
      await svcA.update('tenant-race2', ACTOR, 0, {
        expiryWindowDays: 5,
        recipientRoles: ['admin'],
      });
      const outcomes = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 === 0 ? svcA : svcB).update('tenant-race2', ACTOR, 1, {
            expiryWindowDays: 1 + index,
            recipientRoles: ['editor'],
          }),
        ),
      );
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const stored = await svcB.get('tenant-race2');
      expect(stored.version).toBe(2);
      expect(stored.recipientRoles).toEqual(['editor']);
    });
  });
});
