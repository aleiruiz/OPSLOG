import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource, QueryRunner } from 'typeorm';
import {
  createSearchDataSource,
  createSearchMigrationDataSource,
  runSearchMigrations,
} from './data-source.js';
import { SEARCH_ENTITIES, SEARCH_TABLES as T, SearchEntryEntity } from './entities.js';
import {
  CreateSearch2026101900010,
  SEARCH_MIGRATIONS_TABLE,
  SEARCH_MIGRATION_VERSION,
} from './migrations.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('search schema', () => {
  it('creates the projection with its keys, checks, prefix index and ngram FULLTEXT without stopwords', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateSearch2026101900010();
    await migration.up(runner);
    const [create, off, fulltext, on] = statements as [string, string, string, string];
    expect(create).toContain('PRIMARY KEY (company_id,entity_type,entity_id,key_kind,normalized)');
    expect(create).toContain('KEY ix_search_prefix (company_id,entity_type,normalized)');
    expect(create).toContain("required_permission IN ('view','view_pii','incidents:view')");
    expect(create).toContain('COLLATE=utf8mb4_0900_bin');
    expect(off).toBe('SET SESSION innodb_ft_enable_stopword = 0');
    expect(fulltext).toContain(
      'ADD FULLTEXT INDEX ft_search_normalized (normalized) WITH PARSER ngram',
    );
    expect(on).toBe('SET SESSION innodb_ft_enable_stopword = 1');
    await migration.down(runner);
    expect(statements.at(-1)).toBe(`DROP ${T.entries}`);
    expect(SEARCH_MIGRATION_VERSION).toBe('2026101900010');
  });

  it('restores the stopword setting when the index cannot be created', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('ALTER TABLE')) throw new Error('boom');
      },
    } as unknown as QueryRunner;
    await expect(new CreateSearch2026101900010().up(runner)).rejects.toThrow('boom');
    expect(statements.at(-1)).toBe('SET SESSION innodb_ft_enable_stopword = 1');
  });

  it('has its own migrations table and refuses synchronize and startup migrations', async () => {
    const source = createSearchMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(SEARCH_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateSearch2026101900010]);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runSearchMigrations(source)).rejects.toThrow(/forbidden/);
    (source.options as { synchronize: boolean; migrationsRun: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runSearchMigrations(source)).rejects.toThrow(/forbidden/);
  });

  it('opens the runtime source only with the restricted search account', () => {
    expect(() => createSearchDataSource({ ...endpoint, username: 'root' })).toThrow(/restricted/);
    const source = createSearchDataSource({ ...endpoint, username: 'opslog_search_ab12' });
    expect(source.options.synchronize).toBe(false);
    expect(source.options.logging).toBe(false);
    expect(source.options.entities).toEqual(expect.arrayContaining(SEARCH_ENTITIES));
  });

  it('runs the pending migrations in one transaction when nothing automatic is configured', async () => {
    const seen: unknown[] = [];
    const source = {
      options: { synchronize: false, migrationsRun: false },
      runMigrations: async (options: unknown) => void seen.push(options),
    } as unknown as DataSource;
    await runSearchMigrations(source);
    expect(seen).toEqual([{ transaction: 'all' }]);
    expect(new SearchEntryEntity()).toBeInstanceOf(SearchEntryEntity);
  });
});
