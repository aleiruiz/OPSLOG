import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { DataSource, type EntityMetadata, type QueryRunner, type Table } from 'typeorm';
import {
  BINARY_COLLATION,
  DOCUMENT_ENTITIES,
  DOCUMENT_TABLES,
  DocumentEntity,
} from './entities.js';
import {
  CreateDocuments2026100600060,
  DOCUMENTS_MIGRATIONS_TABLE,
  DOCUMENTS_MIGRATION_VERSION,
  DOCUMENT_CHECKS,
} from './migrations.js';
import {
  DOCUMENTS_RUNTIME_ACCOUNT,
  createDocumentsDataSource,
  createDocumentsMigrationDataSource,
  runDocumentsMigrations,
} from './data-source.js';

const migration = new CreateDocuments2026100600060();

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
    entities: [...DOCUMENT_ENTITIES],
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
      DOCUMENT_TABLES.documents,
      DOCUMENT_TABLES.revisions,
    ]);
    await migration.down(runner);
    expect(dropped).toEqual([...tables.map((table) => table.name)].reverse());
    expect(migration.name).toBe('CreateDocuments2026100600060');
    expect(migration.name.endsWith(DOCUMENTS_MIGRATION_VERSION)).toBe(true);
    expect(DOCUMENTS_MIGRATION_VERSION).toMatch(/^\d{13}$/);
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
    const documents = tables.find((table) => table.name === DOCUMENT_TABLES.documents);
    const revisions = tables.find((table) => table.name === DOCUMENT_TABLES.revisions);
    const keyOf = (table: Table | undefined) =>
      table?.columns.filter((column) => column.isPrimary).map((c) => c.name);
    expect(keyOf(documents)).toEqual(['company_id', 'id']);
    expect(keyOf(revisions)).toEqual(['company_id', 'document_id', 'revision']);
    for (const table of tables) {
      for (const unique of table.uniques) expect(unique.columnNames[0]).toBe('company_id');
      for (const index of table.indices) expect(index.columnNames[0]).toBe('company_id');
    }
    expect(documents?.indices.map((index) => index.columnNames)).toEqual([
      ['company_id', 'vehicle_id'],
      ['company_id', 'employee_id'],
      ['company_id', 'type_code'],
      ['company_id', 'expiry_key', 'id'],
    ]);
    expect(
      revisions?.foreignKeys.map((fk) => [
        fk.columnNames,
        fk.referencedTableName,
        fk.referencedColumnNames,
      ]),
    ).toEqual([[['company_id', 'document_id'], DOCUMENT_TABLES.documents, ['company_id', 'id']]]);
    expect(documents?.foreignKeys).toEqual([]);
  });

  it('adds CHECK constraints as raw DDL after the tables exist', async () => {
    const { runner, statements } = recordingRunner();
    await migration.up(runner);
    expect(statements).toHaveLength(DOCUMENT_CHECKS.length);
    for (const check of DOCUMENT_CHECKS)
      expect(statements).toContain(
        `ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression})`,
      );
    expect(new Set(DOCUMENT_CHECKS.map((check) => check.name)).size).toBe(DOCUMENT_CHECKS.length);
    const text = DOCUMENT_CHECKS.map((check) => check.expression).join('\n');
    expect(text).toContain("`owner_type` = 'vehicle' AND `vehicle_id` IS NOT NULL");
    expect(text).toContain("`owner_type` = 'employee' AND `employee_id` IS NOT NULL");
    expect(text).toContain("`expiry_key` = COALESCE(`expires_on`, '9999-12-31')");
    expect(text).toContain('`revision` <= `version`');
    expect(text).toContain('`expires_on` >= `issued_on`');
  });
});

describe('DDL generated by the real MySQL query runner', () => {
  it('emits binary collations, named unique indexes, the composite foreign key and InnoDB', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      database: 'synthetic',
      entities: [...DOCUMENT_ENTITIES],
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
    const documents =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${DOCUMENT_TABLES.documents}\``)) ?? '';
    expect(documents).toContain('PRIMARY KEY (`company_id`, `id`)');
    expect(documents).toContain('`expiry_key` char(10) COLLATE "utf8mb4_0900_bin" NOT NULL');
    expect(documents).toContain('`vehicle_id` varchar(64) COLLATE "utf8mb4_0900_bin" NULL');
    expect(documents).toContain('INDEX `ix_documents_listing` (`company_id`, `expiry_key`, `id`)');
    expect(documents).toContain('`version` int UNSIGNED NOT NULL');
    const revisions =
      ddl.find((sql) => sql.includes(`CREATE TABLE \`${DOCUMENT_TABLES.revisions}\``)) ?? '';
    expect(revisions).toContain('PRIMARY KEY (`company_id`, `document_id`, `revision`)');
    expect(revisions).toContain(
      'CONSTRAINT `fk_document_revisions_document` FOREIGN KEY (`company_id`, `document_id`) REFERENCES `opslog_documents` (`company_id`, `id`)',
    );
    for (const sql of ddl) {
      expect(sql).toContain('ENGINE=InnoDB');
      expect(sql).not.toMatch(/ON DELETE|ON UPDATE|CASCADE/);
    }
    expect(statements.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(
      DOCUMENT_CHECKS.length,
    );
  });
});

describe('DataSource factories', () => {
  const base = {
    host: '127.0.0.1',
    port: 3306,
    database: 'opslog_documents',
    password: 'synthetic',
  };

  it('creates a pooled runtime DataSource for a restricted account only', () => {
    const dataSource = createDocumentsDataSource({ ...base, username: 'opslog_documents_runtime' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      timezone: 'Z',
      charset: 'utf8mb4',
      migrationsTableName: DOCUMENTS_MIGRATIONS_TABLE,
      migrationsTransactionMode: 'all',
      connectTimeout: 10_000,
      extra: { connectionLimit: 10, waitForConnections: true, queueLimit: 100 },
    });
    const tuned = createDocumentsDataSource({
      ...base,
      username: 'opslog_documents_runtime',
      connectionLimit: 3,
      queueLimit: 7,
      connectTimeoutMs: 500,
    });
    expect(tuned.options).toMatchObject({
      connectTimeout: 500,
      extra: { connectionLimit: 3, queueLimit: 7 },
    });
    for (const username of ['root', 'admin', 'opslog_identity_x', 'opslog_documents_', ''])
      expect(() => createDocumentsDataSource({ ...base, username })).toThrow(
        /restricted runtime account/,
      );
    expect(DOCUMENTS_RUNTIME_ACCOUNT.test('opslog_documents_abc123')).toBe(true);
    expect(dataSource.options.entities).toHaveLength(DOCUMENT_ENTITIES.length);
  });

  it('creates a migration DataSource that is never used at runtime', () => {
    const dataSource = createDocumentsMigrationDataSource({ ...base, username: 'schema_owner' });
    expect(dataSource.options).toMatchObject({
      type: 'mysql',
      synchronize: false,
      migrationsRun: false,
      logging: false,
      migrationsTableName: DOCUMENTS_MIGRATIONS_TABLE,
    });
    expect(dataSource.options.migrations).toEqual([CreateDocuments2026100600060]);
    const custom = createDocumentsMigrationDataSource({
      ...base,
      username: 'schema_owner',
      connectTimeoutMs: 42,
    });
    expect(custom.options).toMatchObject({ connectTimeout: 42 });
  });

  it('runs migrations in one transaction and refuses unsafe options', async () => {
    const runMigrations = vi.fn(async () => []);
    await runDocumentsMigrations({
      options: { type: 'mysql', synchronize: false, migrationsRun: false },
      runMigrations,
    } as unknown as DataSource);
    expect(runMigrations).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    for (const options of [{ synchronize: true }, { migrationsRun: true }])
      await expect(
        runDocumentsMigrations({
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
        'TypeOrmDocumentStore',
        'DocumentStoreError',
        'createDocumentsDataSource',
        'createDocumentsMigrationDataSource',
        'runDocumentsMigrations',
        'CreateDocuments2026100600060',
        'DOCUMENT_ENTITIES',
        'DOCUMENT_TABLES',
      ]),
    );
  });
  it('exports one schema per table with a class target', () => {
    expect(DOCUMENT_ENTITIES.map((schema) => schema.options.tableName)).toEqual(
      Object.values(DOCUMENT_TABLES),
    );
    expect(DocumentEntity.name).toBe('DocumentEntity');
  });
});
