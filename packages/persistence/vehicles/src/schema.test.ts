import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import { BINARY_COLLATION, VEHICLE_ENTITIES, VEHICLE_TABLES, VehicleEntity } from './entities.js';
import {
  CreateVehicles2026100600030,
  VEHICLES_MIGRATIONS_TABLE,
  VEHICLES_MIGRATION_VERSION,
  VEHICLE_CHECKS,
} from './migrations.js';
import {
  VEHICLES_RUNTIME_ACCOUNT,
  createVehiclesDataSource,
  createVehiclesMigrationDataSource,
  runVehiclesMigrations,
} from './data-source.js';

const migration = new CreateVehicles2026100600030();

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
    entities: [...VEHICLE_ENTITIES],
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
      VEHICLE_TABLES.vehicles,
      VEHICLE_TABLES.statusHistory,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateVehicles2026100600030');
    expect(migration.name.endsWith(VEHICLES_MIGRATION_VERSION)).toBe(true);
    expect(VEHICLES_MIGRATION_VERSION).toMatch(/^\d{13}$/);
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
    const vehicles = tables.find((table) => table.name === VEHICLE_TABLES.vehicles);
    expect(vehicles?.uniques.map((unique) => unique.columnNames)).toEqual([
      ['company_id', 'economic_number_key'],
      ['company_id', 'plate_key'],
      ['company_id', 'vin'],
    ]);
    const history = tables.find((table) => table.name === VEHICLE_TABLES.statusHistory);
    expect(
      history?.foreignKeys.map((fk) => [
        fk.columnNames,
        fk.referencedTableName,
        fk.referencedColumnNames,
      ]),
    ).toEqual([[['company_id', 'vehicle_id'], VEHICLE_TABLES.vehicles, ['company_id', 'id']]]);
    expect(vehicles?.foreignKeys).toEqual([]);
  });

  it('adds CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(VEHICLE_CHECKS.length);
    for (const check of VEHICLE_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(VEHICLE_CHECKS.map((check) => check.name)).size).toBe(VEHICLE_CHECKS.length);
    const text = VEHICLE_CHECKS.map((check) => check.expression).join('\n');
    expect(text).toContain(
      "'active','restricted','in_maintenance','out_of_service','inactive','decommissioned'",
    );
    expect(text).toContain('`odometer_km` <= 9999999');
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, named unique indexes, the composite foreign key and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...VEHICLE_ENTITIES],
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
    const vehicles =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${VEHICLE_TABLES.vehicles}\``)) ?? '';
    expect(vehicles).toContain('PRIMARY KEY (`company_id`, `id`)');
    expect(vehicles).toContain('`plate_key` varchar(16) COLLATE "utf8mb4_0900_bin" NOT NULL');
    expect(vehicles).toContain('`vin` char(17) COLLATE "utf8mb4_0900_bin" NULL');
    expect(vehicles).toContain('UNIQUE INDEX `uq_vehicles_plate` (`company_id`, `plate_key`)');
    expect(vehicles).toContain('UNIQUE INDEX `uq_vehicles_vin` (`company_id`, `vin`)');
    expect(vehicles).toContain('`odometer_km` int UNSIGNED NOT NULL');
    const history =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${VEHICLE_TABLES.statusHistory}\``)) ?? '';
    expect(history).toContain(
      'CONSTRAINT `fk_vehicle_status_history_vehicle` FOREIGN KEY (`company_id`, `vehicle_id`) REFERENCES `opslog_vehicles` (`company_id`, `id`)',
    );
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    expect(statements.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(
      VEHICLE_CHECKS.length,
    );
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_vehicles',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createVehiclesDataSource({ ...base, username: 'opslog_vehicles_runtime' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: VEHICLES_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createVehiclesDataSource({
      ...base,
      username: 'opslog_vehicles_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_identity_x', 'opslog_vehicles_', ''])
      expect(() => createVehiclesDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(VEHICLES_RUNTIME_ACCOUNT.test('opslog_vehicles_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(VEHICLE_ENTITIES.length + 2);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createVehiclesMigrationDataSource({ ...base, username: 'schema_owner' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: VEHICLES_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateVehicles2026100600030]);
    const custom = createVehiclesMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runVehiclesMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runVehiclesMigrations({
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
        'TypeOrmVehicleStore',
        'VehicleStoreError',
        'createVehiclesDataSource',
        'createVehiclesMigrationDataSource',
        'runVehiclesMigrations',
        'CreateVehicles2026100600030',
        'VEHICLE_ENTITIES',
        'VEHICLE_TABLES',
      ]),
    );
  });
  it('exports one schema per table with a class target', () => {
    expect(VEHICLE_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(VEHICLE_TABLES),
    );
    expect(VehicleEntity.name).toBe('VehicleEntity');
  });
});
