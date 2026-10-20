import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import {
  createExportDataSource,
  createExportMigrationDataSource,
  runExportMigrations,
} from './data-source.js';
import { EXPORT_ENTITIES, EXPORT_TABLES as T } from './entities.js';
import {
  CreateExportJobs2026101900050,
  EXPORT_MIGRATIONS_TABLE,
  EXPORT_MIGRATION_VERSION,
} from './migrations.js';
import { TypeOrmExportJobStore } from './store.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('export jobs schema', () => {
  it('creates the table with its keys, checks and idempotency key, and drops it on down', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateExportJobs2026101900050();
    await migration.up(runner);
    const [create] = statements as [string];
    expect(create).toContain('PRIMARY KEY (company_id,id)');
    expect(create).toContain('UNIQUE KEY ux_export_key (company_id,actor_id,idempotency_key)');
    expect(create).toContain("format IN ('csv','xlsx','pdf')");
    expect(create).toContain("status IN ('queued','running','completed','failed','expired')");
    expect(create).toContain('COLLATE=utf8mb4_0900_bin');
    await migration.down(runner);
    expect(statements.at(-1)).toBe(`DROP ${T.jobs}`);
    expect(EXPORT_MIGRATION_VERSION).toBe('2026101900050');
    expect(EXPORT_ENTITIES).toHaveLength(1);
  });

  it('has its own migrations table and refuses synchronize and startup migrations', async () => {
    const source = createExportMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(EXPORT_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateExportJobs2026101900050]);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runExportMigrations(source)).rejects.toThrow(/forbidden/);
    (source.options as { synchronize: boolean; migrationsRun: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runExportMigrations(source)).rejects.toThrow(/forbidden/);
  });

  it('refuses a runtime account that is not its own', () => {
    expect(() => createExportDataSource({ ...endpoint, username: 'root' })).toThrow(
      /restricted runtime account/,
    );
    const source = createExportDataSource({ ...endpoint, username: 'opslog_exports_abc' });
    expect(source.options.synchronize).toBe(false);
    expect(source.options.logging).toBe(false);
    expect(() => new TypeOrmExportJobStore({ options: { username: 'root' } } as never)).toThrow(
      /restricted runtime account/,
    );
  });
});
