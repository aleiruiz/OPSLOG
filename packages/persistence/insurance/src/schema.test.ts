import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import { BINARY_COLLATION, POLICY_ENTITIES, POLICY_TABLES, PolicyEntity } from './entities.js';
import {
  CreateInsurancePolicies2026100600070,
  INSURANCE_MIGRATIONS_TABLE,
  INSURANCE_MIGRATION_VERSION,
  POLICY_CHECKS,
} from './migrations.js';
import {
  INSURANCE_RUNTIME_ACCOUNT,
  createInsuranceDataSource,
  createInsuranceMigrationDataSource,
  runInsuranceMigrations,
} from './data-source.js';

const migration = new CreateInsurancePolicies2026100600070();

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
    entities: [...POLICY_ENTITIES],
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
      POLICY_TABLES.policies,
      POLICY_TABLES.revisions,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateInsurancePolicies2026100600070');
    expect(migration.name.endsWith(INSURANCE_MIGRATION_VERSION)).toBe(true);
    expect(INSURANCE_MIGRATION_VERSION).toMatch(/^\d{13}$/);
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

  it('keys every table by company: primary keys, indexes and the revision foreign key', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    const policies = tables.find((table) => table.name === POLICY_TABLES.policies);
    const revisions = tables.find((table) => table.name === POLICY_TABLES.revisions);
    const keyOf = (table: Table | undefined) =>
      table?.columns.filter((column) => column.isPrimary).map((c) => c.name);
    expect(keyOf(policies)).toEqual(['company_id', 'id']);
    expect(keyOf(revisions)).toEqual(['company_id', 'policy_id', 'revision']);
    for (const table of tables) {
      for (const unique of table.uniques) expect(unique.columnNames[0]).toBe('company_id');
      for (const index of table.indices) expect(index.columnNames[0]).toBe('company_id');
    }
    expect(policies?.indices.map((index) => index.columnNames)).toEqual([
      ['company_id', 'vehicle_id'],
      ['company_id', 'coverage_type'],
      ['company_id', 'ends_on', 'id'],
    ]);
    expect(
      revisions?.foreignKeys.map((fk) => [
        fk.columnNames,
        fk.referencedTableName,
        fk.referencedColumnNames,
      ]),
    ).toEqual([[['company_id', 'policy_id'], POLICY_TABLES.policies, ['company_id', 'id']]]);
    expect(policies?.foreignKeys).toEqual([]);
  });

  it('adds CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(POLICY_CHECKS.length);
    for (const check of POLICY_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(POLICY_CHECKS.map((check) => check.name)).size).toBe(POLICY_CHECKS.length);
    const text = POLICY_CHECKS.map((check) => check.expression).join('\n');
    expect(text).toContain(
      "`deductible_kind` = 'amount' AND `deductible_value` IS NOT NULL AND `deductible_value` BETWEEN 1 AND 1000000000000",
    );
    expect(text).toContain(
      "`deductible_kind` = 'percent' AND `deductible_value` IS NOT NULL AND `deductible_value` BETWEEN 1 AND 10000",
    );
    expect(text).toContain("`coverage_type` IN ('mandatory_liability'");
    expect(text).toContain('`revision` <= `version`');
    expect(text).toContain('`ends_on` >= `starts_on`');
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, named unique indexes, the composite foreign key and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...POLICY_ENTITIES],
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
    const policies =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${POLICY_TABLES.policies}\``)) ?? '';
    expect(policies).toContain('PRIMARY KEY (`company_id`, `id`)');
    expect(policies).toContain('`ends_on` char(10) COLLATE "utf8mb4_0900_bin" NOT NULL');
    expect(policies).toContain('`vehicle_id` varchar(64) COLLATE "utf8mb4_0900_bin" NOT NULL');
    expect(policies).toContain('`deductible_value` bigint UNSIGNED NULL');
    expect(policies).toContain('INDEX `ix_policies_listing` (`company_id`, `ends_on`, `id`)');
    expect(policies).toContain('`version` int UNSIGNED NOT NULL');
    const revisions =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${POLICY_TABLES.revisions}\``)) ?? '';
    expect(revisions).toContain('PRIMARY KEY (`company_id`, `policy_id`, `revision`)');
    expect(revisions).toContain(
      'CONSTRAINT `fk_policy_revisions_policy` FOREIGN KEY (`company_id`, `policy_id`) REFERENCES `opslog_insurance_policies` (`company_id`, `id`)',
    );
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    expect(statements.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(
      POLICY_CHECKS.length,
    );
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_insurance',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createInsuranceDataSource({ ...base, username: 'opslog_insurance_runtime' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: INSURANCE_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createInsuranceDataSource({
      ...base,
      username: 'opslog_insurance_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_identity_x', 'opslog_insurance_', ''])
      expect(() => createInsuranceDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(INSURANCE_RUNTIME_ACCOUNT.test('opslog_insurance_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(POLICY_ENTITIES.length);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createInsuranceMigrationDataSource({ ...base, username: 'schema_owner' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: INSURANCE_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateInsurancePolicies2026100600070]);
    const custom = createInsuranceMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runInsuranceMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runInsuranceMigrations({
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
        'TypeOrmPolicyStore',
        'PolicyStoreError',
        'createInsuranceDataSource',
        'createInsuranceMigrationDataSource',
        'runInsuranceMigrations',
        'CreateInsurancePolicies2026100600070',
        'POLICY_ENTITIES',
        'POLICY_TABLES',
      ]),
    );
  });
  it('exports one schema per table with a class target', () => {
    expect(POLICY_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(POLICY_TABLES),
    );
    expect(PolicyEntity.name).toBe('PolicyEntity');
  });
});
