import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource, QueryRunner } from 'typeorm';
import {
  createSavedViewsDataSource,
  createSavedViewsMigrationDataSource,
  runSavedViewsMigrations,
} from './data-source.js';
import {
  ListColumnsEntity,
  SAVED_VIEW_ENTITIES,
  SAVED_VIEW_TABLES as T,
  SavedViewEntity,
} from './entities.js';
import {
  CreateSavedViews2026101900020,
  SAVED_VIEWS_MIGRATIONS_TABLE,
  SAVED_VIEWS_MIGRATION_VERSION,
} from './migrations.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('saved views schema', () => {
  it('creates both tables with company-first keys, a per-owner unique name and checks', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateSavedViews2026101900020();
    await migration.up(runner);
    const [views, columns] = statements as [string, string];
    expect(views).toContain('PRIMARY KEY (company_id,id)');
    expect(views).toContain('UNIQUE KEY uq_view_name (company_id,owner_id,module,name_key)');
    expect(views).toContain(
      "module IN ('vehicles','employees','documents','insurance','maintenance','incidents')",
    );
    expect(views).toContain("sort_direction IN ('asc','desc')");
    expect(columns).toContain('PRIMARY KEY (company_id,member_id,module)');
    expect(columns).toContain('COLLATE=utf8mb4_0900_bin');
    await migration.down(runner);
    expect(statements.slice(-2)).toEqual([`DROP ${T.columns}`, `DROP ${T.views}`]);
    expect(SAVED_VIEWS_MIGRATION_VERSION).toBe('2026101900020');
  });

  it('has its own migrations table and refuses synchronize and startup migrations', async () => {
    const source = createSavedViewsMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(source.options.migrationsTableName).toBe(SAVED_VIEWS_MIGRATIONS_TABLE);
    expect(source.options.migrations).toEqual([CreateSavedViews2026101900020]);
    (source.options as { synchronize: boolean }).synchronize = true;
    await expect(runSavedViewsMigrations(source)).rejects.toThrow(/forbidden/);
    (source.options as { synchronize: boolean }).synchronize = false;
    (source.options as { migrationsRun: boolean }).migrationsRun = true;
    await expect(runSavedViewsMigrations(source)).rejects.toThrow(/forbidden/);
  });

  it('opens the runtime source only with the restricted account', () => {
    expect(() => createSavedViewsDataSource({ ...endpoint, username: 'root' })).toThrow(
      /restricted/,
    );
    const source = createSavedViewsDataSource({ ...endpoint, username: 'opslog_views_ab12' });
    expect(source.options.synchronize).toBe(false);
    expect(source.options.logging).toBe(false);
    expect(source.options.entities).toEqual(expect.arrayContaining(SAVED_VIEW_ENTITIES));
  });

  it('runs the pending migrations in one transaction when nothing automatic is configured', async () => {
    const seen: unknown[] = [];
    const source = {
      options: { synchronize: false, migrationsRun: false },
      runMigrations: async (options: unknown) => void seen.push(options),
    } as unknown as DataSource;
    await runSavedViewsMigrations(source);
    expect(seen).toEqual([{ transaction: 'all' }]);
    expect(new SavedViewEntity()).toBeInstanceOf(SavedViewEntity);
    expect(new ListColumnsEntity()).toBeInstanceOf(ListColumnsEntity);
  });

  it('maps the shared flag to a tinyint both ways', () => {
    const column = (
      SAVED_VIEW_ENTITIES[0] as {
        options: {
          columns: Record<
            string,
            { transformer?: { to(v: boolean): number; from(v: number): boolean } }
          >;
        };
      }
    ).options.columns.shared;
    expect(column?.transformer?.to(true)).toBe(1);
    expect(column?.transformer?.to(false)).toBe(0);
    expect(column?.transformer?.from(1)).toBe(true);
    expect(column?.transformer?.from(0)).toBe(false);
  });
});
