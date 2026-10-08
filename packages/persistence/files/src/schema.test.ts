import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { FileError } from '../../../domain/files/src/index.js';
import { DataSource } from 'typeorm';
import {
  createFilesDataSource,
  createFilesMigrationDataSource,
  FILES_MIGRATOR_ACCOUNT,
  FILES_RUNTIME_ACCOUNT,
  FILES_TENANT_DATABASE,
  runFilesMigrations,
} from './data-source.js';
import { FILE_TABLES, FILE_ENTITIES, FileRecordSchema, FileSagaSchema } from './entities.js';
import { FILES_MIGRATION_VERSION } from './migrations.js';
import { TypeOrmFileSagaStore } from './store.js';

describe('tenant-scoped files persistence schema', () => {
  it('pins tables and migration to the tenant-local files schema', () => {
    expect(FILES_MIGRATION_VERSION).toBe('2026100700010');
    expect(FILE_TABLES).toEqual({
      records: 'opslog_files',
      history: 'opslog_file_history',
      saga: 'opslog_file_saga',
    });
    expect(FILE_ENTITIES).toHaveLength(3);
    expect(FileRecordSchema.options.indices?.[0]?.columns).toEqual([
      'tenantId',
      'status',
      'createdAt',
    ]);
    expect(FileSagaSchema.options.columns.stage?.enum).toEqual([
      'upload',
      'scan',
      'cleanup_quarantine',
      'cleanup_released',
    ]);
    expect(FILES_TENANT_DATABASE.test('opslog_t_opaque123')).toBe(true);
    expect(FILES_TENANT_DATABASE.test('opslog_shared')).toBe(false);
    expect(FILES_RUNTIME_ACCOUNT.test('opslog_files_runtime_1')).toBe(true);
    expect(FILES_MIGRATOR_ACCOUNT.test('opslog_files_migrator_1')).toBe(true);
  });

  it('requires tenant database and restricted runtime account configuration', async () => {
    expect(() =>
      createFilesDataSource({
        host: '127.0.0.1',
        port: 3306,
        database: 'opslog_shared',
        username: 'opslog_files_runtime_1',
        password: 'synthetic',
      }),
    ).toThrow(/tenant-exclusive/);
    expect(() =>
      createFilesDataSource({
        host: '127.0.0.1',
        port: 3306,
        database: 'opslog_t_opaque123',
        username: 'root',
        password: 'synthetic',
      }),
    ).toThrow(/tenant-scoped/);
    expect(() =>
      createFilesMigrationDataSource({
        host: '127.0.0.1',
        port: 3306,
        database: 'opslog_t_opaque123',
        username: 'opslog_files_runtime_1',
        password: 'synthetic',
      }),
    ).toThrow(/schema-owner/);
    const migrationSource = createFilesMigrationDataSource({
      host: '127.0.0.1',
      port: 3306,
      database: 'opslog_t_opaque123',
      username: 'opslog_files_migrator_1',
      password: 'synthetic',
    });
    expect(migrationSource.options.migrationsRun).toBe(false);
    expect(migrationSource.options.synchronize).toBe(false);
    const runtimeSource = createFilesDataSource({
      host: '127.0.0.1',
      port: 3306,
      database: 'opslog_t_opaque123',
      username: 'opslog_files_runtime_1',
      password: 'synthetic',
    });
    await expect(runFilesMigrations(runtimeSource)).rejects.toThrow(/schema-owner/);
  });

  it('binds store access to its resolved tenant context', async () => {
    const source = new DataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'opslog_t_opaque123',
      username: 'opslog_files_runtime_1',
      password: 'synthetic',
      entities: [...FILE_ENTITIES],
      synchronize: false,
    });
    const store = new TypeOrmFileSagaStore(source, 'tenant-a');
    await expect(store.get('tenant-b', 'file-1')).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<FileError>);
    expect(() => new TypeOrmFileSagaStore(source, 'bad/tenant')).toThrow(FileError);
    expect(source.options.synchronize).toBe(false);
  });
});
