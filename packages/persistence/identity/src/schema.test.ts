import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import {
  IDENTITY_ENTITIES,
  IDENTITY_TABLES,
  BINARY_COLLATION,
  ExternalIdentityEntity,
} from './entities.js';
import {
  CreateIdentityStore2026100600010,
  IDENTITY_CHECKS,
  IDENTITY_MIGRATIONS_TABLE,
  IDENTITY_MIGRATION_VERSION,
} from './migrations.js';
import {
  IDENTITY_RUNTIME_ACCOUNT,
  createIdentityDataSource,
  createIdentityMigrationDataSource,
  runIdentityMigrations,
} from './data-source.js';

const migration = new CreateIdentityStore2026100600010();

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
    entities: [...IDENTITY_ENTITIES],
    synchronize: false,
  });
  await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  return dataSource.entityMetadatas;
}

describe('migration and entity metadata agree', () => {
  it('creates exactly the entity tables, in dependency order, and drops them in reverse', async () => {
    const { runner, tables, dropped } = recordingRunner();
    await migration.up(runner);
    expect(tables.map((table) => table.name)).toEqual([
      IDENTITY_TABLES.identities,
      IDENTITY_TABLES.external,
      IDENTITY_TABLES.memberships,
      IDENTITY_TABLES.invitations,
      IDENTITY_TABLES.recoveries,
      IDENTITY_TABLES.sessions,
      IDENTITY_TABLES.tenantLocks,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateIdentityStore2026100600010');
    expect(migration.name.endsWith(IDENTITY_MIGRATION_VERSION)).toBe(true);
    expect(IDENTITY_MIGRATION_VERSION).toMatch(/^\d{13}$/);
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
        // Every key-like text column is binary NO PAD so subjects and tenants stay case sensitive.
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
      // MySQL has no unique constraints apart from unique indexes, so TypeORM models both as indices.
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

  it('keys everything by tenant: invitations and sessions reference the membership key', async () => {
    const { runner, tables } = recordingRunner();
    await migration.up(runner);
    const keys = (name: string) =>
      tables
        .find((table) => table.name === name)
        ?.foreignKeys.map((fk) => [
          fk.columnNames,
          fk.referencedTableName,
          fk.referencedColumnNames,
        ]);
    const member = [
      ['tenant_id', 'identity_id'],
      IDENTITY_TABLES.memberships,
      ['tenant_id', 'identity_id'],
    ];
    expect(keys(IDENTITY_TABLES.invitations)).toEqual([member]);
    expect(keys(IDENTITY_TABLES.sessions)).toEqual([member]);
    expect(keys(IDENTITY_TABLES.memberships)).toEqual([
      [['identity_id'], IDENTITY_TABLES.identities, ['id']],
    ]);
    expect(keys(IDENTITY_TABLES.external)).toEqual([
      [['identity_id'], IDENTITY_TABLES.identities, ['id']],
    ]);
    expect(keys(IDENTITY_TABLES.recoveries)).toEqual([
      [['identity_id'], IDENTITY_TABLES.identities, ['id']],
    ]);
    const membership = tables.find((table) => table.name === IDENTITY_TABLES.memberships);
    expect(membership?.columns.filter((column) => column.isPrimary).map((c) => c.name)).toEqual([
      'tenant_id',
      'identity_id',
    ]);
    const external = tables.find((table) => table.name === IDENTITY_TABLES.external);
    expect(external?.uniques.map((unique) => unique.columnNames)).toEqual([
      ['provider', 'subject'],
      ['identity_id'],
    ]);
  });

  it('adds CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(IDENTITY_CHECKS.length);
    for (const check of IDENTITY_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(IDENTITY_CHECKS.map((check) => check.name)).size).toBe(IDENTITY_CHECKS.length);
    const text = IDENTITY_CHECKS.map((check) => check.expression).join('\n');
    expect(text).toContain("`role` REGEXP '^[a-z][a-z0-9_]{0,31}$'");
    expect(text).toContain("`status` <> 'active' OR `activated_at` IS NOT NULL");
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, named unique indexes, composite foreign keys and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...IDENTITY_ENTITIES],
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
    expect(ddl).toHaveLength(7);
    const table = (name: string) =>
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${name}\``)) ?? '';
    const external = table(IDENTITY_TABLES.external);
    expect(external).toContain('`subject` varchar(200) COLLATE "utf8mb4_0900_bin" NOT NULL');
    expect(external).toContain(
      'UNIQUE INDEX `uq_identity_external_subject` (`provider`, `subject`)',
    );
    expect(external).toContain('UNIQUE INDEX `uq_identity_external_identity` (`identity_id`)');
    expect(external).toContain(
      'CONSTRAINT `fk_identity_external_identity` FOREIGN KEY (`identity_id`) REFERENCES `opslog_identity_identities` (`id`)',
    );
    const memberships = table(IDENTITY_TABLES.memberships);
    expect(memberships).toContain('PRIMARY KEY (`tenant_id`, `identity_id`)');
    expect(memberships).toContain(
      'INDEX `ix_identity_memberships_role` (`tenant_id`, `role`, `status`)',
    );
    const sessions = table(IDENTITY_TABLES.sessions);
    expect(sessions).toContain(
      'CONSTRAINT `fk_identity_sessions_member` FOREIGN KEY (`tenant_id`, `identity_id`) REFERENCES `opslog_identity_memberships` (`tenant_id`, `identity_id`)',
    );
    expect(sessions).toContain('`authorization_version` int UNSIGNED NOT NULL');
    expect(sessions).toContain('`revoked_at` datetime(6) NULL');
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    const checks = statements.filter((sql) => sql.startsWith('ALTER TABLE'));
    expect(checks).toHaveLength(IDENTITY_CHECKS.length);
    expect(checks.every((sql) => sql.includes(' CHECK ('))).toBe(true);
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_identity',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createIdentityDataSource({ ...base, username: 'opslog_identity_runtime' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: IDENTITY_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createIdentityDataSource({
      ...base,
      username: 'opslog_control_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_other_x', 'opslog_identity_', ''])
      expect(() => createIdentityDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(IDENTITY_RUNTIME_ACCOUNT.test('opslog_identity_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(IDENTITY_ENTITIES.length);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createIdentityMigrationDataSource({ ...base, username: 'schema_owner' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: IDENTITY_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateIdentityStore2026100600010]);
    const custom = createIdentityMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runIdentityMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runIdentityMigrations({
          options: { type: 'mysql', ...options },
          runMigrations,
        } as unknown as DataSource),
      ).rejects.toThrow(/forbidden/);
    expect(runMigrations).toHaveBeenCalledTimes(1);
  });
});

describe('public entry point', () => {
  it('re-exports the store, factories, errors and schema', async () => {
    const api = await import('./index.js');
    expect(Object.keys(api).sort()).toEqual(
      expect.arrayContaining([
        'TypeOrmIdentityStore',
        'LastAdministratorError',
        'IdentityStoreError',
        'createIdentityDataSource',
        'createIdentityMigrationDataSource',
        'runIdentityMigrations',
        'CreateIdentityStore2026100600010',
        'IDENTITY_ENTITIES',
        'ADMIN_ROLE',
      ]),
    );
  });
});

describe('entity schemas', () => {
  it('exports one schema per table with a class target', () => {
    expect(IDENTITY_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(IDENTITY_TABLES),
    );
    expect(ExternalIdentityEntity.name).toBe('ExternalIdentityEntity');
  });
});
