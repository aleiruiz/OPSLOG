import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import {
  BINARY_COLLATION,
  EMPLOYEE_ENTITIES,
  EMPLOYEE_TABLES,
  EmployeeEntity,
} from './entities.js';
import {
  CreateEmployees2026100600050,
  EMPLOYEES_MIGRATIONS_TABLE,
  EMPLOYEES_MIGRATION_VERSION,
  EMPLOYEE_CHECKS,
} from './migrations.js';
import {
  EMPLOYEES_RUNTIME_ACCOUNT,
  createEmployeesDataSource,
  createEmployeesMigrationDataSource,
  runEmployeesMigrations,
} from './data-source.js';

const migration = new CreateEmployees2026100600050();

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
    entities: [...EMPLOYEE_ENTITIES],
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
      EMPLOYEE_TABLES.employees,
      EMPLOYEE_TABLES.history,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateEmployees2026100600050');
    expect(migration.name.endsWith(EMPLOYEES_MIGRATION_VERSION)).toBe(true);
    expect(EMPLOYEES_MIGRATION_VERSION).toMatch(/^\d{13}$/);
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

  it('keys every table by company: primary keys, unique keys and the history foreign key', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    for (const table of tables) {
      expect(table.columns.filter((column) => column.isPrimary).map((c) => c.name)).toEqual([
        'company_id',
        'id',
      ]);
      for (const unique of table.uniques) expect(unique.columnNames[0]).toBe('company_id');
      for (const index of table.indices) expect(index.columnNames[0]).toBe('company_id');
    }
    const employees = tables.find((table) => table.name === EMPLOYEE_TABLES.employees);
    expect(employees?.uniques.map((unique) => unique.columnNames)).toEqual([
      ['company_id', 'employee_number_key'],
      ['company_id', 'national_id_idx'],
      ['company_id', 'email_idx'],
    ]);
    const history = tables.find((table) => table.name === EMPLOYEE_TABLES.history);
    expect(
      history?.foreignKeys.map((fk) => [
        fk.columnNames,
        fk.referencedTableName,
        fk.referencedColumnNames,
      ]),
    ).toEqual([[['company_id', 'employee_id'], EMPLOYEE_TABLES.employees, ['company_id', 'id']]]);
    expect(employees?.foreignKeys).toEqual([]);
  });

  it('adds CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(EMPLOYEE_CHECKS.length);
    for (const check of EMPLOYEE_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(EMPLOYEE_CHECKS.map((check) => check.name)).size).toBe(EMPLOYEE_CHECKS.length);
    const text = EMPLOYEE_CHECKS.map((check) => check.expression).join('\n');
    expect(text).toContain("'active','inactive','suspended','terminated'");
    expect(text).toContain("`kind` IN ('driver','dispatcher','other')");
    expect(text).toContain("LIKE 'pii1.%'");
    expect(text).toContain("`kind` = 'driver' OR");
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, named unique indexes, the composite foreign key and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...EMPLOYEE_ENTITIES],
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
    expect(ddl).toHaveLength(2);
    const employees =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${EMPLOYEE_TABLES.employees}\``)) ?? '';
    expect(employees).toContain('PRIMARY KEY (`company_id`, `id`)');
    expect(employees).toContain('`national_id_enc` varchar(1024) COLLATE "utf8mb4_0900_bin" NULL');
    expect(employees).toContain('`national_id_idx` char(64) COLLATE "utf8mb4_0900_bin" NULL');
    expect(employees).toContain(
      'UNIQUE INDEX `uq_employees_national_id` (`company_id`, `national_id_idx`)',
    );
    expect(employees).toContain('UNIQUE INDEX `uq_employees_email` (`company_id`, `email_idx`)');
    expect(employees).toContain(
      'UNIQUE INDEX `uq_employees_number` (`company_id`, `employee_number_key`)',
    );
    expect(employees).toContain('`version` int UNSIGNED NOT NULL');
    const history =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${EMPLOYEE_TABLES.history}\``)) ?? '';
    expect(history).toContain(
      'CONSTRAINT `fk_employee_history_employee` FOREIGN KEY (`company_id`, `employee_id`) REFERENCES `opslog_employees` (`company_id`, `id`)',
    );
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    expect(statements.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(
      EMPLOYEE_CHECKS.length,
    );
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_employees',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createEmployeesDataSource({ ...base, username: 'opslog_employees_runtime' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: EMPLOYEES_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createEmployeesDataSource({
      ...base,
      username: 'opslog_employees_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_identity_x', 'opslog_employees_', ''])
      expect(() => createEmployeesDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(EMPLOYEES_RUNTIME_ACCOUNT.test('opslog_employees_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(EMPLOYEE_ENTITIES.length);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createEmployeesMigrationDataSource({ ...base, username: 'schema_owner' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: EMPLOYEES_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateEmployees2026100600050]);
    const custom = createEmployeesMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runEmployeesMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runEmployeesMigrations({
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
        'TypeOrmEmployeeStore',
        'EmployeeStoreError',
        'createEmployeesDataSource',
        'createEmployeesMigrationDataSource',
        'runEmployeesMigrations',
        'CreateEmployees2026100600050',
        'EMPLOYEE_ENTITIES',
        'EMPLOYEE_TABLES',
      ]),
    );
  });
  it('exports one schema per table with a class target', () => {
    expect(EMPLOYEE_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(EMPLOYEE_TABLES),
    );
    expect(EmployeeEntity.name).toBe('EmployeeEntity');
  });
});
