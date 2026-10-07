import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import {
  IMPORT_ORM_ENTITIES,
  IMPORT_TABLES,
  ImportJobEntity,
  BINARY_COLLATION,
} from './entities.js';
import {
  IMPORT_CHECKS,
  IMPORTS_MIGRATIONS_TABLE,
  IMPORTS_MIGRATION_VERSION,
  CreateImportJobs2026100600090,
} from './migrations.js';
import {
  IMPORTS_RUNTIME_ACCOUNT,
  createImportsDataSource,
  createImportsMigrationDataSource,
  runImportsMigrations,
} from './data-source.js';

const migration = new CreateImportJobs2026100600090();

function recordingRunner() {
  const tables: Table[] = [];
  const statements: string[] = [];
  const dropped: string[] = [];
  const runner = {
    createTable: async (table: Table) => {
      tables.push(table);
    },
    dropTable: async (name: string) => {
      dropped.push(name);
    },
    query: async (sql: string) => {
      statements.push(sql);
      return [];
    },
  } as unknown as QueryRunner;
  return { runner, tables, statements, dropped };
}

async function metadata(): Promise<EntityMetadata[]> {
  const dataSource = new DataSource({
    type: 'mysql',
    database: 'synthetic',
    entities: [...IMPORT_ORM_ENTITIES],
    synchronize: false,
  });
  await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  return dataSource.entityMetadatas;
}

describe('migration and entity metadata agree', () => {
  it('creates exactly the entity tables in dependency order and drops them in reverse', async () => {
    const { runner, tables, dropped } = recordingRunner();
    await migration.up(runner);
    expect(tables.map((table) => table.name)).toEqual([
      IMPORT_TABLES.jobs,
      IMPORT_TABLES.rows,
      IMPORT_TABLES.events,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateImportJobs2026100600090');
    expect(migration.name.endsWith(IMPORTS_MIGRATION_VERSION)).toBe(true);
    expect(IMPORTS_MIGRATION_VERSION).toMatch(/^\d{13}$/);
    // After the assignments migration (2026100600080): the next free id.
    expect(Number(IMPORTS_MIGRATION_VERSION)).toBeGreaterThan(2026100600080);
  });

  it('declares every column of every entity with the same type, size, nullability and collation', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    const entities = await metadata();
    expect(entities.map((entity) => entity.tableName).sort()).toEqual(
      tables.map((table) => table.name).sort(),
    );
    for (const table of tables) {
      const entity = entities.find((candidate) => candidate.tableName === table.name);
      if (!entity) throw new Error(`no entity for ${table.name}`);
      expect(entity.columns.map((column) => column.databaseName).sort()).toEqual(
        table.columns.map((column) => column.name).sort(),
      );
      for (const column of table.columns) {
        const mapped = entity.columns.find((candidate) => candidate.databaseName === column.name);
        if (!mapped) throw new Error(`no column ${column.name}`);
        const label = `${table.name}.${column.name}`;
        expect([label, mapped.type]).toEqual([label, column.type]);
        expect([label, String(mapped.length || '')]).toEqual([label, column.length || '']);
        expect([label, mapped.isPrimary]).toEqual([label, column.isPrimary]);
        expect([label, mapped.isNullable]).toEqual([label, column.isNullable]);
        expect([label, mapped.unsigned ?? false]).toEqual([label, column.unsigned ?? false]);
        expect([label, mapped.collation ?? null]).toEqual([label, column.collation ?? null]);
        expect([label, mapped.precision ?? null]).toEqual([label, column.precision ?? null]);
        if (column.type === 'varchar' || column.type === 'char')
          expect([label, column.collation]).toEqual([label, BINARY_COLLATION]);
      }
    }
  });

  it('declares the same unique constraints and indexes', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    const entities = await metadata();
    for (const table of tables) {
      const entity = entities.find((candidate) => candidate.tableName === table.name);
      const expected = [
        ...table.uniques.map((unique) => ({
          name: unique.name,
          columns: unique.columnNames,
          unique: true,
        })),
        ...table.indices.map((index) => ({
          name: index.name,
          columns: index.columnNames,
          unique: index.isUnique,
        })),
      ].sort((left, right) => String(left.name).localeCompare(String(right.name)));
      const mapped = (entity?.indices ?? [])
        .map((index) => ({
          name: index.name,
          columns: index.columns.map((column) => column.databaseName),
          unique: index.isUnique,
        }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
      expect([table.name, mapped]).toEqual([table.name, expected]);
    }
  });

  it('keys every table by company and declares the idempotency key as a unique key', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    const jobs = tables.find((table) => table.name === IMPORT_TABLES.jobs);
    const rows = tables.find((table) => table.name === IMPORT_TABLES.rows);
    const events = tables.find((table) => table.name === IMPORT_TABLES.events);
    const keyOf = (table: Table | undefined) =>
      table?.columns.filter((column) => column.isPrimary).map((c) => c.name);
    expect(keyOf(jobs)).toEqual(['company_id', 'id']);
    expect(keyOf(rows)).toEqual(['company_id', 'job_id', 'row_number']);
    expect(keyOf(events)).toEqual(['company_id', 'job_id', 'seq']);
    for (const table of tables) {
      for (const unique of table.uniques) expect(unique.columnNames[0]).toBe('company_id');
      for (const index of table.indices) expect(index.columnNames[0]).toBe('company_id');
    }
    expect(
      jobs?.indices.filter((index) => index.isUnique).map((i) => [i.name, i.columnNames]),
    ).toEqual([['ux_import_jobs_key', ['company_id', 'idempotency_key']]]);
    // A dry run may omit the key: it is nullable, so NULLs never collide.
    expect(jobs?.columns.find((c) => c.name === 'idempotency_key')?.isNullable).toBe(true);
    for (const table of [rows, events])
      expect(
        table?.foreignKeys.map((fk) => [
          fk.columnNames,
          fk.referencedTableName,
          fk.referencedColumnNames,
        ]),
      ).toEqual([[['company_id', 'job_id'], IMPORT_TABLES.jobs, ['company_id', 'id']]]);
    expect(jobs?.foreignKeys).toEqual([]);
    // No column can hold an imported value: only counts, codes, template column names and ids.
    const names = tables.flatMap((table) => table.columns.map((column) => column.name));
    expect(names).not.toEqual(expect.arrayContaining(['values', 'payload', 'data', 'raw']));
  });

  it('adds NULL-safe CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(IMPORT_CHECKS.length);
    for (const check of IMPORT_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(IMPORT_CHECKS.map((check) => check.name)).size).toBe(IMPORT_CHECKS.length);
    for (const check of IMPORT_CHECKS) expect(check.expression).toContain('IS TRUE');
    const text = IMPORT_CHECKS.map((check) => check.expression).join('\n');
    expect(text).toContain("`mode` IN ('dry_run', 'commit_all', 'commit_valid')");
    expect(text).toContain('`idempotency_key` IS NOT NULL');
    expect(text).toContain('`entity_id` IS NOT NULL');
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, unique indexes, the composite foreign keys and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...IMPORT_ORM_ENTITIES],
      synchronize: false,
    });
    const runner = dataSource.driver.createQueryRunner('master') as QueryRunner & {
      getCurrentDatabase(): Promise<string>;
    };
    const statements: string[] = [];
    runner.query = (async (sql: string) => {
      statements.push(sql);
      return [];
    }) as typeof runner.query;
    runner.getCurrentDatabase = async () => 'synthetic';
    await migration.up(runner);
    const ddl = statements.filter((sql) => sql.startsWith('CREATE TABLE'));
    expect(ddl).toHaveLength(3);
    const jobs = ddl.find((sql) => sql.includes(`CREATE TABLE \`${IMPORT_TABLES.jobs}\``)) ?? '';
    expect(jobs).toContain('PRIMARY KEY (`company_id`, `id`)');
    expect(jobs).toContain('`idempotency_key` varchar(64) COLLATE "utf8mb4_0900_bin" NULL');
    expect(jobs).toContain('UNIQUE INDEX `ux_import_jobs_key` (`company_id`, `idempotency_key`)');
    const rows = ddl.find((sql) => sql.includes(`CREATE TABLE \`${IMPORT_TABLES.rows}\``)) ?? '';
    expect(rows).toContain('PRIMARY KEY (`company_id`, `job_id`, `row_number`)');
    expect(rows).toContain(
      'CONSTRAINT `fk_import_rows_job` FOREIGN KEY (`company_id`, `job_id`) REFERENCES `opslog_import_jobs` (`company_id`, `id`)',
    );
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    expect(statements.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(
      IMPORT_CHECKS.length,
    );
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_imports',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createImportsDataSource({ ...base, username: 'opslog_imports_runtime' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: IMPORTS_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createImportsDataSource({
      ...base,
      username: 'opslog_imports_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_assignments_x', 'opslog_imports_', ''])
      expect(() => createImportsDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(IMPORTS_RUNTIME_ACCOUNT.test('opslog_imports_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(IMPORT_ORM_ENTITIES.length);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createImportsMigrationDataSource({ ...base, username: 'schema_owner' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: IMPORTS_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateImportJobs2026100600090]);
    const custom = createImportsMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runImportsMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runImportsMigrations({
          options: { type: 'mysql', ...options },
          runMigrations,
        } as unknown as DataSource),
      ).rejects.toThrow(/forbidden/);
    expect(runMigrations).toHaveBeenCalledTimes(1);
  });
});

describe('public entry point and entity schemas', () => {
  it('re-exports the store, factories, errors and schema', async () => {
    const api = await import('./index.js');
    expect(Object.keys(api).sort()).toEqual(
      expect.arrayContaining([
        'TypeOrmImportStore',
        'ImportStoreError',
        'createImportsDataSource',
        'createImportsMigrationDataSource',
        'runImportsMigrations',
        'CreateImportJobs2026100600090',
        'IMPORT_ORM_ENTITIES',
        'IMPORT_TABLES',
      ]),
    );
  });
  it('exports one schema per table with a class target', () => {
    expect(IMPORT_ORM_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(IMPORT_TABLES),
    );
    expect(ImportJobEntity.name).toBe('ImportJobEntity');
  });
});
