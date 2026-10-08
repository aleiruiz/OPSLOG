import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import { BINARY_COLLATION, AREA_ENTITIES, AREA_TABLES, AreaEntity } from './entities.js';
import {
  CreateAreas2026100600040,
  AREAS_MIGRATIONS_TABLE,
  AREAS_MIGRATION_VERSION,
  AREA_CHECKS,
} from './migrations.js';
import {
  AREAS_RUNTIME_ACCOUNT,
  createAreasDataSource,
  createAreasMigrationDataSource,
  runAreasMigrations,
} from './data-source.js';

const migration = new CreateAreas2026100600040();

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
    entities: [...AREA_ENTITIES],
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
      AREA_TABLES.areas,
      AREA_TABLES.responsibles,
      AREA_TABLES.history,
      AREA_TABLES.locks,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateAreas2026100600040');
    expect(migration.name.endsWith(AREAS_MIGRATION_VERSION)).toBe(true);
    expect(AREAS_MIGRATION_VERSION).toMatch(/^\d{13}$/);
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

  it('keys every table by company: primary keys, unique keys, indexes and composite foreign keys', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    const primary = (name: string) =>
      tables
        .find((table) => table.name === name)
        ?.columns.filter((column) => column.isPrimary)
        .map((column) => column.name);
    expect(primary(AREA_TABLES.areas)).toEqual(['company_id', 'id']);
    expect(primary(AREA_TABLES.history)).toEqual(['company_id', 'id']);
    expect(primary(AREA_TABLES.responsibles)).toEqual(['company_id', 'area_id', 'user_id']);
    expect(primary(AREA_TABLES.locks)).toEqual(['company_id']);
    for (const table of tables) {
      for (const unique of table.uniques) expect(unique.columnNames[0]).toBe('company_id');
      for (const index of table.indices) expect(index.columnNames[0]).toBe('company_id');
    }
    const areas = tables.find((table) => table.name === AREA_TABLES.areas);
    expect(areas?.uniques.map((unique) => unique.columnNames)).toEqual([
      ['company_id', 'parent_key', 'name_key'],
      ['company_id', 'code'],
    ]);
    const references = (name: string) =>
      tables
        .find((table) => table.name === name)
        ?.foreignKeys.map((fk) => [
          fk.columnNames,
          fk.referencedTableName,
          fk.referencedColumnNames,
        ]);
    expect(references(AREA_TABLES.areas)).toEqual([
      [['company_id', 'parent_id'], AREA_TABLES.areas, ['company_id', 'id']],
    ]);
    expect(references(AREA_TABLES.responsibles)).toEqual([
      [['company_id', 'area_id'], AREA_TABLES.areas, ['company_id', 'id']],
    ]);
    expect(references(AREA_TABLES.history)).toEqual([
      [['company_id', 'area_id'], AREA_TABLES.areas, ['company_id', 'id']],
    ]);
    expect(references(AREA_TABLES.locks)).toEqual([]);
  });

  it('adds CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(AREA_CHECKS.length);
    for (const check of AREA_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(AREA_CHECKS.map((check) => check.name)).size).toBe(AREA_CHECKS.length);
    const text = AREA_CHECKS.map((check) => check.expression).join('\n');
    // The database also bounds the tree: four levels, and a root is exactly level 1.
    expect(text).toContain('`depth` BETWEEN 1 AND 4');
    expect(text).toContain('`parent_id` IS NULL AND `depth` = 1');
    expect(text).toContain("'created','updated','activated','deactivated'");
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, named unique indexes, the composite foreign keys and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...AREA_ENTITIES],
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
    expect(ddl).toHaveLength(4);
    const areas = ddl.find((sql) => sql.includes(`CREATE TABLE \`${AREA_TABLES.areas}\``)) ?? '';
    expect(areas).toContain('PRIMARY KEY (`company_id`, `id`)');
    expect(areas).toContain('`name_key` varchar(160) COLLATE "utf8mb4_0900_bin" NOT NULL');
    expect(areas).toContain('`code` varchar(32) COLLATE "utf8mb4_0900_bin" NULL');
    expect(areas).toContain(
      'UNIQUE INDEX `uq_areas_sibling_name` (`company_id`, `parent_key`, `name_key`)',
    );
    expect(areas).toContain('UNIQUE INDEX `uq_areas_code` (`company_id`, `code`)');
    expect(areas).toContain(
      'CONSTRAINT `fk_areas_parent` FOREIGN KEY (`company_id`, `parent_id`) REFERENCES `opslog_areas` (`company_id`, `id`)',
    );
    const history =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${AREA_TABLES.history}\``)) ?? '';
    expect(history).toContain(
      'CONSTRAINT `fk_area_history_area` FOREIGN KEY (`company_id`, `area_id`) REFERENCES `opslog_areas` (`company_id`, `id`)',
    );
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    expect(statements.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(
      AREA_CHECKS.length,
    );
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_areas',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createAreasDataSource({ ...base, username: 'opslog_areas_runtime' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: AREAS_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createAreasDataSource({
      ...base,
      username: 'opslog_areas_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_identity_x', 'opslog_areas_', ''])
      expect(() => createAreasDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(AREAS_RUNTIME_ACCOUNT.test('opslog_areas_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(AREA_ENTITIES.length + 2);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createAreasMigrationDataSource({ ...base, username: 'schema_owner' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: AREAS_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateAreas2026100600040]);
    const custom = createAreasMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runAreasMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runAreasMigrations({
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
        'TypeOrmAreaStore',
        'AreaStoreError',
        'createAreasDataSource',
        'createAreasMigrationDataSource',
        'runAreasMigrations',
        'CreateAreas2026100600040',
        'AREA_ENTITIES',
        'AREA_TABLES',
      ]),
    );
  });
  it('exports one schema per table with a class target', () => {
    expect(AREA_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(AREA_TABLES),
    );
    expect(AreaEntity.name).toBe('AreaEntity');
  });
});
