import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import {
  ASSIGNMENT_ENTITIES,
  ASSIGNMENT_TABLES,
  AssignmentEntity,
  BINARY_COLLATION,
} from './entities.js';
import {
  ASSIGNMENT_CHECKS,
  ASSIGNMENTS_MIGRATIONS_TABLE,
  ASSIGNMENTS_MIGRATION_VERSION,
  CreateVehicleAssignments2026100600080,
} from './migrations.js';
import {
  ASSIGNMENTS_RUNTIME_ACCOUNT,
  createAssignmentsDataSource,
  createAssignmentsMigrationDataSource,
  runAssignmentsMigrations,
} from './data-source.js';

const migration = new CreateVehicleAssignments2026100600080();

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
    entities: [...ASSIGNMENT_ENTITIES],
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
      ASSIGNMENT_TABLES.assignments,
      ASSIGNMENT_TABLES.events,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateVehicleAssignments2026100600080');
    expect(migration.name.endsWith(ASSIGNMENTS_MIGRATION_VERSION)).toBe(true);
    expect(ASSIGNMENTS_MIGRATION_VERSION).toMatch(/^\d{13}$/);
    // The next id after the insurance migration (2026100600070).
    expect(Number(ASSIGNMENTS_MIGRATION_VERSION)).toBeGreaterThan(2026100600070);
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

  it('keys every table by company and declares the three unique keys of BR-002 / BR-003', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    const assignments = tables.find((table) => table.name === ASSIGNMENT_TABLES.assignments);
    const events = tables.find((table) => table.name === ASSIGNMENT_TABLES.events);
    const keyOf = (table: Table | undefined) =>
      table?.columns.filter((column) => column.isPrimary).map((c) => c.name);
    expect(keyOf(assignments)).toEqual(['company_id', 'id']);
    expect(keyOf(events)).toEqual(['company_id', 'assignment_id', 'seq']);
    for (const table of tables) {
      for (const unique of table.uniques) expect(unique.columnNames[0]).toBe('company_id');
      for (const index of table.indices) expect(index.columnNames[0]).toBe('company_id');
    }
    expect(
      assignments?.indices.filter((index) => index.isUnique).map((i) => [i.name, i.columnNames]),
    ).toEqual([
      ['ux_assignments_current_pair', ['company_id', 'vehicle_id', 'employee_id', 'current_flag']],
      ['ux_assignments_principal_vehicle', ['company_id', 'vehicle_id', 'principal_flag']],
      ['ux_assignments_principal_employee', ['company_id', 'employee_id', 'principal_flag']],
    ]);
    // The flags are nullable so that ended rows never collide.
    for (const name of ['current_flag', 'principal_flag'])
      expect(assignments?.columns.find((c) => c.name === name)?.isNullable).toBe(true);
    expect(
      events?.foreignKeys.map((fk) => [
        fk.columnNames,
        fk.referencedTableName,
        fk.referencedColumnNames,
      ]),
    ).toEqual([
      [['company_id', 'assignment_id'], ASSIGNMENT_TABLES.assignments, ['company_id', 'id']],
    ]);
    expect(assignments?.foreignKeys).toEqual([]);
  });

  it('adds NULL-safe CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(ASSIGNMENT_CHECKS.length);
    for (const check of ASSIGNMENT_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(ASSIGNMENT_CHECKS.map((check) => check.name)).size).toBe(
      ASSIGNMENT_CHECKS.length,
    );
    const text = ASSIGNMENT_CHECKS.map((check) => check.expression).join('\n');
    expect(text).toContain("`type` IN ('principal', 'secondary', 'temporary')");
    expect(text).toContain('`current_flag` = 1');
    expect(text).toContain('`principal_flag` = 1');
    expect(text).toContain('`ended_at` >= `started_at`');
    expect(text.match(/IS TRUE/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, unique indexes, the composite foreign key and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...ASSIGNMENT_ENTITIES],
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
    const assignments =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${ASSIGNMENT_TABLES.assignments}\``)) ?? '';
    expect(assignments).toContain('PRIMARY KEY (`company_id`, `id`)');
    expect(assignments).toContain('`vehicle_id` varchar(64) COLLATE "utf8mb4_0900_bin" NOT NULL');
    expect(assignments).toContain('`current_flag` tinyint UNSIGNED NULL');
    expect(assignments).toContain(
      'UNIQUE INDEX `ux_assignments_principal_vehicle` (`company_id`, `vehicle_id`, `principal_flag`)',
    );
    expect(assignments).toContain('`version` int UNSIGNED NOT NULL');
    const events =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${ASSIGNMENT_TABLES.events}\``)) ?? '';
    expect(events).toContain('PRIMARY KEY (`company_id`, `assignment_id`, `seq`)');
    expect(events).toContain(
      'CONSTRAINT `fk_assignment_events_assignment` FOREIGN KEY (`company_id`, `assignment_id`) REFERENCES `opslog_vehicle_assignments` (`company_id`, `id`)',
    );
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    expect(statements.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(
      ASSIGNMENT_CHECKS.length,
    );
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_assignments',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createAssignmentsDataSource({
      ...base,
      username: 'opslog_assignments_runtime',
    });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: ASSIGNMENTS_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createAssignmentsDataSource({
      ...base,
      username: 'opslog_assignments_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_insurance_x', 'opslog_assignments_', ''])
      expect(() => createAssignmentsDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(ASSIGNMENTS_RUNTIME_ACCOUNT.test('opslog_assignments_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(ASSIGNMENT_ENTITIES.length);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createAssignmentsMigrationDataSource({
      ...base,
      username: 'schema_owner',
    });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: ASSIGNMENTS_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateVehicleAssignments2026100600080]);
    const custom = createAssignmentsMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runAssignmentsMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runAssignmentsMigrations({
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
        'TypeOrmAssignmentStore',
        'AssignmentStoreError',
        'createAssignmentsDataSource',
        'createAssignmentsMigrationDataSource',
        'runAssignmentsMigrations',
        'CreateVehicleAssignments2026100600080',
        'ASSIGNMENT_ENTITIES',
        'ASSIGNMENT_TABLES',
      ]),
    );
  });
  it('exports one schema per table with a class target', () => {
    expect(ASSIGNMENT_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(ASSIGNMENT_TABLES),
    );
    expect(AssignmentEntity.name).toBe('AssignmentEntity');
  });
});
