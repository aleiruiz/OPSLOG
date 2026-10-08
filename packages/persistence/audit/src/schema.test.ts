import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DataSource, type QueryRunner, type Table } from 'typeorm';
import { AUDIT_ENTITIES, AUDIT_TABLES } from './entities.js';
import {
  AUDIT_MIGRATION_VERSION,
  CreateAuditStore2026100700010,
  ensureAuditYearPartition,
} from './migrations.js';
import {
  AUDIT_MIGRATOR_ACCOUNT,
  AUDIT_RELAY_ACCOUNT,
  AUDIT_RUNTIME_ACCOUNT,
  createAuditMigrationDataSource,
  createAuditRelayDataSource,
  createAuditRuntimeDataSource,
} from './data-source.js';

const config = {
  host: '127.0.0.1',
  port: 3306,
  database: 'opslog_t_synthetic_a',
  username: '',
  password: 'synthetic-only',
};

function runnerForMigration() {
  const tables: Table[] = [];
  const queries: string[] = [];
  const runner = {
    createTable: async (table: Table) => tables.push(table),
    query: async (query: string) => {
      queries.push(query);
      return [];
    },
  } as unknown as QueryRunner;
  return { runner, tables, queries };
}

describe('audit persistence schema', () => {
  it('creates the local append-only, delivery, projection and registry tables', async () => {
    const { runner, tables, queries } = runnerForMigration();
    const migration = new CreateAuditStore2026100700010();
    await migration.up(runner);
    expect(tables.map((table) => table.name)).toEqual([
      AUDIT_TABLES.local,
      AUDIT_TABLES.delivery,
      AUDIT_TABLES.projection,
      AUDIT_TABLES.registry,
    ]);
    expect(tables[0]?.primaryColumns.map((column) => column.name)).toEqual([
      'tenant_id',
      'event_id',
    ]);
    expect(tables[2]?.primaryColumns.map((column) => column.name)).toEqual([
      'tenant_id',
      'event_id',
      'occurred_at',
    ]);
    expect(tables[1]?.foreignKeys).toEqual([]);
    expect(queries[0]).toContain('PARTITION BY RANGE COLUMNS (`occurred_at`)');
    expect(queries[0]).toContain('PARTITION pmax VALUES LESS THAN (MAXVALUE)');
    expect(migration.name.endsWith(AUDIT_MIGRATION_VERSION)).toBe(true);
    await expect(migration.down()).rejects.toThrow(/cannot be rolled back destructively/);
  });

  it('declares ORM metadata for every persisted field and tenant/date index', async () => {
    const source = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...AUDIT_ENTITIES],
      synchronize: false,
    });
    await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    expect(source.entityMetadatas.map((entity) => entity.tableName).sort()).toEqual(
      Object.values(AUDIT_TABLES).sort(),
    );
    expect(
      source.entityMetadatas.find((entity) => entity.tableName === AUDIT_TABLES.projection)
        ?.indices,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ix_audit_projection_tenant_date' }),
      ]),
    );
    expect(
      source.entityMetadatas.find((entity) => entity.tableName === AUDIT_TABLES.delivery)
        ?.foreignKeys,
    ).toEqual([]);
  });

  it('extends the future catch-all one safe annual partition at a time', async () => {
    const queries: string[] = [];
    const runner = {
      query: async (query: string) => {
        queries.push(query);
        return [{ name: 'p2020' }, { name: 'p2035' }, { name: 'pmax' }];
      },
    } as unknown as QueryRunner;
    await ensureAuditYearPartition(runner, 2037);
    expect(queries.slice(1)).toEqual([
      expect.stringContaining('PARTITION p2036 VALUES LESS THAN'),
      expect.stringContaining('PARTITION p2037 VALUES LESS THAN'),
    ]);
    await expect(ensureAuditYearPartition(runner, 10_000)).rejects.toThrow(/partition year/);
  });

  it('requires a tenant-exclusive database and separate role accounts', () => {
    expect(AUDIT_RUNTIME_ACCOUNT.test('opslog_audit_runtime_a1')).toBe(true);
    expect(AUDIT_RELAY_ACCOUNT.test('opslog_audit_relay_a1')).toBe(true);
    expect(AUDIT_MIGRATOR_ACCOUNT.test('opslog_audit_migrator_a1')).toBe(true);
    expect(() =>
      createAuditRuntimeDataSource({ ...config, username: 'opslog_audit_runtime_a' }),
    ).not.toThrow();
    expect(() =>
      createAuditRuntimeDataSource({
        ...config,
        database: 'shared_audit',
        username: 'opslog_audit_runtime_a',
      }),
    ).toThrow(/tenant-exclusive/);
    expect(() =>
      createAuditRuntimeDataSource({ ...config, username: 'opslog_audit_relay_a' }),
    ).toThrow(/restricted account/);
    expect(() =>
      createAuditRelayDataSource({ ...config, username: 'opslog_audit_runtime_a' }),
    ).toThrow(/restricted account/);
    expect(() =>
      createAuditMigrationDataSource({ ...config, username: 'opslog_audit_migrator_a' }),
    ).not.toThrow();
  });
});
